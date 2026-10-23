//go:build linux && !race

package backend

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestSynthesizeLocalPassportTTSUsesInstalledEspeakAndFFmpeg(t *testing.T) {
	requireLocalPassportTTSAcceptance(t)
	config := localPassportTTSTestConfig(t)
	config.tempParent = t.TempDir()
	pcm, err := synthesizeLocalPassportTTS(context.Background(), config, "这是隔离的语音测试。")
	if err != nil {
		t.Fatal(err)
	}
	if !validLocalPassportTTSPCM(pcm) {
		t.Fatalf("local TTS returned invalid PCM: %d bytes", len(pcm))
	}
	nonZero := false
	for _, sample := range pcm {
		if sample != 0 {
			nonZero = true
			break
		}
	}
	if !nonZero {
		t.Fatal("local TTS returned silence for non-empty Mandarin text")
	}
	assertLocalPassportTTSTempParentEmpty(t, config.tempParent)
}

func TestSynthesizeLocalPassportTTSCancellationKillsEspeakAndCleansTempFiles(t *testing.T) {
	requireLocalPassportTTSAcceptance(t)
	config := localPassportTTSTestConfig(t)
	config.tempParent = t.TempDir()
	text := strings.Repeat("这是隔离的取消语音测试。", 6500)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	joined := false
	observed := localPassportTTSTestProcess{}
	defer func() { finishLocalPassportTTSTest(t, cancel, result, &joined, observed, config.tempParent) }()
	go func() {
		_, synthErr := synthesizeLocalPassportTTS(ctx, config, text)
		result <- synthErr
	}()
	var err error
	observed.pid, observed.pgid, observed.tempDir, err = waitForLocalPassportTTSEspeak(config.tempParent, config.espeakPath, os.Getpid())
	if err != nil {
		t.Fatalf("observe fixed eSpeak during cancellation test: %v", err)
	}
	assertLocalPassportTTSPrivateFiles(t, observed.tempDir)
	cancel()
	select {
	case synthErr := <-result:
		joined = true
		if !errors.Is(synthErr, context.Canceled) {
			t.Fatalf("local TTS cancellation error = %v; want context.Canceled", synthErr)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("local TTS did not stop after cancellation")
	}
	assertLocalPassportTTSTestProcessStopped(t, observed, "eSpeak")
	assertLocalPassportTTSSlotEmpty(t)
	assertLocalPassportTTSTempParentEmpty(t, config.tempParent)
}

func TestSynthesizeLocalPassportTTSTimeoutKillsEspeakAndCleansTempFiles(t *testing.T) {
	requireLocalPassportTTSAcceptance(t)
	config := localPassportTTSTestConfig(t)
	config.timeout = 150 * time.Millisecond
	config.tempParent = t.TempDir()
	text := strings.Repeat("这是隔离的超时语音测试。", 6500)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	joined := false
	observed := localPassportTTSTestProcess{}
	defer func() { finishLocalPassportTTSTest(t, cancel, result, &joined, observed, config.tempParent) }()
	go func() {
		_, synthErr := synthesizeLocalPassportTTS(ctx, config, text)
		result <- synthErr
	}()
	var err error
	observed.pid, observed.pgid, observed.tempDir, err = waitForLocalPassportTTSEspeak(config.tempParent, config.espeakPath, os.Getpid())
	if err != nil {
		t.Fatalf("observe fixed eSpeak during timeout test: %v", err)
	}
	assertLocalPassportTTSPrivateFiles(t, observed.tempDir)
	select {
	case synthErr := <-result:
		joined = true
		if !hasPassportTTSCode(synthErr, "TTS_PROVIDER_TIMEOUT") {
			t.Fatalf("local TTS timeout error = %v; want TTS_PROVIDER_TIMEOUT", synthErr)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("local TTS did not stop after its configured timeout")
	}
	assertLocalPassportTTSTestProcessStopped(t, observed, "eSpeak")
	assertLocalPassportTTSSlotEmpty(t)
	assertLocalPassportTTSTempParentEmpty(t, config.tempParent)
}

func TestSynthesizeLocalPassportTTSRejectsConcurrentRequest(t *testing.T) {
	config := localPassportTTSLogicalTestConfig(t, "local-espeak")
	config.tempParent = t.TempDir()
	localPassportTTSSlot <- struct{}{}
	defer func() { <-localPassportTTSSlot }()
	if _, err := synthesizeLocalPassportTTS(context.Background(), config, "这是隔离的并发测试。"); !hasPassportTTSCode(err, "TTS_PROVIDER_BUSY") {
		t.Fatalf("concurrent local TTS error = %v; want busy", err)
	}
	assertLocalPassportTTSTempParentEmpty(t, config.tempParent)
}

func TestSynthesizeLocalPassportTTSSherpaUsesInstalledModelAndFFmpeg(t *testing.T) {
	requireLocalPassportTTSAcceptance(t)
	config := localPassportTTSSherpaTestConfig(t)
	config.tempParent = t.TempDir()
	pcm, err := synthesizeLocalPassportTTS(context.Background(), config, "这是隔离的 Sherpa 普通话语音验收。")
	if err != nil {
		t.Fatal(err)
	}
	if !validLocalPassportTTSPCM(pcm) {
		t.Fatalf("local Sherpa TTS returned invalid PCM: %d bytes", len(pcm))
	}
	nonZero := false
	for _, sample := range pcm {
		if sample != 0 {
			nonZero = true
			break
		}
	}
	if !nonZero {
		t.Fatal("local Sherpa TTS returned silence for non-empty Mandarin text")
	}
	assertLocalPassportTTSSlotEmpty(t)
	assertLocalPassportTTSTempParentEmpty(t, config.tempParent)
}

func TestSynthesizeLocalPassportTTSSherpaCancellationKillsPythonAndCleansTempFiles(t *testing.T) {
	requireLocalPassportTTSAcceptance(t)
	config := localPassportTTSSherpaTestConfig(t)
	config.timeout = 20 * time.Second
	config.tempParent = t.TempDir()
	text := strings.Repeat("这是隔离的 Sherpa 取消语音验收。", maxLocalSherpaTTSTextBytes/len("这是隔离的 Sherpa 取消语音验收。"))
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	joined := false
	observed := localPassportTTSTestProcess{}
	defer func() { finishLocalPassportTTSTest(t, cancel, result, &joined, observed, config.tempParent) }()
	go func() {
		_, synthErr := synthesizeLocalPassportTTS(ctx, config, text)
		result <- synthErr
	}()
	var err error
	observed.pid, observed.pgid, observed.tempDir, err = waitForLocalPassportTTSProcess(config.tempParent, config.sherpaPythonResolvedPath, os.Getpid())
	if err != nil {
		t.Fatalf("observe fixed Sherpa Python during cancellation test: %v", err)
	}
	assertLocalPassportTTSPrivateFiles(t, observed.tempDir)
	cancel()
	select {
	case synthErr := <-result:
		joined = true
		if !errors.Is(synthErr, context.Canceled) {
			t.Fatalf("local Sherpa TTS cancellation error = %v; want context.Canceled", synthErr)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("local Sherpa TTS did not stop after cancellation")
	}
	assertLocalPassportTTSTestProcessStopped(t, observed, "Sherpa Python")
	assertLocalPassportTTSSlotEmpty(t)
	assertLocalPassportTTSTempParentEmpty(t, config.tempParent)
}

type localPassportTTSTestProcess struct {
	pid, pgid int
	tempDir   string
}

func waitForLocalPassportTTSEspeak(tempParent, executable string, parentPID int) (int, int, string, error) {
	return waitForLocalPassportTTSProcess(tempParent, executable, parentPID)
}

func waitForLocalPassportTTSProcess(tempParent, executable string, parentPID int) (int, int, string, error) {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		entries, err := os.ReadDir("/proc")
		if err != nil {
			return 0, 0, "", fmt.Errorf("Linux /proc is unavailable: %w", err)
		}
		for _, entry := range entries {
			if !entry.IsDir() || entry.Name() == "" || entry.Name()[0] < '0' || entry.Name()[0] > '9' {
				continue
			}
			pid, err := strconv.Atoi(entry.Name())
			if err != nil {
				continue
			}
			link, err := os.Readlink(filepath.Join("/proc", entry.Name(), "exe"))
			stat, statErr := os.ReadFile(filepath.Join("/proc", entry.Name(), "stat"))
			if err == nil && statErr == nil && filepath.Clean(link) == filepath.Clean(executable) && localPassportTTSProcParent(stat) == parentPID {
				pgid := localPassportTTSProcGroup(stat)
				if pgid <= 0 {
					return pid, 0, "", fmt.Errorf("could not identify local TTS process group from /proc/%d/stat", pid)
				}
				tempEntries, err := os.ReadDir(tempParent)
				if err != nil {
					return pid, pgid, "", fmt.Errorf("read local TTS temporary parent: %w", err)
				}
				var tempDir string
				for _, entry := range tempEntries {
					if entry.IsDir() && strings.HasPrefix(entry.Name(), "growdesk-tts-") {
						if tempDir != "" {
							return pid, pgid, tempDir, fmt.Errorf("multiple local TTS temporary directories are present: %v", tempEntries)
						}
						tempDir = filepath.Join(tempParent, entry.Name())
					}
				}
				if tempDir == "" {
					return pid, pgid, "", fmt.Errorf("local TTS private directory was not present while synthesis ran: entries=%v", tempEntries)
				}
				return pid, pgid, tempDir, nil
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	entries, err := os.ReadDir(tempParent)
	if err != nil {
		return 0, 0, "", fmt.Errorf("fixed eSpeak process did not remain observable and reading temp parent failed: %w", err)
	}
	return 0, 0, "", fmt.Errorf("fixed local TTS process %s did not remain observable during synthesis (temp entries=%d)", executable, len(entries))
}

func localPassportTTSProcParent(stat []byte) int {
	closeParen := strings.LastIndexByte(string(stat), ')')
	if closeParen < 0 {
		return -1
	}
	fields := strings.Fields(string(stat[closeParen+1:]))
	if len(fields) < 2 {
		return -1
	}
	pid, err := strconv.Atoi(fields[1])
	if err != nil {
		return -1
	}
	return pid
}

func localPassportTTSProcGroup(stat []byte) int {
	closeParen := strings.LastIndexByte(string(stat), ')')
	if closeParen < 0 {
		return -1
	}
	fields := strings.Fields(string(stat[closeParen+1:]))
	if len(fields) < 3 {
		return -1
	}
	pgid, err := strconv.Atoi(fields[2])
	if err != nil {
		return -1
	}
	return pgid
}

func localPassportTTSTestConfig(t *testing.T) localPassportTTSConfig {
	t.Helper()
	config, err := passportTTSLocalConfiguration(20 * time.Second)
	if err != nil {
		t.Fatalf("fixed local TTS programs or prlimit must be available for this Linux helper test: %v", err)
	}
	return config
}

func localPassportTTSSherpaTestConfig(t *testing.T) localPassportTTSConfig {
	t.Helper()
	config, err := passportTTSLocalSherpaConfiguration(30 * time.Second)
	if err != nil {
		t.Fatalf("fixed local Sherpa TTS Python, protected script, ffmpeg, and prlimit must be available for this Linux acceptance test: %v", err)
	}
	return config
}

func localPassportTTSLogicalTestConfig(t *testing.T, engine string) localPassportTTSConfig {
	t.Helper()
	return localPassportTTSConfig{
		engine:      engine,
		espeakPath:  "/usr/bin/espeak-ng",
		ffmpegPath:  "/usr/bin/ffmpeg",
		limiterPath: "/usr/bin/prlimit",
		timeout:     time.Second,
	}
}

func requireLocalPassportTTSAcceptance(t *testing.T) {
	t.Helper()
	if os.Getenv("GROWDESK_LOCAL_VOICE_ACCEPTANCE") != "1" {
		t.Skip("set GROWDESK_LOCAL_VOICE_ACCEPTANCE=1 to run installed local voice acceptance tests")
	}
}

func assertLocalPassportTTSPrivateFiles(t *testing.T, tempDir string) {
	t.Helper()
	dirInfo, err := os.Lstat(tempDir)
	if err != nil || !dirInfo.IsDir() || dirInfo.Mode()&os.ModeSymlink != 0 || dirInfo.Mode().Perm() != 0700 {
		t.Fatalf("local TTS temp directory mode = %v, err %v; want 0700", dirInfo, err)
	}
	entries, err := os.ReadDir(tempDir)
	if err != nil {
		t.Fatalf("read local TTS private directory: %v", err)
	}
	var wave os.DirEntry
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "speech-") && filepath.Ext(entry.Name()) == ".wav" {
			if wave != nil {
				t.Fatalf("multiple local TTS wave files appeared during synthesis: entries=%v", entries)
			}
			wave = entry
		}
	}
	if wave == nil {
		t.Fatalf("local TTS private wave file missing during synthesis: entries=%v", entries)
	}
	if wave.Type()&os.ModeSymlink != 0 || wave.IsDir() {
		t.Fatalf("local TTS private wave is not a direct regular file: %q mode=%v", wave.Name(), wave.Type())
	}
	fileInfo, err := wave.Info()
	if err != nil || fileInfo.Mode().Perm() != 0600 {
		t.Fatalf("local TTS wave file mode = %v, err %v; want 0600", fileInfo, err)
	}
	if !fileInfo.Mode().IsRegular() {
		t.Fatalf("local TTS wave file is not regular: %q mode=%v", wave.Name(), fileInfo.Mode())
	}
}

func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || !errors.Is(err, syscall.ESRCH)
}

func processGroupAlive(pgid int) bool {
	err := syscall.Kill(-pgid, 0)
	return err == nil || !errors.Is(err, syscall.ESRCH)
}

func assertLocalPassportTTSTestProcessStopped(t *testing.T, process localPassportTTSTestProcess, label string) {
	t.Helper()
	if process.pid <= 0 || process.pgid <= 0 {
		t.Fatalf("%s process observation is incomplete: %+v", label, process)
	}
	if processAlive(process.pid) {
		t.Fatalf("%s process %d survived local TTS stop", label, process.pid)
	}
	if processGroupAlive(process.pgid) {
		t.Fatalf("%s process group %d survived local TTS stop", label, process.pgid)
	}
}

func assertLocalPassportTTSSlotEmpty(t *testing.T) {
	t.Helper()
	if occupied := len(localPassportTTSSlot); occupied != 0 {
		t.Fatalf("local TTS slot remains occupied after completion: %d", occupied)
	}
}

func finishLocalPassportTTSTest(t *testing.T, cancel context.CancelFunc, result <-chan error, joined *bool, process localPassportTTSTestProcess, tempParent string) {
	t.Helper()
	cancel()
	if !*joined {
		select {
		case <-result:
			*joined = true
		case <-time.After(3 * time.Second):
			if process.pgid > 0 {
				if err := syscall.Kill(-process.pgid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
					t.Errorf("force-stop eSpeak process group %d after test failure: %v", process.pgid, err)
				}
			}
			select {
			case <-result:
				*joined = true
			case <-time.After(2 * time.Second):
				t.Errorf("local TTS synthesis did not join during test cleanup")
			}
		}
	}
	if process.pid > 0 && processAlive(process.pid) {
		t.Errorf("eSpeak process %d survived test cleanup", process.pid)
	}
	if process.pgid > 0 && processGroupAlive(process.pgid) {
		t.Errorf("eSpeak process group %d survived test cleanup", process.pgid)
	}
	if occupied := len(localPassportTTSSlot); occupied != 0 {
		t.Errorf("local TTS slot remains occupied after test cleanup: %d", occupied)
	}
	entries, err := os.ReadDir(tempParent)
	if err != nil {
		t.Errorf("read local TTS test temp parent after cleanup: %v", err)
	} else if len(entries) != 0 {
		t.Errorf("local TTS temporary files were not cleaned after test failure: %v", entries)
	}
}

func assertLocalPassportTTSTempParentEmpty(t *testing.T, parent string) {
	t.Helper()
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("local TTS temporary files were not cleaned: %v", entries)
	}
}
