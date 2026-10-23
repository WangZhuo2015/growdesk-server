package backend

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateASRTranscriptRejectsTextWithoutLettersOrNumbers(t *testing.T) {
	for _, transcript := range []string{"", " \t\n", "，。？！", "…—!?", "👶💛", "\u0301\u0308"} {
		t.Run(transcript, func(t *testing.T) {
			got, err := validateASRTranscript(transcript)
			var providerErr *nativeProviderError
			if got != "" || !errors.As(err, &providerErr) || providerErr.Code != "ASR_PROVIDER_NO_SPEECH" {
				t.Fatalf("validateASRTranscript(%q) = %q, %v; want ASR_PROVIDER_NO_SPEECH", transcript, got, err)
			}
		})
	}
}

func TestValidateASRTranscriptPreservesShortUnicodeTextAndPunctuation(t *testing.T) {
	for _, transcript := range []string{
		"宝宝喝了120毫升奶，请记录一次。",
		"Dose: 1.5 mL, please record!",
		"  １２３  ",
	} {
		t.Run(transcript, func(t *testing.T) {
			got, err := validateASRTranscript(transcript)
			if err != nil || got != transcript {
				t.Fatalf("validateASRTranscript(%q) = %q, %v; want the original text unchanged", transcript, got, err)
			}
		})
	}
}

func TestValidateASRTranscriptStillRejectsOversizedProviderText(t *testing.T) {
	got, err := validateASRTranscript(strings.Repeat("x", 256*1024+1))
	var providerErr *nativeProviderError
	if got != "" || !errors.As(err, &providerErr) || providerErr.Code != "ASR_PROVIDER_INVALID_RESPONSE" {
		t.Fatalf("oversized transcript returned %d bytes, %v; want ASR_PROVIDER_INVALID_RESPONSE", len(got), err)
	}
}
