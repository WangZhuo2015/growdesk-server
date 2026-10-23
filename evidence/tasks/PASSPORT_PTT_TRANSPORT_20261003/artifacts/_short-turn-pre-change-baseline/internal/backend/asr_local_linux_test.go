//go:build linux && !race

package backend

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

const (
	localASRChildEnabled = "GROWDESK_LOCAL_ASR_TEST_CHILD"
	localASRChildMode    = "GROWDESK_LOCAL_ASR_TEST_MODE"
	localASRChildMarker  = "GROWDESK_LOCAL_ASR_TEST_MARKER"
	localASRChildPIDFile = "GROWDESK_LOCAL_ASR_TEST_PID_FILE"
	localASRChildAudio   = "GROWDESK_LOCAL_ASR_TEST_EXPECTED_AUDIO"
)

// This process is invoked only by the isolated tests below. It receives
// virtual audio and a deliberately minimal environment; it never loads a model
// or talks to an external service.
func TestLocalASRHelperProcess(t *testing.T) {
	if os.Getenv(localASRChildEnabled) != "1" {
		return
	}
	inputPath := os.Args[len(os.Args)-1]
	switch os.Getenv(localASRChildMode) {
	case "success":
		info, err := os.Stat(inputPath)
		if err != nil || info.Mode().Perm() != 0600 {
			os.Exit(31)
		}
		data, err := os.ReadFile(inputPath)
		if err != nil || string(data) != os.Getenv(localASRChildAudio) {
			os.Exit(32)
		}
		dirInfo, err := os.Stat(filepath.Dir(inputPath))
		if err != nil || dirInfo.Mode().Perm() != 0700 {
			os.Exit(33)
		}
		if os.Getenv("OPENAI_API_KEY") != "" || os.Getenv("GROWDESK_AI_API_KEY") != "" {
			os.Exit(34)
		}
		var cpu syscall.Rlimit
		if syscall.Getrlimit(syscall.RLIMIT_CPU, &cpu) != nil || cpu.Cur != localASRCPUSeconds || cpu.Max != localASRCPUSeconds+1 {
			os.Exit(35)
		}
		var addressSpace syscall.Rlimit
		if syscall.Getrlimit(syscall.RLIMIT_AS, &addressSpace) != nil || addressSpace.Cur != localASRMemoryBytes || addressSpace.Max != localASRMemoryBytes {
			os.Exit(36)
		}
		_, _ = io.WriteString(os.Stdout, " recognized test transcript \n")
		os.Exit(0)
	case "empty":
		os.Exit(0)
	case "large-stdout":
		_, _ = io.WriteString(os.Stdout, strings.Repeat("x", 64*1024))
		os.Exit(0)
	case "large-stderr":
		_, _ = io.WriteString(os.Stderr, strings.Repeat("private-diagnostic-token", 4096))
		os.Exit(0)
	case "failure":
		_, _ = io.WriteString(os.Stderr, "private-diagnostic-token")
		os.Exit(7)
	case "sleep":
		if marker := os.Getenv(localASRChildMarker); marker != "" {
			if err := os.WriteFile(marker, []byte("started"), 0600); err != nil {
				os.Exit(37)
			}
		}
		time.Sleep(time.Hour)
		os.Exit(0)
	case "spawn":
		helper, err := os.Executable()
		if err != nil {
			os.Exit(38)
		}
		marker := os.Getenv(localASRChildMarker)
		childEnv := []string{
			"PATH=/usr/bin:/bin",
			"LANG=C.UTF-8",
			localASRChildEnabled + "=1",
			localASRChildMode + "=sleep",
			localASRChildMarker + "=" + marker + ".child",
		}
		child := exec.Command(helper, "-test.run=^TestLocalASRHelperProcess$", inputPath)
		child.Env = childEnv
		if err = child.Start(); err != nil {
			os.Exit(39)
		}
		if err = os.WriteFile(os.Getenv(localASRChildPIDFile), []byte(fmt.Sprint(child.Process.Pid)), 0600); err != nil {
			os.Exit(40)
		}
		time.Sleep(time.Hour)
		os.Exit(0)
	default:
		os.Exit(41)
	}
}

func TestTranscribeLocalASRUsesProductionPrlimitWithControlledHelper(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test-only-key-not-a-real-secret")
	t.Setenv("GROWDESK_AI_API_KEY", "test-only-key-not-a-real-secret")
	config := localASRLinuxTestConfig(t, "success")
	transcript, err := transcribeLocalASR(context.Background(), config, strings.NewReader("virtual-audio-fixture"), "audio/wav; rate=16000")
	if err != nil || transcript != "recognized test transcript" {
		t.Fatalf("transcript = %q, err %v", transcript, err)
	}
	assertLocalASRTempParentEmpty(t, config.tempParent)
}

func TestTranscribeLocalASRRejectsEmptyOversizedInputAndBadMIME(t *testing.T) {
	config := localASRLinuxTestConfig(t, "success")
	if _, err := transcribeLocalASR(context.Background(), config, strings.NewReader(""), "audio/wav"); !hasLocalASRCode(err, "ASR_PROVIDER_INVALID_INPUT") {
		t.Fatalf("empty audio error = %v", err)
	}

	config = localASRLinuxTestConfig(t, "success")
	config.inputLimit = 8
	if _, err := transcribeLocalASR(context.Background(), config, strings.NewReader("0123456789"), "audio/wav"); !hasLocalASRCode(err, "ASR_PROVIDER_INPUT_TOO_LARGE") {
		t.Fatalf("oversized audio error = %v", err)
	}
	assertLocalASRTempParentEmpty(t, config.tempParent)

	config = localASRLinuxTestConfig(t, "success")
	if _, err := transcribeLocalASR(context.Background(), config, strings.NewReader("virtual-audio"), "application/octet-stream"); !hasLocalASRCode(err, "ASR_PROVIDER_INVALID_INPUT") {
		t.Fatalf("bad MIME error = %v", err)
	}
	assertLocalASRTempParentEmpty(t, config.tempParent)
}

func TestTranscribeLocalASRRejectsEmptyOversizedAndFailedOutputWithoutLeak(t *testing.T) {
	cases := []struct {
		name       string
		mode       string
		output     int
		stderr     int64
		wantCode   string
		secretText string
	}{
		{name: "empty transcript", mode: "empty", wantCode: "ASR_PROVIDER_INVALID_RESPONSE"},
		{name: "oversized transcript", mode: "large-stdout", output: 1024, wantCode: "ASR_PROVIDER_INVALID_RESPONSE"},
		{name: "child failure", mode: "failure", wantCode: "ASR_PROVIDER_EXECUTION_FAILED", secretText: "private-diagnostic-token"},
		{name: "diagnostic flood", mode: "large-stderr", stderr: 32, wantCode: "ASR_PROVIDER_EXECUTION_FAILED", secretText: "private-diagnostic-token"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			config := localASRLinuxTestConfig(t, tc.mode)
			if tc.output > 0 {
				config.outputLimit = tc.output
			}
			if tc.stderr > 0 {
				config.stderrLimit = tc.stderr
			}
			transcript, err := transcribeLocalASR(context.Background(), config, strings.NewReader("virtual-audio-fixture"), "audio/wav")
			if transcript != "" || !hasLocalASRCode(err, tc.wantCode) {
				t.Fatalf("transcript = %q, err %v; want code %s", transcript, err, tc.wantCode)
			}
			if tc.secretText != "" && strings.Contains(err.Error(), tc.secretText) {
				t.Fatalf("child diagnostics leaked through error: %v", err)
			}
			assertLocalASRTempParentEmpty(t, config.tempParent)
		})
	}
}

func TestTranscribeLocalASRTimeoutKillsChildAndCleansInput(t *testing.T) {
	config := localASRLinuxTestConfig(t, "sleep")
	config.timeout = 100 * time.Millisecond
	transcript, err := transcribeLocalASR(context.Background(), config, strings.NewReader("virtual-audio-fixture"), "audio/wav")
	if transcript != "" || !hasLocalASRCode(err, "ASR_PROVIDER_TIMEOUT") {
		t.Fatalf("transcript = %q, err %v; want timeout", transcript, err)
	}
	assertLocalASRTempParentEmpty(t, config.tempParent)
}

func TestTranscribeLocalASRCancellationKillsProcessGroupAndRejectsOverlap(t *testing.T) {
	config := localASRLinuxTestConfig(t, "spawn")
	config.timeout = 5 * time.Second
	marker := filepath.Join(config.tempParent, "child-started")
	pidFile := filepath.Join(config.tempParent, "child.pid")
	config.childEnv = append(config.childEnv, localASRChildMarker+"="+marker, localASRChildPIDFile+"="+pidFile)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := transcribeLocalASR(ctx, config, strings.NewReader("virtual-audio-fixture"), "audio/wav")
		result <- err
	}()
	waitForLocalASRFile(t, marker+".child")
	waitForLocalASRFile(t, pidFile)

	second := localASRLinuxTestConfig(t, "success")
	if _, err := transcribeLocalASR(context.Background(), second, strings.NewReader("virtual-audio-fixture"), "audio/wav"); !hasLocalASRCode(err, "ASR_PROVIDER_BUSY") {
		t.Fatalf("overlapping local ASR error = %v; want busy", err)
	}

	pidBytes, err := os.ReadFile(pidFile)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	var pid int
	if _, err = fmt.Sscan(string(pidBytes), &pid); err != nil || pid <= 0 {
		cancel()
		t.Fatalf("invalid descendant pid %q: %v", pidBytes, err)
	}
	cancel()
	select {
	case err = <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled ASR error = %v; want context.Canceled", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("ASR cancellation did not terminate the command process group")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err = syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err = syscall.Kill(pid, 0); err == nil {
		t.Fatalf("descendant process %d survived cancellation", pid)
	}
	_ = os.Remove(marker + ".child")
	_ = os.Remove(pidFile)
	assertLocalASRTempParentEmpty(t, config.tempParent)
}

func TestTranscribeLocalASRRejectsMissingLimiter(t *testing.T) {
	config := localASRLinuxTestConfig(t, "success")
	config.limiterPath = ""
	if _, err := transcribeLocalASR(context.Background(), config, strings.NewReader("virtual-audio-fixture"), "audio/wav"); !hasLocalASRCode(err, "ASR_PROVIDER_CONFIG_INVALID") {
		t.Fatalf("missing limiter error = %v; want fail-closed config error", err)
	}
}

func localASRLinuxTestConfig(t *testing.T, mode string) localASRConfig {
	t.Helper()
	helper, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	limiter, err := localASRResourceLimiter()
	if err != nil {
		t.Fatal(err)
	}
	return localASRConfig{
		argv:        []string{helper, "-test.run=^TestLocalASRHelperProcess$", "{input}"},
		limiterPath: limiter,
		timeout:     2 * time.Second,
		inputLimit:  localASRInputLimit,
		outputLimit: localASROutputLimit,
		stderrLimit: localASRStderrLimit,
		tempParent:  t.TempDir(),
		childEnv: append(localASRChildEnvironment(),
			localASRChildEnabled+"=1",
			localASRChildMode+"="+mode,
			localASRChildAudio+"=virtual-audio-fixture",
		),
	}
}

func assertLocalASRTempParentEmpty(t *testing.T, parent string) {
	t.Helper()
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("local ASR temporary files were not cleaned up: %v", entries)
	}
}

func waitForLocalASRFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("controlled child did not create marker %s", filepath.Base(path))
}
