//go:build !linux

package backend

import (
	"context"
	"io"
	"time"
)

func platformPassportTTSLocalConfiguration(time.Duration) (localPassportTTSConfig, error) {
	return localPassportTTSConfig{}, passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "Local eSpeak speech synthesis requires Linux resource limits", false)
}

func platformPassportTTSLocalSherpaConfiguration(time.Duration) (localPassportTTSConfig, error) {
	return localPassportTTSConfig{}, passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "Local Sherpa speech synthesis requires Linux resource limits", false)
}

func runLocalPassportTTSStep(context.Context, localPassportTTSConfig, string, []string, io.Reader, *localPassportTTSBoundedWriter, string) error {
	return passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "Local speech synthesis requires Linux resource limits", false)
}
