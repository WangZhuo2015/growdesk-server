package backend

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestParseLocalASRCommandUsesFixedArgvWithoutShell(t *testing.T) {
	argv, err := parseLocalASRCommand(`/opt/asr/bin/recognizer --model "models/large model" --input {input}`)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/opt/asr/bin/recognizer", "--model", "models/large model", "--input", "{input}"}
	if strings.Join(argv, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv = %#v, want %#v", argv, want)
	}
	for _, raw := range []string{
		`/bin/sh -c 'cat {input}'`,
		`/usr/bin/env bash -c 'cat {input}'`,
		`/bin/busybox sh -c 'cat {input}'`,
		`/opt/asr/run --audio {input} {input}`,
		`/opt/asr/run --audio`,
		`/opt/asr/run --audio "{input}`,
	} {
		if _, err := parseLocalASRCommand(raw); err == nil {
			t.Errorf("parseLocalASRCommand(%q) unexpectedly succeeded", raw)
		}
	}

	argv, err = parseLocalASRCommand(`/opt/asr/bin/recognizer --audio {input};touch /tmp/not-shell-expanded`)
	if err != nil {
		t.Fatalf("literal punctuation should remain argv data, got %v", err)
	}
	if len(argv) != 4 || argv[2] != "{input};touch" || argv[3] != "/tmp/not-shell-expanded" {
		t.Fatalf("shell punctuation was not preserved as fixed argv: %#v", argv)
	}
}

func TestResolveLocalASRProgramRejectsDispatcherSymlinkToEnv(t *testing.T) {
	envProgram, err := exec.LookPath("env")
	if err != nil {
		t.Fatal("env is unavailable on a supported Unix host")
	}
	alias := filepath.Join(t.TempDir(), "asr-dispatcher")
	if err := os.Symlink(envProgram, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveLocalASRProgram([]string{alias, "bash", "-c", "exec", "{input}"}); err == nil {
		t.Fatal("dispatcher symlink to env launched a shell")
	}
}

func TestLocalASRConfigurationIsExplicitAndRejectsAmbiguity(t *testing.T) {
	t.Setenv("GROWDESK_ASR_PROVIDER", "")
	t.Setenv("ASR_COMMAND", "")
	if _, enabled, err := localASRConfiguration(); err != nil || enabled {
		t.Fatalf("unconfigured local ASR = enabled %v, err %v; want disabled without error", enabled, err)
	}

	t.Setenv("GROWDESK_ASR_PROVIDER", "local")
	if _, enabled, err := localASRConfiguration(); enabled || !hasLocalASRCode(err, "ASR_PROVIDER_NOT_CONFIGURED") {
		t.Fatalf("local selector without command = enabled %v, err %v", enabled, err)
	}

	for _, selector := range []string{"openai", "openai-compatible", "compat", "shared"} {
		t.Setenv("GROWDESK_ASR_PROVIDER", selector)
		if _, enabled, err := localASRConfiguration(); err != nil || enabled {
			t.Errorf("selector %q without ASR_COMMAND = enabled %v, err %v; want local disabled", selector, enabled, err)
		}
	}

	t.Setenv("ASR_COMMAND", `/opt/asr/bin/recognizer --input {input}`)
	for _, selector := range []string{"openai-compatible", "shared"} {
		t.Setenv("GROWDESK_ASR_PROVIDER", selector)
		if _, enabled, err := localASRConfiguration(); enabled || !hasLocalASRCode(err, "ASR_PROVIDER_CONFIG_INVALID") {
			t.Errorf("selector %q with ASR_COMMAND = enabled %v, err %v; want conflict", selector, enabled, err)
		}
	}
	t.Setenv("GROWDESK_ASR_PROVIDER", "unexpected-provider")
	if _, enabled, err := localASRConfiguration(); enabled || !hasLocalASRCode(err, "ASR_PROVIDER_CONFIG_INVALID") {
		t.Fatalf("unknown selector = enabled %v, err %v; want config error", enabled, err)
	}
}

func TestLocalASRConfigurationUsesLegacyCommandAndFailsClosedOutsideLinux(t *testing.T) {
	helper, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GROWDESK_ASR_PROVIDER", "local")
	t.Setenv("ASR_COMMAND", quoteLocalASRArg(helper)+" -test.run=^TestLocalASRHelperProcess$ {input}")
	config, enabled, err := localASRConfiguration()
	if runtime.GOOS == "linux" {
		if err != nil || !enabled || config.limiterPath == "" || config.timeout != localASRTimeout || config.inputLimit != localASRInputLimit || config.outputLimit != localASROutputLimit {
			t.Fatalf("Linux local configuration = enabled %v, config %#v, err %v", enabled, config, err)
		}
		return
	}
	if enabled || !hasLocalASRCode(err, "ASR_PROVIDER_CONFIG_INVALID") {
		t.Fatalf("non-Linux local configuration = enabled %v, err %v; want fail-closed config error", enabled, err)
	}
}

func quoteLocalASRArg(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	return `"` + value + `"`
}

func hasLocalASRCode(err error, code string) bool {
	var provider *nativeProviderError
	return errors.As(err, &provider) && provider.Code == code
}

func TestValidateLocalASRTranscriptPreservesNoSpeechCode(t *testing.T) {
	transcript, err := validateLocalASRTranscript("，。！？…", localASROutputLimit)
	if transcript != "" || !hasLocalASRCode(err, "ASR_PROVIDER_NO_SPEECH") {
		t.Fatalf("punctuation-only local transcript = %q, %v; want ASR_PROVIDER_NO_SPEECH", transcript, err)
	}

	const valid = "宝宝喝了120毫升奶，请记录一次。"
	transcript, err = validateLocalASRTranscript(valid, localASROutputLimit)
	if transcript != valid || err != nil {
		t.Fatalf("valid local transcript = %q, %v; want original text unchanged", transcript, err)
	}
}
