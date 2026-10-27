package agentkit

import (
	"testing"
	"testing/synctest"
	"time"
)

func TestLimiterWindow(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		l := NewLimiter(2, time.Minute)

		for i := range 2 {
			if ok, _ := l.Allow(); !ok {
				t.Fatalf("call %d refused", i)
			}
		}

		time.Sleep(20 * time.Second)
		ok, retryAfter := l.Allow()
		if ok || retryAfter != 40*time.Second {
			t.Fatalf("third call: ok=%v retryAfter=%v", ok, retryAfter)
		}

		time.Sleep(40 * time.Second)
		if ok, _ := l.Allow(); !ok {
			t.Fatal("refused after the window reset")
		}
	})
}
