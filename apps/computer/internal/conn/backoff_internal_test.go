package conn

import (
	"errors"
	"net/http"
	"testing"
	"time"
)

// midpoint makes the policy deterministic: every jittered window resolves to its middle.
func midpoint(n int64) int64 { return n / 2 }

func TestClassify(t *testing.T) {
	if got := classify(nil); got != kindTransient {
		t.Fatalf("a clean close classified as %v", got)
	}
	if got := classify(errors.New("connection reset by peer")); got != kindTransient {
		t.Fatalf("a network error classified as %v", got)
	}
	unauthorized := &upgradeError{status: http.StatusUnauthorized, err: errors.New("bad credential")}
	if got := classify(unauthorized); got != kindUnauthorized {
		t.Fatalf("a 401 upgrade classified as %v", got)
	}
	if unauthorized.Status() != http.StatusUnauthorized {
		t.Fatalf("status = %d", unauthorized.Status())
	}
	// A server that is simply down answers nothing, which is transient.
	unreachable := &upgradeError{status: 0, err: errors.New("no route to host")}
	if got := classify(unreachable); got != kindTransient {
		t.Fatalf("an unreachable host classified as %v", got)
	}
}

// The backoff step only resets after a connection that lasted; resetting on every open is
// what let two clients sharing a credential evict each other with no delay at all.
func TestStepResetsOnlyAfterAStableConnection(t *testing.T) {
	stableAfter := time.Minute
	step := 0
	for range 3 {
		_, step = nextDelay(kindTransient, step, time.Second, stableAfter, midpoint)
	}
	if step != 3 {
		t.Fatalf("step = %d after three quick failures, want 3", step)
	}
	_, step = nextDelay(kindTransient, step, 2*time.Minute, stableAfter, midpoint)
	if step != 0 {
		t.Fatalf("step = %d after a stable connection, want 0", step)
	}
}

func TestTransientBackoffGrowsAndIsCapped(t *testing.T) {
	step := 0
	var previous time.Duration
	for attempt := range 12 {
		var delay time.Duration
		delay, step = nextDelay(kindTransient, step, time.Second, time.Minute, midpoint)
		if delay <= 0 {
			t.Fatalf("attempt %d produced a %s delay", attempt, delay)
		}
		if delay > time.Minute {
			t.Fatalf("attempt %d produced %s, over the one minute cap", attempt, delay)
		}
		if attempt > 0 && attempt <= maxStep && delay < previous {
			t.Fatalf("attempt %d shrank from %s to %s", attempt, previous, delay)
		}
		previous = delay
	}
}

// A replaced or unauthorised connection waits minutes, and does not disturb the exponential
// step, which describes a different kind of failure.
func TestSlowRetriesAreAtLeastFiveMinutes(t *testing.T) {
	for _, kind := range []closeKind{kindReplaced, kindUnauthorized} {
		delay, step := nextDelay(kind, 2, time.Hour, time.Minute, midpoint)
		if delay < slowRetryBase {
			t.Fatalf("%v waited %s, under the floor", kind, delay)
		}
		if delay > slowRetryBase+slowRetrySpread {
			t.Fatalf("%v waited %s, over the window", kind, delay)
		}
		if step != 2 {
			t.Fatalf("%v moved the exponential step to %d", kind, step)
		}
	}
}

func TestBackoffWindowIsHalfToFullCeiling(t *testing.T) {
	floor := backoff(3, func(int64) int64 { return 0 })
	ceiling := backoff(3, func(n int64) int64 { return n - 1 })
	if floor != 4*time.Second {
		t.Fatalf("floor = %s, want 4s", floor)
	}
	if ceiling < 7900*time.Millisecond || ceiling > 8*time.Second {
		t.Fatalf("ceiling = %s, want just under 8s", ceiling)
	}
	if got := backoff(99, midpoint); got > time.Minute {
		t.Fatalf("an out of range step produced %s", got)
	}
	if got := backoff(-1, midpoint); got <= 0 || got > time.Second {
		t.Fatalf("a negative step produced %s", got)
	}
}
