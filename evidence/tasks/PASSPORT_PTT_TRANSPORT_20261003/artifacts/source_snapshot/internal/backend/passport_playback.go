package backend

import (
	"context"
	"sync"
)

type passportPlaybackJob struct{ cancel context.CancelFunc }
type passportPlaybackControl struct {
	mu  sync.Mutex
	job *passportPlaybackJob
}

func (c *passportPlaybackControl) start(ctx context.Context) (context.Context, func()) {
	playbackCtx, cancel := context.WithCancel(ctx)
	job := &passportPlaybackJob{cancel: cancel}
	c.mu.Lock()
	if c.job != nil {
		c.job.cancel()
	}
	c.job = job
	c.mu.Unlock()
	return playbackCtx, func() {
		c.mu.Lock()
		if c.job == job {
			c.job = nil
		}
		c.mu.Unlock()
		cancel()
	}
}

func (c *passportPlaybackControl) stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.job != nil {
		c.job.cancel()
		c.job = nil
	}
}
