// Package runner executes one shell command per request in its own session and process group,
// so a deadline or a cancel takes every descendant with it.
package runner

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"agentum.dev/computer/internal/protocol"
)

const (
	// ExitTimedOut is the convention for a command killed at its deadline.
	ExitTimedOut = 124
	// ExitKilled is what a command killed by a cancel reports, the same 128+SIGKILL a shell
	// would show, so a cancel that arrived before the command started reads the same way.
	ExitKilled = 137
)

// ErrQueueFull means the waiting room is full; the caller answers the relay rather than
// letting a stalled computer grow an unbounded backlog.
var ErrQueueFull = errors.New("too many commands are already queued")

// ErrDuplicateID means the relay reused a request id that is still running.
var ErrDuplicateID = errors.New("a command with this request id is already running")

type Options struct {
	// BaseContext bounds every command's life. It is the daemon's own context, never a
	// connection's: a reconnect must not kill the work the previous socket started.
	BaseContext context.Context
	// MaxConcurrent mirrors the relay's own cap; the client enforces it too, because a
	// compromised server must not be able to lift it.
	MaxConcurrent int
	MaxQueue      int
	// DefaultTimeout applies when the relay sends no deadline.
	DefaultTimeout time.Duration
	// MaxTimeout caps what the relay may ask for, so one request cannot hold a slot forever.
	MaxTimeout time.Duration
	// WaitDelay bounds Wait once the command has exited, so a grandchild that escaped the
	// group and still holds the pipes cannot hang the request forever.
	WaitDelay time.Duration
	// DefaultCwd is used when the request carries no cwd.
	DefaultCwd string
	// StateDir holds the process-group records the next start sweeps.
	StateDir string
	// BaseEnv is set by the daemon itself, never by the server, such as the desktop's DISPLAY
	// and XAUTHORITY. It joins the scrubbed base, and the request's variables still apply on top.
	BaseEnv map[string]string
	Logger  *slog.Logger
}

// Completion is what happened to one request. Result is the wire shape; Started says whether a
// process ever ran, which is the difference between a command that failed and one that never
// began — the audit log must not record the second as a success.
type Completion struct {
	Result  protocol.ExecResult
	Started bool
	// NotStartedReason is why nothing ran, and is empty once Started is true.
	NotStartedReason string
}

// execution is one request between its reservation and its result.
type execution struct {
	cancel context.CancelFunc
	ctx    context.Context
	// started guards the reserved-but-not-yet-running window, so a cancel that wins the race
	// against the command is not reported as "nothing to cancel".
	started   bool
	cancelled bool
}

type Runner struct {
	options Options
	slots   chan struct{}
	records *records

	mu      sync.Mutex
	queued  int
	running map[string]*execution
}

func New(options Options) *Runner {
	if options.BaseContext == nil {
		options.BaseContext = context.Background()
	}
	if options.MaxConcurrent <= 0 {
		options.MaxConcurrent = 4
	}
	if options.MaxQueue <= 0 {
		options.MaxQueue = 32
	}
	if options.DefaultTimeout <= 0 {
		options.DefaultTimeout = 30 * time.Second
	}
	if options.MaxTimeout <= 0 {
		options.MaxTimeout = 30 * time.Minute
	}
	if options.WaitDelay <= 0 {
		options.WaitDelay = 2 * time.Second
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	return &Runner{
		options: options,
		slots:   make(chan struct{}, options.MaxConcurrent),
		records: newRecords(options.StateDir),
		running: map[string]*execution{},
	}
}

// Reserve claims a request id before the work is handed to a goroutine, so a cancel that
// arrives on the very next frame cannot be answered "unknown" while the command starts anyway.
func (r *Runner) Reserve(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, duplicate := r.running[id]; duplicate {
		return ErrDuplicateID
	}
	ctx, cancel := context.WithCancel(r.options.BaseContext)
	r.running[id] = &execution{cancel: cancel, ctx: ctx}
	return nil
}

// Release drops a reservation that will never be run, so a frame that turns out not to be an
// exec does not leak an entry.
func (r *Runner) Release(id string) {
	r.mu.Lock()
	entry, known := r.running[id]
	delete(r.running, id)
	r.mu.Unlock()
	if known {
		entry.cancel()
	}
}

// Cancel kills a running command, aborts a queued one, or marks a reserved one so it never
// starts. It reports whether the id was known.
func (r *Runner) Cancel(id string) bool {
	r.mu.Lock()
	entry, known := r.running[id]
	if known {
		entry.cancelled = true
	}
	r.mu.Unlock()
	if !known {
		return false
	}
	entry.cancel()
	return true
}

// Shutdown cancels everything in flight and then kills the recorded groups directly. The
// cancel alone is not enough: it only wakes the goroutine that would do the killing, and the
// process can exit before that goroutine is scheduled, leaving the commands reparented to
// PID 1 — which is exactly what the spike measured.
func (r *Runner) Shutdown() {
	r.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(r.running))
	for _, entry := range r.running {
		cancels = append(cancels, entry.cancel)
	}
	r.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	Sweep(r.options.StateDir, r.options.Logger)
}

// InFlight reports how many commands hold a slot, for status output and tests.
func (r *Runner) InFlight() int {
	return len(r.slots)
}

// Queued reports how many commands are waiting for a slot.
func (r *Runner) Queued() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.queued
}

// Run executes one request. The only error it returns is a refusal to accept the work at all;
// everything that happens to the command itself comes back as a result. It takes no context:
// a command's life is bounded by the daemon, not by the socket the request arrived on, so a
// reconnect does not kill work that is already under way.
func (r *Runner) Run(id string, request protocol.ExecRequest) (Completion, error) {
	startedAt := time.Now()

	entry, err := r.claim(id)
	if err != nil {
		return Completion{}, err
	}
	defer func() {
		r.mu.Lock()
		delete(r.running, id)
		r.mu.Unlock()
		entry.cancel()
	}()

	if cancelled := r.markStarted(entry); cancelled {
		return Completion{
			Result: protocol.ExecResult{
				ExitCode:   ExitKilled,
				Stderr:     "cancelled before the command started",
				DurationMS: time.Since(startedAt).Milliseconds(),
			},
			NotStartedReason: "cancelled before the command started",
		}, nil
	}

	// The slot is taken after the id is registered, so a cancel that arrives while the
	// command is still queued removes it instead of being ignored.
	select {
	case r.slots <- struct{}{}:
		r.mu.Lock()
		r.queued--
		r.mu.Unlock()
		defer func() { <-r.slots }()
	case <-entry.ctx.Done():
		r.mu.Lock()
		r.queued--
		r.mu.Unlock()
		return Completion{
			Result: protocol.ExecResult{
				ExitCode:   ExitKilled,
				Stderr:     "cancelled while queued",
				DurationMS: time.Since(startedAt).Milliseconds(),
			},
			NotStartedReason: "cancelled while queued",
		}, nil
	}

	return r.execute(entry.ctx, id, request, startedAt), nil
}

// claim finds the reservation Reserve made, or makes one now for a caller that did not.
func (r *Runner) claim(id string) (*execution, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry, reserved := r.running[id]
	if reserved {
		if entry.started {
			return nil, ErrDuplicateID
		}
	} else {
		ctx, cancel := context.WithCancel(r.options.BaseContext)
		entry = &execution{cancel: cancel, ctx: ctx}
		r.running[id] = entry
	}
	if r.queued >= r.options.MaxQueue {
		// The request is refused either way, so the reservation goes too — otherwise
		// sustained overload leaves an entry and a live context behind for every refusal.
		delete(r.running, id)
		entry.cancel()
		return nil, ErrQueueFull
	}
	r.queued++
	return entry, nil
}

func (r *Runner) markStarted(entry *execution) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry.started = true
	if entry.cancelled {
		r.queued--
		return true
	}
	return false
}

func (r *Runner) execute(ctx context.Context, id string, request protocol.ExecRequest, startedAt time.Time) Completion {
	timeout := time.Duration(request.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = r.options.DefaultTimeout
	}
	if timeout > r.options.MaxTimeout {
		timeout = r.options.MaxTimeout
	}

	command := exec.Command("/bin/sh", "-c", request.Command)
	// Setsid puts the command in its own session and process group, so the group kill reaches
	// descendants that the shell itself backgrounded.
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	command.Dir = r.workingDirectory(request)
	command.Env = ScrubbedEnv(r.commandEnv(request.Env))
	command.WaitDelay = r.options.WaitDelay

	stdout := newCapped(headCap, tailCap)
	stderr := newCapped(headCap, tailCap)
	command.Stdout = stdout
	command.Stderr = stderr

	if err := command.Start(); err != nil {
		return Completion{
			Result: protocol.ExecResult{
				ExitCode:   127,
				Stderr:     err.Error(),
				DurationMS: time.Since(startedAt).Milliseconds(),
			},
			NotStartedReason: err.Error(),
		}
	}
	pgid := command.Process.Pid
	if err := r.records.add(pgid, id, request.Command); err != nil {
		r.options.Logger.Warn("could not record the process group", "error", err.Error(), "pgid", pgid)
	}
	defer r.records.remove(pgid)

	done := make(chan error, 1)
	go func() { done <- command.Wait() }()

	deadline := time.NewTimer(timeout)
	defer deadline.Stop()

	timedOut := false
	select {
	case <-done:
	case <-deadline.C:
		timedOut = true
		killGroup(pgid)
		<-done
	case <-ctx.Done():
		killGroup(pgid)
		<-done
	}

	outText, outTotal, outTruncated := stdout.snapshot()
	errText, errTotal, errTruncated := stderr.snapshot()
	result := protocol.ExecResult{
		Stdout:     outText,
		Stderr:     errText,
		BytesTotal: outTotal + errTotal,
		Truncated:  outTruncated || errTruncated,
		DurationMS: time.Since(startedAt).Milliseconds(),
		ExitCode:   exitCodeOf(command),
	}
	if timedOut {
		result.ExitCode = ExitTimedOut
	}
	return Completion{Result: result, Started: true}
}

// commandEnv layers the request's variables over the daemon's own additions.
func (r *Runner) commandEnv(requested map[string]string) map[string]string {
	if len(r.options.BaseEnv) == 0 {
		return requested
	}
	merged := make(map[string]string, len(r.options.BaseEnv)+len(requested))
	for key, value := range r.options.BaseEnv {
		merged[key] = value
	}
	for key, value := range requested {
		merged[key] = value
	}
	return merged
}

// workingDirectory prefers the directory the caller settled on and falls back to the configured
// default, never to the daemon's own directory.
func (r *Runner) workingDirectory(request protocol.ExecRequest) string {
	if request.Cwd != nil && *request.Cwd != "" {
		return *request.Cwd
	}
	return r.options.DefaultCwd
}

// exitCodeOf reads the exit status from the process rather than from Wait's error, because
// WaitDelay reports a pipe that outlived the command as an error even on a clean exit. A
// signalled command reports 128+signal, which is what a shell and CI both expect.
func exitCodeOf(command *exec.Cmd) int {
	state := command.ProcessState
	if state == nil {
		return 1
	}
	status, ok := state.Sys().(syscall.WaitStatus)
	if !ok {
		return state.ExitCode()
	}
	if status.Signaled() {
		return 128 + int(status.Signal())
	}
	return status.ExitStatus()
}

// ScrubbedEnv builds the command environment: a minimal base plus the request's overrides,
// which the policy has already filtered. The daemon's own environment, and with it the
// machine credential, is never inherited.
func ScrubbedEnv(overrides map[string]string) []string {
	base := map[string]string{
		"PATH": envOr("PATH", "/usr/local/bin:/usr/bin:/bin"),
		"HOME": envOr("HOME", "/tmp"),
		"LANG": envOr("LANG", "C.UTF-8"),
		"TERM": "dumb",
	}
	for key, value := range overrides {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, 0) {
			continue
		}
		base[key] = value
	}
	out := make([]string, 0, len(base))
	for key, value := range base {
		out = append(out, key+"="+value)
	}
	sort.Strings(out)
	return out
}

func envOr(name string, fallback string) string {
	if value, ok := os.LookupEnv(name); ok && value != "" {
		return value
	}
	return fallback
}
