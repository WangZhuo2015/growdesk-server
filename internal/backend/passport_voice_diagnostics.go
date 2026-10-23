package backend

import (
	"context"
	"strings"
	"time"
)

// Speech diagnostics deliberately contain only stage, typed status and numeric
// transport evidence. Do not add transcript, reply, credentials or raw errors.
type passportSpeechDiagnostic struct {
	phase         string
	code          string
	provider      string
	pcmBytes      int
	sentBytes     int
	chunks        int
	peakAmplitude int
	started       time.Time
}

func (s *Server) logPassportVoiceEvent(value any) {
	if s.Log == nil {
		return
	}
	event, ok := value.(Object)
	if !ok {
		return
	}
	typeName, _ := event["type"].(string)
	switch typeName {
	case "asr.final", "assistant.final":
		content, _ := event["text"].(string)
		s.Log.Info("passport voice event", "type", typeName, "textBytes", len(content))
	case "error":
		code, _ := event["code"].(string)
		s.Log.Info("passport voice event", "type", typeName, "code", safePassportVoiceCode(code))
	}
}

func safePassportVoiceCode(code string) string {
	if len(code) == 0 || len(code) > 64 {
		return "UNCLASSIFIED_ERROR"
	}
	for _, character := range code {
		if (character < 'A' || character > 'Z') && (character < '0' || character > '9') && character != '_' {
			return "UNCLASSIFIED_ERROR"
		}
	}
	for _, prefix := range []string{"ASR_", "AI_", "TTS_", "WS_", "QUERY_", "VOICE_", "CARD_", "INVALID_", "DEVICE_", "BABY_SCOPE_"} {
		if strings.HasPrefix(code, prefix) {
			return code
		}
	}
	switch code {
	case "UNAUTHORIZED", "FORBIDDEN", "TOKEN_EXPIRED":
		return code
	}
	return "UNCLASSIFIED_ERROR"
}

func (diagnostic *passportSpeechDiagnostic) failure(phase string, err error) {
	diagnostic.phase = phase
	diagnostic.code, _ = passportTTSErrorEvent("", err)["code"].(string)
}

func (diagnostic *passportSpeechDiagnostic) sendFailure(ctx context.Context, phase string) {
	if ctx.Err() != nil {
		diagnostic.failure(phase, ctx.Err())
		return
	}
	diagnostic.phase, diagnostic.code = phase, "WS_AUDIO_SEND_FAILED"
}

func (s *Server) logPassportSpeechOutcome(diagnostic *passportSpeechDiagnostic) {
	if s.Log == nil {
		return
	}
	s.Log.Info("passport speech outcome", "phase", diagnostic.phase,
		"code", diagnostic.code, "provider", diagnostic.provider,
		"pcmBytes", diagnostic.pcmBytes, "sentBytes", diagnostic.sentBytes,
		"chunks", diagnostic.chunks, "peakAmplitude", diagnostic.peakAmplitude,
		"elapsedMs", time.Since(diagnostic.started).Milliseconds())
}

func passportPCMPeak(pcm []byte) int {
	peak := 0
	for offset := 0; offset+1 < len(pcm); offset += 2 {
		sample := int(int16(uint16(pcm[offset]) | uint16(pcm[offset+1])<<8))
		if sample < 0 {
			sample = -sample
		}
		if sample > peak {
			peak = sample
		}
	}
	return peak
}
