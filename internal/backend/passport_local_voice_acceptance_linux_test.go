//go:build linux && !race

package backend

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// Opt-in acceptance for the existing offline engines, with no account, DB,
// HTTP provider or business write. Ordinary test runs never load a real model.
func TestPassportExistingLocalVoiceAcceptance(t *testing.T) {
	if os.Getenv("GROWDESK_LOCAL_VOICE_ACCEPTANCE") != "1" {
		t.Skip("requires explicitly authorized installed offline ASR/TTS engines")
	}
	if os.Getenv("ASR_COMMAND") != "/srv/asr/run.sh {input}" {
		t.Fatal("offline acceptance is restricted to the audited existing ASR wrapper")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	speech, err := nativeSpeechConfiguration()
	if err != nil || speech.Mode != "local" {
		t.Fatalf("existing recognizer unavailable: %v", err)
	}
	config, err := passportTTSConfiguration(nativeProviderConfig{Timeout: 20 * time.Second})
	if err != nil || config.Mode != "local-sherpa" {
		t.Fatalf("installed local TTS unavailable: mode=%s err=%v", config.Mode, err)
	}
	pcm, err := synthesizePassportTTS(ctx, config, "这是语音测试。")
	if err != nil || len(pcm) == 0 || len(pcm)%2 != 0 {
		t.Fatalf("installed TTS did not produce aligned PCM: bytes=%d err=%v", len(pcm), err)
	}
	nonzero := false
	for _, b := range pcm {
		if b != 0 {
			nonzero = true
			break
		}
	}
	if !nonzero {
		t.Fatal("installed TTS returned silence")
	}
	if len(pcm) > 960*1024 {
		t.Fatal("short acceptance sentence exceeded the device voice input budget")
	}
	// The ASR wrapper converts input WAV to 16kHz itself. Synthesis explicitly
	// returns the device playback format: 24kHz mono S16LE.
	transcript, err := (&Server{}).transcribePassportWav(ctx, speech, buildWavFile(pcm, 24000, 1, 16))
	if err != nil || strings.TrimSpace(transcript) != "这是语音测试。" {
		t.Fatalf("existing engines failed the test sentence: transcript=%q err=%v", transcript, err)
	}
	t.Logf("real offline TTS -> PCM -> WAV -> existing ASR: bytes=%d duration=%.2fs transcript=%q", len(pcm), float64(len(pcm))/48000, transcript)
	pcm, err = synthesizePassportTTS(ctx, config, "宝宝喝了一百四十毫升奶。")
	if err != nil {
		t.Fatalf("existing synthesis failed the quantity sentence: %v", err)
	}
	transcript, err = (&Server{}).transcribePassportWav(ctx, speech, buildWavFile(pcm, 24000, 1, 16))
	if err != nil || !strings.Contains(transcript, "毫升") || (!strings.Contains(transcript, "140") && !strings.Contains(transcript, "一百四十")) {
		t.Fatalf("existing engines failed the quantity sentence: transcript=%q err=%v", transcript, err)
	}
	t.Logf("real offline quantity sentence: bytes=%d duration=%.2fs transcript=%q", len(pcm), float64(len(pcm))/48000, transcript)
	_, err = (&Server{}).transcribePassportWav(ctx, speech, buildWavFile(make([]byte, 32000), 16000, 1, 16))
	var failure *nativeProviderError
	if !errors.As(err, &failure) || failure.Code != "ASR_PROVIDER_NO_SPEECH" {
		t.Fatalf("digital silence was not rejected before the real model: %v", err)
	}
}
