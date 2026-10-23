package backend

import (
	"context"
	"github.com/gorilla/websocket"
	"sync"
)

const passportMaxFrameBytes = 16 * 1024
const passportReplayWindow = 128

func configurePassportSocket(conn *websocket.Conn) { conn.SetReadLimit(passportMaxFrameBytes) }

func passportAudioEndTurn(current, requested string) (string, error) {
	if requested == "" {
		requested = current
	}
	if current == "" || requested != current {
		return "", invalid("Audio end does not match the active recording")
	}
	return current, nil
}

type passportReplay struct{ ids []string }

func (r *passportReplay) accept(id string) (bool, error) {
	if len(id) == 0 || len(id) > 64 {
		return false, invalid("Voice turn ID must contain 1 to 64 bytes")
	}
	for _, seen := range r.ids {
		if seen == id {
			return false, nil
		}
	}
	if len(r.ids) == passportReplayWindow {
		r.ids = r.ids[1:]
	}
	r.ids = append(r.ids, id)
	return true, nil
}

type passportTurnGate struct {
	mu      sync.Mutex
	current *passportTurnTicket
}
type passportTurnTicket struct {
	gate   *passportTurnGate
	ctx    context.Context
	cancel context.CancelFunc
}

func (g *passportTurnGate) replace(ctx context.Context) *passportTurnTicket {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.current != nil {
		g.current.cancel()
	}
	turnCtx, cancel := context.WithCancel(ctx)
	t := &passportTurnTicket{gate: g, ctx: turnCtx, cancel: cancel}
	g.current = t
	return t
}

func (g *passportTurnGate) stop() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.current != nil {
		g.current.cancel()
		g.current = nil
	}
}

// Serialize publishing a reply/proposal against replacement by a new recording.
func (t *passportTurnTicket) publish(ctx context.Context, fn func() error) error {
	t.gate.mu.Lock()
	defer t.gate.mu.Unlock()
	if t.gate.current != t || t.ctx.Err() != nil {
		return context.Canceled
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return fn()
}
