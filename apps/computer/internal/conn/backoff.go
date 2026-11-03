package conn

import (
	"errors"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"agentum.dev/computer/internal/protocol"
)

// closeKind is why a session ended, which is the only thing the reconnect loop needs to know.
type closeKind int

const (
	// kindTransient is an ordinary drop: the network went away, the relay restarted, or the
	// relay closed 4408 because it stopped hearing heartbeats. Reconnect normally.
	kindTransient closeKind = iota
	// kindRevoked is terminal. Retrying a revoked credential only hammers the server.
	kindRevoked
	// kindReplaced means a newer connection took this credential over. Redialling quickly
	// makes two clients evict each other forever, so the loser waits a long time.
	kindReplaced
	// kindUnauthorized is a 401 on the upgrade: the credential may be wrong, or the server may
	// be misconfigured. Either way, retry in minutes.
	kindUnauthorized
	// kindBadHello means the server could not read this client's hello. Nothing about that
	// changes on its own, so redialling fast would only be a loop nobody is told about.
	kindBadHello
)

const (
	// maxStep caps the exponential at roughly a minute.
	maxStep = 6
	// slowRetryBase is the floor for a replaced or unauthorised connection.
	slowRetryBase   = 5 * time.Minute
	slowRetrySpread = 150 * time.Second
)

// jitterFunc returns a value in [0, n). Tests inject a deterministic one.
type jitterFunc func(n int64) int64

// upgradeError carries the HTTP status of a failed WebSocket upgrade, which is the only way
// to tell a rejected credential from an unreachable host.
type upgradeError struct {
	status int
	err    error
}

func (e *upgradeError) Error() string {
	if e.status == 0 {
		return e.err.Error()
	}
	return http.StatusText(e.status) + ": " + e.err.Error()
}

func (e *upgradeError) Unwrap() error { return e.err }

// Status reports the HTTP status of the failed upgrade, or zero when there was no response.
func (e *upgradeError) Status() int { return e.status }

func classify(err error) closeKind {
	if err == nil {
		return kindTransient
	}
	var upgrade *upgradeError
	if errors.As(err, &upgrade) && upgrade.status == http.StatusUnauthorized {
		return kindUnauthorized
	}
	switch websocket.CloseStatus(err) {
	case protocol.CloseRevoked:
		return kindRevoked
	case protocol.CloseReplaced:
		return kindReplaced
	case protocol.CloseBadHello:
		return kindBadHello
	default:
		return kindTransient
	}
}

// nextDelay decides how long to wait and what the next backoff step is. It is pure so the
// close-code policy can be tested without a socket.
func nextDelay(kind closeKind, step int, lasted time.Duration, stableAfter time.Duration, jitter jitterFunc) (time.Duration, int) {
	if kind == kindReplaced || kind == kindUnauthorized || kind == kindBadHello {
		// The step is deliberately left alone: a slow retry says nothing about whether the
		// connection would have been healthy.
		return slowRetryBase + time.Duration(jitter(int64(slowRetrySpread))), step
	}
	// Resetting on every open, as the reference implementation did, is what lets two clients
	// sharing one credential evict each other with no backoff at all.
	if lasted >= stableAfter {
		step = 0
	} else if step < maxStep {
		step++
	}
	return backoff(step, jitter), step
}

// backoff is uniform in [0.5c, c] with c = min(1000 * 2^step, 60000) ms.
func backoff(step int, jitter jitterFunc) time.Duration {
	if step < 0 {
		step = 0
	}
	if step > maxStep {
		step = maxStep
	}
	ceiling := time.Duration(1000*(1<<step)) * time.Millisecond
	if ceiling > time.Minute {
		ceiling = time.Minute
	}
	half := ceiling / 2
	return half + time.Duration(jitter(int64(half)+1))
}
