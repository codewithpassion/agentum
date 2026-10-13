// Package conn owns the socket: it dials the relay, answers requests on it, and decides what
// a close code means for the next attempt.
package conn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"agentum.dev/computer/internal/protocol"
	"agentum.dev/computer/internal/serverurl"
)

// ErrRevoked ends the loop for good; the caller turns it into exit code 3.
var ErrRevoked = errors.New("the machine credential was revoked")

// ConnectPath is the relay's upgrade endpoint.
const ConnectPath = "/api/v1/computers/connect"

const (
	defaultDialTimeout = 20 * time.Second
	// A connection that lasted this long counts as healthy, which is the only thing that
	// resets the backoff step.
	defaultStableAfter = 60 * time.Second
	// The read limit is generous but finite: a relay that sends more than this is broken, and
	// the client should not try to buffer it. Exceeding it closes the socket rather than
	// letting one frame decide how much memory this process uses.
	readLimitBytes = 8 << 20
	writeTimeout   = 30 * time.Second
	// defaultMaxHandlers bounds the frames being worked on at once. One goroutine per inbound
	// frame is unbounded by construction, and a frame can be a quarter of a megabyte.
	defaultMaxHandlers = 64
	// refusalWriteTimeout keeps a queue_full refusal from holding the read loop for long.
	refusalWriteTimeout = 5 * time.Second
)

// Dispatcher answers one request frame. It returns the bytes to write back, or nil to say
// nothing at all. It takes no context on purpose: a request's work is bounded by the daemon's
// life, not by the socket it arrived on, so a reconnect does not kill it.
type Dispatcher func(head protocol.Envelope, frame []byte) []byte

// Preparer runs synchronously on the read loop, before the frame is handed to a goroutine, so
// a cancel arriving on the very next frame cannot overtake the request it names.
type Preparer func(head protocol.Envelope) error

type Options struct {
	BaseURL    string
	Credential string
	Hello      protocol.Hello
	Dispatch   Dispatcher
	// Prepare claims the request id before the work is scheduled. A failure is answered and
	// the frame is not dispatched.
	Prepare Preparer
	// OnDisconnect runs after every session ends, so half-finished uploads can be dropped.
	OnDisconnect func()
	// OnReplyDropped runs when an answer could not be written because its socket had closed.
	// The work is already done and its outcome is now unknown to the server.
	OnReplyDropped func(head protocol.Envelope, cause error)
	// OnRefused releases whatever Prepare claimed for a frame that will not be dispatched.
	OnRefused func(head protocol.Envelope)
	// MaxHandlers bounds the frames being worked on at once; beyond it the client answers
	// queue_full rather than starting a goroutine per frame.
	MaxHandlers int
	Logger      *slog.Logger

	DialTimeout       time.Duration
	HeartbeatInterval time.Duration
	ReadDeadline      time.Duration
	StableAfter       time.Duration
	// Sleep is injected by tests so the reconnect policy can be exercised in milliseconds.
	Sleep func(ctx context.Context, d time.Duration) error
	// Jitter is injected by tests; it returns a value in [0, n).
	Jitter jitterFunc
}

type Client struct {
	options Options
	dialURL string
	logger  *slog.Logger
	// handlers is a counting semaphore over the frames being worked on at once.
	handlers chan struct{}

	// writeMu serialises frame writes: handlers answer from their own goroutines.
	writeMu sync.Mutex
}

func New(options Options) (*Client, error) {
	if options.Dispatch == nil {
		return nil, errors.New("a dispatcher is required")
	}
	if options.Credential == "" {
		return nil, errors.New("a machine credential is required")
	}
	dialURL, err := DialURL(options.BaseURL)
	if err != nil {
		return nil, err
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	if options.DialTimeout <= 0 {
		options.DialTimeout = defaultDialTimeout
	}
	if options.HeartbeatInterval <= 0 {
		options.HeartbeatInterval = protocol.HeartbeatIntervalMS * time.Millisecond
	}
	if options.ReadDeadline <= 0 {
		// Roughly two heartbeats: below that a slow network looks like a dead peer, above it a
		// half-open socket stays invisible.
		options.ReadDeadline = 2*options.HeartbeatInterval + 5*time.Second
	}
	if options.StableAfter <= 0 {
		options.StableAfter = defaultStableAfter
	}
	if options.Sleep == nil {
		options.Sleep = sleepContext
	}
	if options.Jitter == nil {
		// #nosec G404 -- jitter, not a security decision.
		options.Jitter = func(n int64) int64 { return rand.Int63n(max(n, 1)) }
	}
	if options.OnDisconnect == nil {
		options.OnDisconnect = func() {}
	}
	if options.OnReplyDropped == nil {
		options.OnReplyDropped = func(protocol.Envelope, error) {}
	}
	if options.Prepare == nil {
		options.Prepare = func(protocol.Envelope) error { return nil }
	}
	if options.OnRefused == nil {
		options.OnRefused = func(protocol.Envelope) {}
	}
	if options.MaxHandlers <= 0 {
		options.MaxHandlers = defaultMaxHandlers
	}
	return &Client{
		options:  options,
		dialURL:  dialURL,
		logger:   options.Logger,
		handlers: make(chan struct{}, options.MaxHandlers),
	}, nil
}

// DialURL turns a base URL into the WebSocket endpoint. The credential travels in a header,
// never in the URL, so it cannot end up in an access log; plaintext is refused for anything
// but this machine, because the header would then cross the network in the clear.
func DialURL(baseURL string) (string, error) {
	return serverurl.WebSocket(baseURL, ConnectPath)
}

// Run dials until the context ends or the credential is revoked.
func (c *Client) Run(ctx context.Context) error {
	step := 0
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		startedAt := time.Now()
		err := c.session(ctx)
		lasted := time.Since(startedAt)
		if ctx.Err() != nil {
			return ctx.Err()
		}

		kind := classify(err)
		if kind == kindRevoked {
			c.logger.Error("the machine credential was revoked; this computer will not reconnect",
				"lasted_s", lasted.Seconds())
			return ErrRevoked
		}

		var delay time.Duration
		delay, step = nextDelay(kind, step, lasted, c.options.StableAfter, c.options.Jitter)
		c.logReconnect(kind, err, lasted, delay, step)
		if err := c.options.Sleep(ctx, delay); err != nil {
			return err
		}
	}
}

func (c *Client) logReconnect(kind closeKind, err error, lasted time.Duration, delay time.Duration, step int) {
	fields := []any{"error", errorText(err), "lasted_s", lasted.Seconds(), "delay_s", delay.Seconds(), "step", step}
	switch kind {
	case kindReplaced:
		c.logger.Error("another connection took this credential over; waiting before trying again so the two do not evict each other", fields...)
	case kindUnauthorized:
		c.logger.Error("the server refused the machine credential; retrying slowly", fields...)
	case kindBadHello:
		c.logger.Error("the server could not read this computer's hello and closed the connection; check --workdir and this client's version, because retrying will not change it", fields...)
	case kindRevoked, kindTransient:
		c.logger.Warn("disconnected; reconnecting", fields...)
	}
}

func (c *Client) session(parent context.Context) error {
	dialCtx, cancelDial := context.WithTimeout(parent, c.options.DialTimeout)
	socket, response, err := websocket.Dial(dialCtx, c.dialURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + c.options.Credential}},
	})
	cancelDial()
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
			_ = response.Body.Close()
		}
		return &upgradeError{status: status, err: fmt.Errorf("dial %s: %w", c.dialURL, err)}
	}
	socket.SetReadLimit(readLimitBytes)

	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	defer func() {
		_ = socket.CloseNow()
		c.options.OnDisconnect()
	}()
	c.logger.Info("connected", "url", c.dialURL)

	helloFrame, err := json.Marshal(c.options.Hello)
	if err != nil {
		return fmt.Errorf("encode hello: %w", err)
	}
	if err := c.write(ctx, socket, helloFrame); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}

	pong := make(chan struct{}, 8)
	heartbeatCtx, stopHeartbeats := context.WithCancel(ctx)
	defer stopHeartbeats()
	go c.heartbeat(heartbeatCtx, socket, pong)

	for {
		readCtx, cancelRead := context.WithTimeout(ctx, c.options.ReadDeadline)
		kind, payload, err := socket.Read(readCtx)
		cancelRead()
		if err != nil {
			return err
		}
		if kind != websocket.MessageText {
			continue
		}
		switch string(payload) {
		case protocol.HeartbeatPong:
			select {
			case pong <- struct{}{}:
			default:
			}
			continue
		case protocol.HeartbeatPing:
			// The relay answers our pings without waking, and does not send its own; answering
			// one anyway costs nothing and keeps a different relay working.
			if err := c.write(ctx, socket, []byte(protocol.HeartbeatPong)); err != nil {
				return err
			}
			continue
		}
		c.accept(ctx, socket, payload)
	}
}

// accept runs on the read loop. It claims the request id and a worker slot synchronously, so
// a cancel cannot overtake the exec it names and a flood of frames cannot start a goroutine
// each, then hands the work off.
func (c *Client) accept(session context.Context, socket *websocket.Conn, payload []byte) {
	var head protocol.Envelope
	if err := json.Unmarshal(payload, &head); err != nil || head.ID == "" {
		c.logger.Warn("dropping a frame that is not a request", "error", errorText(err))
		return
	}
	if err := c.options.Prepare(head); err != nil {
		c.refuse(session, socket, head, replyCodeFor(err), err.Error())
		return
	}
	select {
	case c.handlers <- struct{}{}:
	default:
		// Refusing on the read loop is the backpressure: the alternative is to keep accepting
		// work this computer has already said it cannot do.
		c.logger.Warn("refusing a frame: too many are already being handled", "id", head.ID, "op", head.Op)
		c.options.OnRefused(head)
		c.refuse(session, socket, head, protocol.ErrQueueFull,
			fmt.Sprintf("this computer is already handling %d requests", c.options.MaxHandlers))
		return
	}
	go func() {
		defer func() { <-c.handlers }()
		c.handle(session, socket, head, payload)
	}()
}

// replyCodeFor lets a refusal name its own wire code without this package having to know
// what the layers above it can fail with.
func replyCodeFor(err error) string {
	var coded interface{ ReplyCode() string }
	if errors.As(err, &coded) {
		return coded.ReplyCode()
	}
	return protocol.ErrBadRequest
}

// refuse answers a frame that will not be dispatched, on the read loop.
func (c *Client) refuse(session context.Context, socket *websocket.Conn, head protocol.Envelope, code string, message string) {
	writeCtx, cancel := context.WithTimeout(session, refusalWriteTimeout)
	defer cancel()
	if err := c.write(writeCtx, socket, protocol.EncodeError(head.ID, code, message)); err != nil {
		c.options.OnReplyDropped(head, err)
	}
}

// heartbeat pings on a timer and closes the socket when two pings go unanswered. Without this
// a half-open socket, which is what a suspended laptop leaves behind, reads as connected.
func (c *Client) heartbeat(ctx context.Context, socket *websocket.Conn, pong <-chan struct{}) {
	ticker := time.NewTicker(c.options.HeartbeatInterval)
	defer ticker.Stop()
	missed := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-pong:
			missed = 0
		case <-ticker.C:
			if err := c.write(ctx, socket, []byte(protocol.HeartbeatPing)); err != nil {
				return
			}
			missed++
			if missed >= 2 {
				c.logger.Warn("no answer to two heartbeats; closing a socket that is probably half open")
				_ = socket.Close(websocket.StatusPolicyViolation, "no heartbeat answer")
				return
			}
		}
	}
}

// handle answers one request on the socket it arrived on. The work is bounded by the daemon's
// context, not the session's, so a reconnect does not kill a command that is already running;
// the reply, by contrast, belongs to this socket. A reply whose socket has closed is dropped
// rather than written to a newer one, so the relay never sees an answer it cannot match; the
// relay may reissue the request, which makes every op at-least-once.
func (c *Client) handle(session context.Context, socket *websocket.Conn, head protocol.Envelope, payload []byte) {
	answer := c.options.Dispatch(head, payload)
	if answer == nil {
		return
	}
	// The platform closes the whole socket on an oversized frame, taking every other request
	// on this computer with it, so an answer that big is refused here instead.
	if len(answer) > protocol.MaxFrameBytes {
		c.logger.Error("refusing to send an oversized reply", "id", head.ID, "bytes", len(answer))
		answer = protocol.EncodeError(head.ID, protocol.ErrFrameTooBig,
			fmt.Sprintf("the reply is %d bytes, over the %d frame limit", len(answer), protocol.MaxFrameBytes))
	}
	if err := c.write(session, socket, answer); err != nil {
		c.options.OnReplyDropped(head, err)
	}
}

func (c *Client) write(ctx context.Context, socket *websocket.Conn, payload []byte) error {
	if len(payload) > protocol.MaxFrameBytes {
		return fmt.Errorf("refusing a %d byte frame, over the %d limit", len(payload), protocol.MaxFrameBytes)
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return socket.Write(writeCtx, websocket.MessageText, payload)
}

func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func errorText(err error) string {
	if err == nil {
		return "clean close"
	}
	return err.Error()
}
