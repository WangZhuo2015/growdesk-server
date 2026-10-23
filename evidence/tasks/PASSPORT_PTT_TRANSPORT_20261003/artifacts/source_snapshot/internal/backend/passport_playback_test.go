package backend

import (
	"context"
	"testing"
)

func TestPassportPlaybackOldCompletionCannotClearCurrentCancellation(t *testing.T) {
	var playback passportPlaybackControl
	old, finishOld := playback.start(context.Background())
	current, finishCurrent := playback.start(context.Background())
	defer finishCurrent()
	if old.Err() != context.Canceled {
		t.Fatal("starting new playback did not cancel the old provider/stream")
	}
	finishOld()
	if current.Err() != nil {
		t.Fatal("old completion cancelled current playback")
	}
	playback.stop()
	if current.Err() != context.Canceled {
		t.Fatal("old completion erased the cancellation handle of current playback")
	}
}
