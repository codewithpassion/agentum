// Package desktop runs a virtual X display for agents and humans to drive: it supervises Xvfb and
// openbox, captures the screen in-process, and drives input and the clipboard through xdotool and
// xclip.
package desktop

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"agentum.dev/computer/internal/protocol"
	"agentum.dev/computer/internal/runner"
)

// DefaultDisplay is the X display number the desktop takes unless told otherwise.
const DefaultDisplay = 99

// DirName is the desktop's directory inside the state directory. The Xauthority file and the
// Chromium profile live there, so both are as private as the machine credential.
const DirName = "desktop"

// XauthorityFileName is passed to Xvfb with -auth and to every command as XAUTHORITY.
const XauthorityFileName = "Xauthority"

var (
	// ErrUnavailable means the desktop is not running, or its X server is not answering.
	ErrUnavailable = errors.New("the desktop is not running on this computer")
	// ErrBadRequest means a request broke one of the protocol's limits.
	ErrBadRequest = errors.New("bad desktop request")
	// ErrTooLarge means a result would be over the protocol's cap.
	ErrTooLarge = errors.New("desktop result too large")
	// ErrBusy means the op could not start inside its budget because other desktop ops held
	// the desktop. It did not run.
	ErrBusy = errors.New("the desktop is busy")
)

// Timings. Readiness and the Chromium self-test run once, at startup, before hello is sent.
const (
	readyTimeout    = 15 * time.Second
	selfTestTimeout = 45 * time.Second
	restartMin      = time.Second
	restartMax      = 30 * time.Second
	// stableAfter is how long a process must run before its restart backoff resets.
	stableAfter = 30 * time.Second
	// stopGrace is how long a supervised process gets between SIGTERM and SIGKILL.
	stopGrace = 5 * time.Second
)

// screenshotSlots bounds concurrent captures, each of which holds two full frames in memory.
const screenshotSlots = 2

type Options struct {
	StateDir string
	Display  int
	Logger   *slog.Logger
}

// Desktop is a running display. Its methods are safe for concurrent use; input and clipboard ops
// take turns, because two interleaved batches would type into each other.
type Desktop struct {
	display    int
	socket     string
	lockPath   string
	dir        string
	xauthority string
	cookieHex  string
	logger     *slog.Logger

	// turn is the one slot input and clipboard ops share; shots holds the capture slots.
	turn  chan struct{}
	shots chan struct{}
	// xvfbPID is the Xvfb this desktop started, 0 while none runs. The display is only used
	// while its lock file names this process.
	xvfbPID    atomic.Int64
	stop       context.CancelFunc
	supervised sync.WaitGroup
}

func newDesktop(options Options, dir string, cookie []byte) *Desktop {
	return &Desktop{
		display:    options.Display,
		socket:     fmt.Sprintf("/tmp/.X11-unix/X%d", options.Display),
		lockPath:   displayLockPath(options.Display),
		dir:        dir,
		xauthority: filepath.Join(dir, XauthorityFileName),
		cookieHex:  hex.EncodeToString(cookie),
		logger:     options.Logger,
		turn:       make(chan struct{}, 1),
		shots:      make(chan struct{}, screenshotSlots),
		stop:       func() {},
	}
}

// Launch starts the desktop and checks it. On any failure nothing is left running, so there is no
// desktop to hand to agents and no display to put in their environment.
func Launch(ctx context.Context, options Options) (*Desktop, error) {
	desktop, err := Start(ctx, options)
	if err != nil {
		return nil, err
	}
	if err := desktop.Check(ctx); err != nil {
		desktop.Stop()
		return nil, err
	}
	return desktop, nil
}

// Start brings up Xvfb and openbox under supervision until ctx ends or Stop is called. An error
// means there is no desktop at all; a desktop that started may still fail Check.
func Start(ctx context.Context, options Options) (*Desktop, error) {
	if runtime.GOOS != "linux" {
		return nil, fmt.Errorf("the desktop is only supported on Linux, not %s", runtime.GOOS)
	}
	if options.Display <= 0 {
		options.Display = DefaultDisplay
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	for _, binary := range []string{"Xvfb", "openbox"} {
		if _, err := exec.LookPath(binary); err != nil {
			return nil, fmt.Errorf("%s is not installed; see install.sh --desktop for the packages the desktop needs", binary)
		}
	}
	if err := checkDisplayFree(displayLockPath(options.Display), options.Display); err != nil {
		return nil, err
	}
	dir, err := prepareDir(options.StateDir)
	if err != nil {
		return nil, err
	}

	// A fresh cookie per start: anything still holding the last one belongs to a dead server.
	cookie := make([]byte, cookieBytes)
	if _, err := rand.Read(cookie); err != nil {
		return nil, fmt.Errorf("generate the X cookie: %w", err)
	}
	displayNumber := strconv.Itoa(options.Display)
	desktop := newDesktop(options, dir, cookie)
	if err := WriteXauthority(desktop.xauthority, displayNumber, cookie); err != nil {
		return nil, err
	}

	ctx, desktop.stop = context.WithCancel(ctx)
	// No TCP and no abstract socket: the filesystem socket and the cookie are the only way in.
	desktop.supervise(ctx, process{
		name: "Xvfb",
		argv: []string{
			"Xvfb", ":" + displayNumber,
			"-screen", "0", fmt.Sprintf("%dx%dx24", protocol.DesktopWidth, protocol.DesktopHeight),
			"-nolisten", "tcp",
			"-nolisten", "local",
			"-auth", desktop.xauthority,
		},
		running: func(pid int) { desktop.xvfbPID.Store(int64(pid)) },
	})
	// openbox is started only once the display answers; when Xvfb restarts it loses its
	// connection, exits, and comes back through the same wait.
	desktop.supervise(ctx, process{name: "openbox", argv: []string{"openbox"}, before: desktop.waitReady})
	return desktop, nil
}

// prepareDir makes the desktop directory private: it holds the X cookie and the Chromium profile.
func prepareDir(stateDir string) (string, error) {
	dir := filepath.Join(stateDir, DirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create %s: %w", dir, err)
	}
	// MkdirAll leaves an existing directory's mode alone.
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", fmt.Errorf("restrict %s: %w", dir, err)
	}
	return dir, nil
}

// Env is what every command on this computer needs to reach the display.
func (d *Desktop) Env() map[string]string {
	return map[string]string{
		"DISPLAY":    ":" + strconv.Itoa(d.display),
		"XAUTHORITY": d.xauthority,
	}
}

// Stop stops every supervised process and returns once they have all exited.
func (d *Desktop) Stop() {
	d.stop()
	d.supervised.Wait()
}

// Check reports whether the desktop is usable by an agent: the display answers, the input and
// clipboard tools resolve, and Chromium's sandbox starts. The error text is the reason hello
// carries.
func (d *Desktop) Check(ctx context.Context) error {
	readyCtx, cancel := context.WithTimeout(ctx, readyTimeout)
	defer cancel()
	if err := d.waitReady(readyCtx); err != nil {
		return fmt.Errorf("the X server did not answer on :%d within %s", d.display, readyTimeout)
	}
	for _, binary := range []string{"xdotool", "xclip", "chromium"} {
		if _, err := exec.LookPath(binary); err != nil {
			return fmt.Errorf("%s is not on PATH", binary)
		}
	}
	return d.chromiumSelfTest(ctx)
}

// waitReady polls until the display accepts a connection with the cookie.
func (d *Desktop) waitReady(ctx context.Context) error {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		conn, err := d.connect(time.Second)
		if err == nil {
			conn.Close()
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// acquire takes a slot before ctx ends or not at all: an op that cannot start inside its budget
// is refused rather than run after the server has given up on it.
func acquire(ctx context.Context, slots chan struct{}) (release func(), err error) {
	select {
	case slots <- struct{}{}:
		return func() { <-slots }, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("%w: other desktop operations held it for this one's whole budget", ErrBusy)
	}
}

// commandEnv is the scrubbed environment every helper runs with, the same one exec'd commands get.
func (d *Desktop) commandEnv() []string {
	return runner.ScrubbedEnv(d.Env())
}

// Capability turns the outcome of Launch into hello's two desktop fields.
func Capability(err error) (bool, *string) {
	if err == nil {
		return true, nil
	}
	reason := []rune(err.Error())
	if len(reason) > protocol.DesktopReasonMaxChars {
		reason = reason[:protocol.DesktopReasonMaxChars]
	}
	text := string(reason)
	return false, &text
}
