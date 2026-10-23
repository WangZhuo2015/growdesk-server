package backend

import (
	"context"
	"errors"
	"fmt"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPassportAudioEndMustMatchActiveRecording(t *testing.T) {
	for _, id := range []string{"", "test_active"} {
		got, err := passportAudioEndTurn("test_active", id)
		if got != "test_active" || err != nil {
			t.Fatal("valid end rejected", got, err)
		}
	}
	if _, err := passportAudioEndTurn("test_active", "test_other"); err == nil {
		t.Fatal("mismatched audio end relabeled recording")
	}
}

func TestPassportSocketRejectsOversizedMessageBeforeReadingBody(t *testing.T) {
	done := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		configurePassportSocket(conn)
		_, _, err = conn.ReadMessage()
		done <- err
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err = conn.WriteMessage(websocket.BinaryMessage, make([]byte, passportMaxFrameBytes+1)); err != nil {
		t.Fatal(err)
	}
	if err = <-done; !errors.Is(err, websocket.ErrReadLimit) {
		t.Fatal("oversized frame read without the transport budget", err)
	}
}

func TestPassportReplayIsBoundedAndRejectsBadIDs(t *testing.T) {
	var replay passportReplay
	if _, err := replay.accept(strings.Repeat("x", 65)); err == nil {
		t.Fatal("oversized ID accepted")
	}
	for n := 0; n < passportReplayWindow*3; n++ {
		id := fmt.Sprintf("test_turn_%d", n)
		ok, err := replay.accept(id)
		if !ok || err != nil {
			t.Fatal("new turn rejected", err)
		}
		if dup, _ := replay.accept(id); dup {
			t.Fatal("duplicate turn accepted")
		}
		if len(replay.ids) > passportReplayWindow {
			t.Fatal("unbounded replay state")
		}
	}
}

func TestPassportTurnReplacementPreventsStalePublication(t *testing.T) {
	var gate passportTurnGate
	old := gate.replace(context.Background())
	current := gate.replace(context.Background())
	defer gate.stop()
	if err := old.publish(old.ctx, func() error { t.Fatal("old turn published a reply/proposal"); return nil }); err != context.Canceled {
		t.Fatal("old turn was not cancelled", err)
	}
	called := false
	if err := current.publish(current.ctx, func() error { called = true; return nil }); err != nil || !called {
		t.Fatal("current reply rejected", err)
	}
	gate.stop()
	if err := current.publish(context.Background(), func() error { t.Fatal("stopped turn published"); return nil }); err != context.Canceled {
		t.Fatal("stopped turn accepted", err)
	}
}

func TestPassportTurnReplacementWaitsForInFlightPublication(t *testing.T) {
	var gate passportTurnGate
	old := gate.replace(context.Background())
	defer gate.stop()
	entered, release := make(chan struct{}), make(chan struct{})
	published, replaced := make(chan error, 1), make(chan *passportTurnTicket, 1)
	go func() {
		published <- old.publish(old.ctx, func() error { close(entered); <-release; return nil })
	}()
	<-entered
	go func() { replaced <- gate.replace(context.Background()) }()
	select {
	case <-replaced:
		close(release)
		t.Fatal("replacement invalidated a reply while publication held the gate")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	if err := <-published; err != nil {
		t.Fatal(err)
	}
	select {
	case current := <-replaced:
		if old.ctx.Err() != context.Canceled || current.ctx.Err() != nil {
			t.Fatal("turn replacement did not transfer ownership")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("replacement remained stuck after publication")
	}
}
