package api

import (
	"sync"
	"time"
)

// limiter is a fixed-window counter shared by every caller. The agent has a
// single legitimate client, so per-caller buckets would add nothing: the point
// is to bound how often a compromised panel can bounce the server.
type limiter struct {
	mu          sync.Mutex
	max         int
	window      time.Duration
	windowStart time.Time
	count       int
}

func newLimiter(max int, window time.Duration) *limiter {
	return &limiter{max: max, window: window}
}

// allow consumes one slot, or reports how long until the window resets.
func (l *limiter) allow() (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	if now.Sub(l.windowStart) >= l.window {
		l.windowStart = now
		l.count = 0
	}
	if l.count >= l.max {
		return false, l.window - now.Sub(l.windowStart)
	}
	l.count++
	return true, 0
}
