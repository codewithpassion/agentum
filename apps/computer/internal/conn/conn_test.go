package conn_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"agentum.dev/computer/internal/conn"
	"agentum.dev/computer/internal/protocol"
	"agentum.dev/computer/internal/serverurl"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// fakeRelay accepts one socket per dial and runs behave against it. It records the
// Authorization header of every attempt, so the credential's placement is testable.
type fakeRelay struct {
	server *httptest.Server

	mu           sync.Mutex
	dials        int
	authHeaders  []string
	requestPaths []string
	hellos       [][]byte
}

func newFakeRelay(t *testing.T, behave func(t *testing.T, relay *fakeRelay, socket *websocket.Conn)) *fakeRelay {
	t.Helper()
	relay := &fakeRelay{}
	relay.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		relay.mu.Lock()
		relay.dials++
		relay.authHeaders = append(relay.authHeaders, request.Header.Get("Authorization"))
		relay.requestPaths = append(relay.requestPaths, request.URL.RequestURI())
		relay.mu.Unlock()

		socket, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		behave(t, relay, socket)
	}))
	t.Cleanup(relay.server.Close)
	return relay
}

func (r *fakeRelay) snapshot() (dials int, auth []string, paths []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.dials, append([]string(nil), r.authHeaders...), append([]string(nil), r.requestPaths...)
}

func (r *fakeRelay) recordHello(socket *websocket.Conn) {
	_, payload, err := socket.Read(context.Background())
	if err != nil {
		return
	}
	r.mu.Lock()
	r.hellos = append(r.hellos, payload)
	r.mu.Unlock()
}

// recorder captures the delays the reconnect loop asks for and stops it after a budget.
type recorder struct {
	mu     sync.Mutex
	delays []time.Duration
	limit  int
	cancel context.CancelFunc
}

func (r *recorder) sleep(ctx context.Context, d time.Duration) error {
	r.mu.Lock()
	r.delays = append(r.delays, d)
	reached := len(r.delays) >= r.limit
	r.mu.Unlock()
	if reached {
		r.cancel()
		return context.Canceled
	}
	return ctx.Err()
}

func (r *recorder) recorded() []time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]time.Duration(nil), r.delays...)
}

// runBudget bounds every Run in this package. A test that relies on the client deciding to
// stop — which is most of them — hangs for the whole go test timeout when that decision
// regresses, and reports nothing useful. Nothing here calls Run with an unbounded context.
const runBudget = 20 * time.Second

// runBounded starts the client with a deadline and returns its error.
func runBounded(t *testing.T, client *conn.Client) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), runBudget)
	defer cancel()
	return client.Run(ctx)
}

// runBoundedAsync is for tests that drive the relay while the client runs.
func runBoundedAsync(t *testing.T, client *conn.Client) context.CancelFunc {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), runBudget)
	go func() { _ = client.Run(ctx) }()
	return cancel
}

func newClient(t *testing.T, relay *fakeRelay, sleep func(context.Context, time.Duration) error, dispatch conn.Dispatcher) *conn.Client {
	t.Helper()
	if dispatch == nil {
		dispatch = func(head protocol.Envelope, _ []byte) []byte {
			return protocol.EncodeError(head.ID, protocol.ErrUnknownOp, "not implemented in this test")
		}
	}
	client, err := conn.New(conn.Options{
		BaseURL:    relay.server.URL,
		Credential: "mc_secret",
		Hello: protocol.Hello{
			Type:            "hello",
			ProtocolVersion: protocol.Version,
			Hostname:        "test-box",
			OS:              "linux",
			Arch:            "amd64",
			Version:         "0.0.0-test",
			RunAsUser:       "tester",
		},
		Dispatch:          dispatch,
		Logger:            discardLogger(),
		HeartbeatInterval: 50 * time.Millisecond,
		ReadDeadline:      500 * time.Millisecond,
		StableAfter:       time.Hour,
		Sleep:             sleep,
		// Deterministic jitter: always the midpoint of the window.
		Jitter: func(n int64) int64 { return n / 2 },
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	return client
}

func TestDialURLDerivation(t *testing.T) {
	cases := map[string]string{
		"https://agentum.example.com":         "wss://agentum.example.com/api/v1/computers/connect",
		"https://agentum.example.com/":        "wss://agentum.example.com/api/v1/computers/connect",
		"http://127.0.0.1:8787":               "ws://127.0.0.1:8787/api/v1/computers/connect",
		"https://example.com/behind/a/prefix": "wss://example.com/behind/a/prefix/api/v1/computers/connect",
	}
	for input, want := range cases {
		got, err := conn.DialURL(input)
		if err != nil {
			t.Fatalf("DialURL(%q): %v", input, err)
		}
		if got != want {
			t.Fatalf("DialURL(%q) = %q, want %q", input, got, want)
		}
	}
	for _, bad := range []string{"", "   ", "ftp://example.com", "not a url at all::"} {
		if _, err := conn.DialURL(bad); err == nil {
			t.Fatalf("DialURL(%q) was accepted", bad)
		}
	}
}

// The credential goes in a header. A URL ends up in access logs and browser history; a header
// does not.
func TestCredentialTravelsInAHeaderNotTheURL(t *testing.T) {
	relay := newFakeRelay(t, func(_ *testing.T, r *fakeRelay, socket *websocket.Conn) {
		r.recordHello(socket)
		_ = socket.Close(protocol.CloseRevoked, "revoked")
	})
	client := newClient(t, relay, func(context.Context, time.Duration) error { return nil }, nil)
	if err := runBounded(t, client); !errors.Is(err, conn.ErrRevoked) {
		t.Fatalf("run: %v", err)
	}
	_, auth, paths := relay.snapshot()
	if len(auth) == 0 || auth[0] != "Bearer mc_secret" {
		t.Fatalf("Authorization header = %v", auth)
	}
	for _, path := range paths {
		if strings.Contains(path, "mc_secret") {
			t.Fatalf("the credential appeared in the URL: %s", path)
		}
	}
}

func TestHelloCarriesTheProtocolVersion(t *testing.T) {
	relay := newFakeRelay(t, func(_ *testing.T, r *fakeRelay, socket *websocket.Conn) {
		r.recordHello(socket)
		_ = socket.Close(protocol.CloseRevoked, "revoked")
	})
	client := newClient(t, relay, func(context.Context, time.Duration) error { return nil }, nil)
	_ = runBounded(t, client)

	relay.mu.Lock()
	defer relay.mu.Unlock()
	if len(relay.hellos) != 1 {
		t.Fatalf("received %d hellos", len(relay.hellos))
	}
	var hello protocol.Hello
	if err := json.Unmarshal(relay.hellos[0], &hello); err != nil {
		t.Fatalf("decode hello: %v", err)
	}
	if hello.ProtocolVersion != protocol.Version || hello.Type != "hello" || hello.Hostname != "test-box" {
		t.Fatalf("hello = %+v", hello)
	}
}

// 4401 is terminal: one line in the log, exit 3, and no second dial ever.
func TestRevokedIsTerminalAndNeverRetries(t *testing.T) {
	relay := newFakeRelay(t, func(_ *testing.T, r *fakeRelay, socket *websocket.Conn) {
		r.recordHello(socket)
		_ = socket.Close(protocol.CloseRevoked, "revoked")
	})
	slept := 0
	// A budget rather than an unbounded loop: if 4401 is ever misclassified as transient this
	// test must fail, not hang.

	client := newClient(t, relay, func(context.Context, time.Duration) error {
		slept++
		return nil
	}, nil)

	err := runBounded(t, client)
	if !errors.Is(err, conn.ErrRevoked) {
		t.Fatalf("run returned %v, want ErrRevoked", err)
	}
	if slept != 0 {
		t.Fatalf("the loop slept %d times before giving up", slept)
	}
	if dials, _, _ := relay.snapshot(); dials != 1 {
		t.Fatalf("dialled %d times after a revocation", dials)
	}
}

// 4409 means another client has the credential. Redialling quickly makes the two evict each
// other forever, so the wait is at least five minutes.
func TestReplacedBacksOffForMinutes(t *testing.T) {
	relay := newFakeRelay(t, func(_ *testing.T, r *fakeRelay, socket *websocket.Conn) {
		r.recordHello(socket)
		_ = socket.Close(protocol.CloseReplaced, "replaced")
	})
	ctx, cancel := context.WithTimeout(context.Background(), runBudget)
	defer cancel()
	sleeps := &recorder{limit: 3, cancel: cancel}
	client := newClient(t, relay, sleeps.sleep, nil)
	_ = client.Run(ctx)

	delays := sleeps.recorded()
	if len(delays) < 3 {
		t.Fatalf("recorded %d delays", len(delays))
	}
	for index, delay := range delays {
		if delay < 5*time.Minute {
			t.Fatalf("delay %d was %s, under the five minute floor", index, delay)
		}
	}
}

// 4408 is the relay saying it stopped hearing heartbeats. That is an ordinary reconnect.
func TestStaleCloseReconnectsPromptly(t *testing.T) {
	relay := newFakeRelay(t, func(_ *testing.T, r *fakeRelay, socket *websocket.Conn) {
		r.recordHello(socket)
		_ = socket.Close(protocol.CloseStale, "stale")
	})
	ctx, cancel := context.WithTimeout(context.Background(), runBudget)
	defer cancel()
	sleeps := &recorder{limit: 3, cancel: cancel}
	client := newClient(t, relay, sleeps.sleep, nil)
	_ = client.Run(ctx)

	delays := sleeps.recorded()
	if len(delays) < 3 {
		t.Fatalf("recorded %d delays", len(delays))
	}
	if delays[0] > 5*time.Second {
		t.Fatalf("the first reconnect waited %s", delays[0])
	}
	// The exponential still grows while the connection keeps failing quickly.
	if delays[2] <= delays[0] {
		t.Fatalf("the backoff did not grow: %v", delays)
	}
	if dials, _, _ := relay.snapshot(); dials < 3 {
		t.Fatalf("only dialled %d times", dials)
	}
}

// A 401 on the upgrade is not a network blip; hammering it helps nobody.
func TestUnauthorizedUpgradeRetriesSlowly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), runBudget)
	defer cancel()
	sleeps := &recorder{limit: 2, cancel: cancel}
	client, err := conn.New(conn.Options{
		BaseURL:    server.URL,
		Credential: "mc_secret",
		Dispatch:   func(protocol.Envelope, []byte) []byte { return nil },
		Logger:     discardLogger(),
		Sleep:      sleeps.sleep,
		Jitter:     func(n int64) int64 { return n / 2 },
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	_ = client.Run(ctx)

	for index, delay := range sleeps.recorded() {
		if delay < 5*time.Minute {
			t.Fatalf("delay %d was %s, under the five minute floor", index, delay)
		}
	}
}

// A request is answered on the socket it arrived on, and the reply carries the same id.
func TestRequestIsAnsweredOnItsSocket(t *testing.T) {
	answered := make(chan protocol.Reply, 1)
	relay := newFakeRelay(t, func(_ *testing.T, r *fakeRelay, socket *websocket.Conn) {
		r.recordHello(socket)
		request := `{"id":"req-1","op":"cancel","target_id":"nothing"}`
		if err := socket.Write(context.Background(), websocket.MessageText, []byte(request)); err != nil {
			return
		}
		for {
			_, payload, err := socket.Read(context.Background())
			if err != nil {
				return
			}
			if string(payload) == protocol.HeartbeatPing {
				_ = socket.Write(context.Background(), websocket.MessageText, []byte(protocol.HeartbeatPong))
				continue
			}
			var reply protocol.Reply
			if json.Unmarshal(payload, &reply) == nil && reply.ID != "" {
				answered <- reply
				_ = socket.Close(protocol.CloseRevoked, "done")
				return
			}
		}
	})
	dispatch := func(head protocol.Envelope, _ []byte) []byte {
		encoded, err := protocol.EncodeOK(head.ID, protocol.CancelResult{Cancelled: false})
		if err != nil {
			return protocol.EncodeError(head.ID, protocol.ErrOpFailed, err.Error())
		}
		return encoded
	}
	client := newClient(t, relay, func(context.Context, time.Duration) error { return nil }, dispatch)
	defer runBoundedAsync(t, client)()

	select {
	case reply := <-answered:
		if reply.ID != "req-1" || reply.Error != nil {
			t.Fatalf("reply = %+v", reply)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the request was never answered")
	}
}

// An oversized answer is replaced with an error rather than written: the platform enforces the
// frame limit by closing the socket, which would take every other request with it.
func TestOversizedReplyIsRefusedNotSent(t *testing.T) {
	received := make(chan protocol.Reply, 1)
	relay := newFakeRelay(t, func(_ *testing.T, r *fakeRelay, socket *websocket.Conn) {
		r.recordHello(socket)
		socket.SetReadLimit(protocol.PlatformMaxFrameBytes)
		request := `{"id":"req-big","op":"exec","command":"x","cwd":null,"env":{},"timeout_ms":1000}`
		if err := socket.Write(context.Background(), websocket.MessageText, []byte(request)); err != nil {
			return
		}
		for {
			_, payload, err := socket.Read(context.Background())
			if err != nil {
				return
			}
			if string(payload) == protocol.HeartbeatPing {
				continue
			}
			var reply protocol.Reply
			if json.Unmarshal(payload, &reply) == nil && reply.ID != "" {
				received <- reply
				_ = socket.Close(protocol.CloseRevoked, "done")
				return
			}
		}
	})
	dispatch := func(head protocol.Envelope, _ []byte) []byte {
		oversized := make([]byte, protocol.MaxFrameBytes+1024)
		for index := range oversized {
			oversized[index] = 'a'
		}
		return append([]byte(`{"id":"`+head.ID+`","result":{"blob":"`), append(oversized, []byte(`"}}`)...)...)
	}
	client := newClient(t, relay, func(context.Context, time.Duration) error { return nil }, dispatch)
	defer runBoundedAsync(t, client)()

	select {
	case reply := <-received:
		if reply.Error == nil || reply.Error.Code != protocol.ErrFrameTooBig {
			t.Fatalf("reply = %+v", reply)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("nothing came back for the oversized reply")
	}
}

// A socket that stops answering heartbeats is half open; the client has to notice on its own.
func TestHalfOpenSocketIsClosedByTheHeartbeatCheck(t *testing.T) {
	relay := newFakeRelay(t, func(_ *testing.T, r *fakeRelay, socket *websocket.Conn) {
		r.recordHello(socket)
		// Read and answer nothing: the socket stays open and silent.
		for {
			if _, _, err := socket.Read(context.Background()); err != nil {
				return
			}
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), runBudget)
	defer cancel()
	sleeps := &recorder{limit: 2, cancel: cancel}
	client := newClient(t, relay, sleeps.sleep, nil)

	done := make(chan struct{})
	go func() {
		_ = client.Run(ctx)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("a silent socket was never detected")
	}
	if dials, _, _ := relay.snapshot(); dials < 2 {
		t.Fatalf("the client did not reconnect after the silent socket (%d dials)", dials)
	}
}

// One goroutine per inbound frame is unbounded by construction, and a frame can be a quarter
// of a megabyte. Past the cap the client refuses rather than accepting work it cannot do.
func TestFramesBeyondTheHandlerCapAreRefused(t *testing.T) {
	const requests = 6
	replies := make(chan protocol.Reply, requests)
	relay := newFakeRelay(t, func(_ *testing.T, r *fakeRelay, socket *websocket.Conn) {
		r.recordHello(socket)
		for index := range requests {
			frame := fmt.Sprintf(`{"id":"req-%d","op":"exec","command":"x","cwd":null,"env":{},"timeout_ms":60000}`, index)
			if err := socket.Write(context.Background(), websocket.MessageText, []byte(frame)); err != nil {
				return
			}
		}
		for {
			_, payload, err := socket.Read(context.Background())
			if err != nil {
				return
			}
			if string(payload) == protocol.HeartbeatPing {
				continue
			}
			var reply protocol.Reply
			if json.Unmarshal(payload, &reply) == nil && reply.ID != "" {
				replies <- reply
			}
		}
	})

	release := make(chan struct{})
	dispatch := func(head protocol.Envelope, _ []byte) []byte {
		<-release
		encoded, err := protocol.EncodeOK(head.ID, protocol.CancelResult{Cancelled: true})
		if err != nil {
			return protocol.EncodeError(head.ID, protocol.ErrOpFailed, err.Error())
		}
		return encoded
	}
	client, err := conn.New(conn.Options{
		BaseURL:           relay.server.URL,
		Credential:        "mc",
		Dispatch:          dispatch,
		Logger:            discardLogger(),
		MaxHandlers:       2,
		HeartbeatInterval: 50 * time.Millisecond,
		ReadDeadline:      5 * time.Second,
		Sleep:             func(context.Context, time.Duration) error { return nil },
		Jitter:            func(n int64) int64 { return n / 2 },
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), runBudget)
	defer cancel()
	go func() { _ = client.Run(ctx) }()

	// Two frames occupy the handlers; the rest come straight back as queue_full.
	refused := 0
	deadline := time.After(15 * time.Second)
	for refused < requests-2 {
		select {
		case reply := <-replies:
			if reply.Error == nil || reply.Error.Code != protocol.ErrQueueFull {
				t.Fatalf("reply = %+v, want queue_full", reply)
			}
			refused++
		case <-deadline:
			t.Fatalf("only %d frames were refused", refused)
		}
	}
	close(release)
}

// Prepare runs on the read loop; when it refuses, the frame is answered and never dispatched.
func TestAFrameThatPrepareRefusesIsNotDispatched(t *testing.T) {
	answered := make(chan protocol.Reply, 1)
	relay := newFakeRelay(t, func(_ *testing.T, r *fakeRelay, socket *websocket.Conn) {
		r.recordHello(socket)
		frame := `{"id":"dup","op":"exec","command":"x","cwd":null,"env":{},"timeout_ms":1000}`
		if err := socket.Write(context.Background(), websocket.MessageText, []byte(frame)); err != nil {
			return
		}
		for {
			_, payload, err := socket.Read(context.Background())
			if err != nil {
				return
			}
			if string(payload) == protocol.HeartbeatPing {
				continue
			}
			var reply protocol.Reply
			if json.Unmarshal(payload, &reply) == nil && reply.ID != "" {
				answered <- reply
				_ = socket.Close(protocol.CloseRevoked, "done")
				return
			}
		}
	})

	dispatched := make(chan struct{}, 1)
	client, err := conn.New(conn.Options{
		BaseURL:    relay.server.URL,
		Credential: "mc",
		Dispatch: func(protocol.Envelope, []byte) []byte {
			dispatched <- struct{}{}
			return nil
		},
		Prepare:           func(protocol.Envelope) error { return errors.New("already running") },
		Logger:            discardLogger(),
		HeartbeatInterval: 50 * time.Millisecond,
		ReadDeadline:      5 * time.Second,
		Sleep:             func(context.Context, time.Duration) error { return nil },
		Jitter:            func(n int64) int64 { return n / 2 },
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	defer runBoundedAsync(t, client)()

	select {
	case reply := <-answered:
		if reply.Error == nil || reply.Error.Code != protocol.ErrBadRequest {
			t.Fatalf("reply = %+v", reply)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the refused frame was never answered")
	}
	select {
	case <-dispatched:
		t.Fatal("a frame Prepare refused was dispatched anyway")
	default:
	}
}

// Plaintext to a real host would put the bearer credential on the wire in the clear.
func TestPlaintextToARemoteHostIsRefused(t *testing.T) {
	_, err := conn.New(conn.Options{
		BaseURL:    "http://agentum.example.com",
		Credential: "mc",
		Dispatch:   func(protocol.Envelope, []byte) []byte { return nil },
	})
	if !errors.Is(err, serverurl.ErrInsecure) {
		t.Fatalf("error = %v, want ErrInsecure", err)
	}
}

func TestNewRefusesIncompleteOptions(t *testing.T) {
	base := conn.Options{
		BaseURL:    "https://example.com",
		Credential: "c",
		Dispatch:   func(protocol.Envelope, []byte) []byte { return nil },
	}
	withoutDispatch := base
	withoutDispatch.Dispatch = nil
	if _, err := conn.New(withoutDispatch); err == nil {
		t.Fatal("a client without a dispatcher was accepted")
	}
	withoutCredential := base
	withoutCredential.Credential = ""
	if _, err := conn.New(withoutCredential); err == nil {
		t.Fatal("a client without a credential was accepted")
	}
	withoutURL := base
	withoutURL.BaseURL = ""
	if _, err := conn.New(withoutURL); err == nil {
		t.Fatal("a client without a server URL was accepted")
	}
}
