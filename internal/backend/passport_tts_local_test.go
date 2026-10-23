package backend

import (
	"bytes"
	"context"
	"errors"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestPassportTTSLocalEspeakIsExplicitAndDoesNotReuseFixtureOrRemoteConfig(t *testing.T) {
	clearPassportTTSTestEnv(t)
	common := nativeProviderConfig{Mode: "fixture", Fixture: `{"text":"test"}`, Timeout: time.Second}
	t.Setenv("GROWDESK_TTS_PROVIDER", "local-espeak")
	config, err := passportTTSConfiguration(common)
	if runtime.GOOS == "linux" {
		if err != nil && !hasPassportTTSCode(err, "TTS_PROVIDER_NOT_CONFIGURED") {
			t.Fatalf("local provider returned unexpected config error: %v", err)
		}
		if err == nil && (config.Mode != "local-espeak" || config.Voice != "cmn" || config.APIKey != "" || config.Endpoint != "" || config.Local.espeakPath != "/usr/bin/espeak-ng" || config.Local.ffmpegPath != "/usr/bin/ffmpeg") {
			t.Fatalf("local provider config = %#v, err %v", config, err)
		}
	} else {
		var providerErr *nativeProviderError
		if !errors.As(err, &providerErr) || providerErr.Code != "TTS_PROVIDER_CONFIG_INVALID" || config.Mode == "fixture" {
			t.Fatalf("non-Linux local provider must fail closed without fixture fallback: config=%#v err=%v", config, err)
		}
	}

	clearPassportTTSTestEnv(t)
	if _, err := passportTTSConfiguration(nativeProviderConfig{Mode: "openai-compatible", Endpoint: "https://provider.invalid/v1/chat/completions", APIKey: "test_fake_key"}); err == nil {
		t.Fatal("the chat provider implicitly enabled speech synthesis")
	}

	clearPassportTTSTestEnv(t)
	t.Setenv("GROWDESK_TTS_PROVIDER", "local")
	t.Setenv("GROWDESK_TTS_BASE_URL", "https://provider.invalid/v1")
	if _, err := passportTTSConfiguration(common); !hasPassportTTSCode(err, "TTS_PROVIDER_CONFIG_INVALID") {
		t.Fatalf("local provider accepted a remote endpoint: %v", err)
	}

	clearPassportTTSTestEnv(t)
	t.Setenv("GROWDESK_TTS_PROVIDER", "local-espeak")
	t.Setenv("GROWDESK_TTS_API_KEY", "test_fake_key")
	if _, err := passportTTSConfiguration(common); !hasPassportTTSCode(err, "TTS_PROVIDER_CONFIG_INVALID") {
		t.Fatalf("local provider accepted remote credentials: %v", err)
	}

	clearPassportTTSTestEnv(t)
	t.Setenv("GROWDESK_TTS_PROVIDER", "local-espeak")
	t.Setenv("GROWDESK_TTS_VOICE", "en-us")
	if _, err := passportTTSConfiguration(common); !hasPassportTTSCode(err, "TTS_PROVIDER_CONFIG_INVALID") {
		t.Fatalf("local provider accepted a non-cmn voice: %v", err)
	}
}

func TestPassportTTSLocalSherpaIsExplicitAndRejectsRemoteConfiguration(t *testing.T) {
	clearPassportTTSTestEnv(t)
	common := nativeProviderConfig{Mode: "fixture", Fixture: `{"text":"test"}`, Timeout: time.Second}
	t.Setenv("GROWDESK_TTS_PROVIDER", "local-sherpa")
	config, err := passportTTSConfiguration(common)
	if runtime.GOOS == "linux" {
		if err != nil && !hasPassportTTSCode(err, "TTS_PROVIDER_NOT_CONFIGURED") {
			t.Fatalf("local Sherpa provider returned unexpected config error: %v", err)
		}
		if err == nil && (config.Mode != "local-sherpa" || config.Voice != "zh" || config.APIKey != "" || config.Endpoint != "" || config.Local.engine != "local-sherpa" || config.Local.sherpaPythonPath != localPassportTTSSherpaPythonPath || config.Local.sherpaScriptPath != localPassportTTSSherpaScriptPath) {
			t.Fatalf("local Sherpa provider config = %#v, err %v", config, err)
		}
	} else {
		var providerErr *nativeProviderError
		if !errors.As(err, &providerErr) || providerErr.Code != "TTS_PROVIDER_CONFIG_INVALID" || config.Mode == "fixture" {
			t.Fatalf("non-Linux local Sherpa provider must fail closed without fixture fallback: config=%#v err=%v", config, err)
		}
	}

	for name, setting := range map[string]struct {
		baseURL string
		apiKey  string
		model   string
		voice   string
	}{
		"endpoint":   {baseURL: "https://provider.invalid/v1"},
		"credential": {apiKey: "test_fake_key"},
		"model":      {model: "test_model"},
		"voice":      {voice: "cmn"},
	} {
		t.Run(name, func(t *testing.T) {
			clearPassportTTSTestEnv(t)
			t.Setenv("GROWDESK_TTS_PROVIDER", "local-sherpa")
			t.Setenv("GROWDESK_TTS_BASE_URL", setting.baseURL)
			t.Setenv("GROWDESK_TTS_API_KEY", setting.apiKey)
			t.Setenv("GROWDESK_TTS_MODEL", setting.model)
			t.Setenv("GROWDESK_TTS_VOICE", setting.voice)
			if _, err := passportTTSConfiguration(common); !hasPassportTTSCode(err, "TTS_PROVIDER_CONFIG_INVALID") {
				t.Fatalf("local Sherpa provider accepted incompatible configuration: %v", err)
			}
		})
	}
}

func TestLocalPassportTTSPCMValidationAndBudgets(t *testing.T) {
	if !validLocalPassportTTSPCM([]byte{0x01, 0x00}) {
		t.Fatal("one little-endian PCM sample was rejected")
	}
	for name, pcm := range map[string][]byte{
		"empty":      nil,
		"odd":        {1, 2, 3},
		"wav header": []byte("RIFF0000WAVE"),
		"oversize":   make([]byte, maxPassportTTSOutputBytes+1),
	} {
		t.Run(name, func(t *testing.T) {
			if validLocalPassportTTSPCM(pcm) {
				t.Fatalf("invalid PCM accepted: %s", name)
			}
		})
	}

	var output bytes.Buffer
	writer := &localPassportTTSBoundedWriter{writer: &output, limit: 3}
	if n, err := writer.Write([]byte("four")); err == nil || n != 3 || !writer.exceeded || output.String() != "fou" {
		t.Fatalf("bounded writer = n %d err %v exceeded %v bytes %q", n, err, writer.exceeded, output.String())
	}
}

func TestLocalPassportTTSChildEnvironmentExcludesServiceSecrets(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "test_fake_openai_secret")
	t.Setenv("GROWDESK_TTS_API_KEY", "test_fake_tts_secret")
	env := strings.Join(localPassportTTSChildEnvironment(t.TempDir()), "\n")
	for _, secret := range []string{"OPENAI_API_KEY", "GROWDESK_TTS_API_KEY", "test_fake_openai_secret", "test_fake_tts_secret"} {
		if strings.Contains(env, secret) {
			t.Fatalf("local TTS child environment includes %q: %q", secret, env)
		}
	}
	if strings.Contains(env, "GROWDESK_TTS_") {
		t.Fatalf("local TTS child environment includes arbitrary TTS settings: %q", env)
	}
}

func TestSynthesizeLocalPassportTTSRejectsInvalidTextBeforeProcessStart(t *testing.T) {
	for name, text := range map[string]string{"empty": " \n ", "nul": "a\x00b", "invalid utf8": string([]byte{0xff}), "oversize": strings.Repeat("x", maxPassportTTSTextBytes+1)} {
		t.Run(name, func(t *testing.T) {
			_, err := synthesizeLocalPassportTTS(nil, localPassportTTSConfig{}, text)
			if !hasPassportTTSCode(err, "TTS_PROVIDER_INVALID_INPUT") {
				t.Fatalf("invalid text error = %v", err)
			}
		})
	}
}

func TestSynthesizeLocalPassportTTSSherpaRejectsTextOver8192BytesBeforeProcessStart(t *testing.T) {
	parent := t.TempDir()
	for name, text := range map[string]string{
		"ascii":          strings.Repeat("x", maxLocalSherpaTTSTextBytes+1),
		"multibyte utf8": strings.Repeat("声", maxLocalSherpaTTSTextBytes/3+1),
	} {
		t.Run(name, func(t *testing.T) {
			beforeSlots := len(localPassportTTSSlot)
			_, err := synthesizeLocalPassportTTS(context.Background(), localPassportTTSConfig{engine: "local-sherpa", tempParent: parent}, text)
			if !hasPassportTTSCode(err, "TTS_PROVIDER_INVALID_INPUT") {
				t.Fatalf("oversize Sherpa text error = %v", err)
			}
			entries, readErr := os.ReadDir(parent)
			if readErr != nil || len(entries) != 0 {
				t.Fatalf("oversize input created local files: entries=%v err=%v", entries, readErr)
			}
			if occupied := len(localPassportTTSSlot); occupied != beforeSlots {
				t.Fatalf("oversize input changed local TTS slot occupancy: before=%d after=%d", beforeSlots, occupied)
			}
		})
	}
}

func hasPassportTTSCode(err error, code string) bool {
	var providerErr *nativeProviderError
	return errors.As(err, &providerErr) && providerErr.Code == code
}
