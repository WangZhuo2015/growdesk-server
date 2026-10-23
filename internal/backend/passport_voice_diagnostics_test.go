package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

func TestPassportTTSDiagnosticsExposeOutcomeWithoutReplyOrCredentials(t *testing.T) {
	for _, configured := range []bool{false, true} {
		t.Run(map[bool]string{false: "configuration failure", true: "complete"}[configured], func(t *testing.T) {
			clearPassportTTSTestEnv(t)
			if configured {
				t.Setenv("GROWDESK_TTS_PROVIDER", "fixture")
			}
			var output bytes.Buffer
			server := &Server{Log: slog.New(slog.NewJSONHandler(&output, nil))}
			common := nativeProviderConfig{Mode: "openai-compatible", APIKey: "test_private_key"}
			if configured {
				common.Mode = "fixture"
			}
			server.streamPassportTTS(context.Background(), common, "test_turn", "test_private_reply", func(any) error { return nil }, func([]byte) error { return nil })
			if strings.Contains(output.String(), "test_private_reply") || strings.Contains(output.String(), "test_private_key") {
				t.Fatal("TTS diagnostic exposed reply or credentials")
			}
			var event Object
			if err := json.Unmarshal(output.Bytes(), &event); err != nil {
				t.Fatalf("expected one machine-readable TTS outcome: %v, output=%q", err, output.String())
			}
			if event["msg"] != "passport speech outcome" {
				t.Fatalf("missing speech outcome: %#v", event)
			}
			if configured {
				if event["phase"] != "complete" || event["pcmBytes"] != float64(4800) || event["sentBytes"] != float64(4800) || event["chunks"] != float64(3) || event["peakAmplitude"] != float64(0) {
					t.Fatalf("incomplete PCM transport evidence: %#v", event)
				}
			} else if event["phase"] != "configuration" || event["code"] != "TTS_PROVIDER_NOT_CONFIGURED" || event["sentBytes"] != float64(0) {
				t.Fatalf("configuration failure not diagnosable: %#v", event)
			}
		})
	}
}

func TestPassportTTSDiagnosticsClassifyCancelledAndFailedStreams(t *testing.T) {
	for _, scenario := range []string{"write failure", "cancel", "cancel and write failure"} {
		t.Run(scenario, func(t *testing.T) {
			clearPassportTTSTestEnv(t)
			t.Setenv("GROWDESK_TTS_PROVIDER", "fixture")
			var output bytes.Buffer
			server := &Server{Log: slog.New(slog.NewJSONHandler(&output, nil))}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			errorEvents := 0
			server.streamPassportTTS(ctx, nativeProviderConfig{Mode: "fixture"}, "test_turn", "test_private_reply", func(value any) error {
				if event, ok := value.(Object); ok && event["type"] == "error" {
					errorEvents++
				}
				return nil
			}, func([]byte) error {
				if scenario != "write failure" {
					cancel()
					if scenario == "cancel and write failure" {
						return errors.New("test_private_closed_socket")
					}
					return nil
				}
				return errors.New("test_private_transport_error")
			})
			var event Object
			if err := json.Unmarshal(output.Bytes(), &event); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(output.String(), "test_private") || event["phase"] != "stream" || event["pcmBytes"] != float64(4800) {
				t.Fatalf("unsafe or missing stream diagnostics: %#v", event)
			}
			if scenario != "write failure" {
				if errorEvents != 0 {
					t.Fatal("cancelled turn attempted to send an error")
				}
				expectedBytes, expectedChunks := float64(1920), float64(1)
				if scenario == "cancel and write failure" {
					expectedBytes, expectedChunks = 0, 0
				}
				if event["code"] != "TTS_PROVIDER_CANCELLED" || event["sentBytes"] != expectedBytes || event["chunks"] != expectedChunks {
					t.Fatalf("cancelled transport counted unsent PCM: %#v", event)
				}
			} else if event["code"] != "WS_AUDIO_SEND_FAILED" || event["sentBytes"] != float64(0) || event["chunks"] != float64(0) {
				t.Fatalf("failed write counted as sent: %#v", event)
			}
			if scenario == "write failure" && errorEvents != 1 {
				t.Fatal("live transport failure did not attempt one typed error")
			}
		})
	}
}

func TestPassportPCMPeakHandlesSilenceAndSignedExtremes(t *testing.T) {
	if passportPCMPeak([]byte{0, 0, 0, 0}) != 0 || passportPCMPeak([]byte{255, 127, 0, 128}) != 32768 {
		t.Fatal("PCM amplitude evidence lost signed extrema")
	}
}

func TestPassportVoiceEventDiagnosticsOmitAllContent(t *testing.T) {
	var output bytes.Buffer
	server := &Server{Log: slog.New(slog.NewJSONHandler(&output, nil))}
	server.logPassportVoiceEvent(Object{"type": "asr.final", "text": "test_private_transcript", "turnId": "test_private_turn"})
	server.logPassportVoiceEvent(Object{"type": "assistant.final", "text": "test_private_reply"})
	server.logPassportVoiceEvent(Object{"type": "error", "code": "ASR_PROVIDER_NO_SPEECH", "message": "test_private_message"})
	server.logPassportVoiceEvent(Object{"type": "error", "code": "test_private_raw_error"})
	server.logPassportVoiceEvent(Object{"type": "unknown", "text": "test_private_other"})
	if strings.Contains(output.String(), "test_private") {
		t.Fatal("voice diagnostics logged personal data or arbitrary error text")
	}
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 4 {
		t.Fatalf("unexpected event count: %d", len(lines))
	}
	var last Object
	if err := json.Unmarshal([]byte(lines[3]), &last); err != nil || last["code"] != "UNCLASSIFIED_ERROR" {
		t.Fatalf("untrusted code was not classified: %#v %v", last, err)
	}
}
