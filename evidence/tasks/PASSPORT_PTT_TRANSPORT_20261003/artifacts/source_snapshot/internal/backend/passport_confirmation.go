package backend

import (
	"errors"
	"sync/atomic"
)

// passportPending publishes immutable proposals between voice workers and the
// WebSocket reader. A completed confirmation must only clear its own snapshot,
// never a replacement proposal published while the database transaction ran.
type passportPending[T any] struct {
	value atomic.Pointer[T]
}

func (p *passportPending[T]) store(value *T) {
	p.value.Store(value)
}

func (p *passportPending[T]) load() *T {
	return p.value.Load()
}

func (p *passportPending[T]) clear(confirmed *T) bool {
	return p.value.CompareAndSwap(confirmed, nil)
}

// A Passport card displays one action. Require the exact actionIds array sent
// by the device rather than silently substituting the pending action for a
// missing or misspelled property. The returned ID is always server-canonical.
func passportConfirmedActionID(raw any, expected string) (string, error) {
	ids, ok := raw.([]any)
	if !ok || len(ids) != 1 {
		return "", errors.New("exactly one proposed action ID is required")
	}
	id, ok := ids[0].(string)
	if !ok || expected == "" || id != expected {
		return "", errors.New("confirmed action does not match the presented proposal")
	}
	return expected, nil
}
