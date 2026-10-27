package api

import (
	"testing"
	"testing/synctest"
	"time"
)

func TestLimiterWindow(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		l := newLimiter(2, time.Minute)

		for i := range 2 {
			if ok, _ := l.allow(); !ok {
				t.Fatalf("call %d refused", i)
			}
		}

		time.Sleep(20 * time.Second)
		ok, retryAfter := l.allow()
		if ok || retryAfter != 40*time.Second {
			t.Fatalf("third call: ok=%v retryAfter=%v", ok, retryAfter)
		}

		time.Sleep(40 * time.Second)
		if ok, _ := l.allow(); !ok {
			t.Fatal("refused after the window reset")
		}
	})
}
