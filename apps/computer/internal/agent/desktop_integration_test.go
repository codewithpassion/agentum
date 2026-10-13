//go:build desktop_integration

// These run inside the desktop image, against a real Xvfb, xdotool, xclip and Chromium:
// `bun run --cwd apps/computer test:desktop-image`.
package agent_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"

	"agentum.dev/computer/internal/agent"
	"agentum.dev/computer/internal/audit"
	"agentum.dev/computer/internal/desktop"
	"agentum.dev/computer/internal/files"
	"agentum.dev/computer/internal/policy"
	"agentum.dev/computer/internal/protocol"
	"agentum.dev/computer/internal/runner"
)

// launchDesktop brings a desktop up in a fresh state directory the way the daemon does, and
// returns what the daemon hands to its agent and puts in hello.
func launchDesktop(t *testing.T) (*desktop.Desktop, string, error) {
	t.Helper()
	stateDir := t.TempDir()
	screen, err := desktop.Launch(context.Background(), desktop.Options{StateDir: stateDir, Logger: discardLogger()})
	if screen != nil {
		t.Cleanup(screen.Stop)
	}
	return screen, stateDir, err
}

func processRunning(name string) bool {
	return exec.Command("pgrep", "-x", name).Run() == nil
}

func newDesktopHarness(t *testing.T, screen *desktop.Desktop, stateDir string) *harness {
	t.Helper()
	workdir := filepath.Join(stateDir, "sessions")
	if err := os.MkdirAll(workdir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	rules, err := policy.New(policy.Options{Workdir: workdir, StateDir: stateDir, SessionsDir: workdir})
	if err != nil {
		t.Fatalf("policy: %v", err)
	}
	log, err := audit.Open(stateDir, audit.Options{})
	if err != nil {
		t.Fatalf("audit: %v", err)
	}
	t.Cleanup(func() { _ = log.Close() })
	commands := runner.New(runner.Options{StateDir: stateDir, DefaultCwd: workdir, BaseEnv: screen.Env(), Logger: discardLogger()})
	t.Cleanup(commands.Shutdown)
	return &harness{
		agent:    agent.New(rules, commands, files.NewTransfers(files.Options{ResolveWrite: rules.CheckWrite}), screen, log, discardLogger()),
		commands: commands,
		stateDir: stateDir,
		workdir:  workdir,
	}
}

func (h *harness) exec(t *testing.T, id string, command string) protocol.ExecResult {
	t.Helper()
	return execResultOf(t, h.dispatch(t, id, protocol.OpExec, map[string]any{
		"command": command, "cwd": nil, "env": map[string]string{}, "timeout_ms": 10_000,
	}))
}

func (h *harness) screenshot(t *testing.T) image.Image {
	t.Helper()
	reply := h.dispatch(t, "shot-"+time.Now().Format("150405.000000"), protocol.OpDesktopScreenshot, map[string]any{"quality": nil})
	if reply.Error != nil {
		t.Fatalf("screenshot: %+v", reply.Error)
	}
	var result protocol.DesktopScreenshotResult
	if err := json.Unmarshal(reply.Result, &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(result.DataB64)
	if err != nil {
		t.Fatalf("decode base64: %v", err)
	}
	frame, err := jpeg.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("decode jpeg: %v", err)
	}
	if result.MediaType != "image/jpeg" || result.Width != 1280 || result.Height != 800 {
		t.Fatalf("result = %d x %d %s", result.Width, result.Height, result.MediaType)
	}
	if bounds := frame.Bounds(); bounds.Dx() != 1280 || bounds.Dy() != 800 {
		t.Fatalf("decoded to %v", bounds)
	}
	return frame
}

func (h *harness) input(t *testing.T, actions ...map[string]any) {
	t.Helper()
	list := make([]any, 0, len(actions))
	for _, action := range actions {
		list = append(list, action)
	}
	reply := h.dispatch(t, "input-"+time.Now().Format("150405.000000"), protocol.OpDesktopInput, map[string]any{"actions": list})
	if reply.Error != nil {
		t.Fatalf("input: %+v", reply.Error)
	}
}

func (h *harness) clipboard(t *testing.T) string {
	t.Helper()
	reply := h.dispatch(t, "get-"+time.Now().Format("150405.000000"), protocol.OpDesktopClipboardGet, map[string]any{})
	if reply.Error != nil {
		t.Fatalf("clipboard_get: %+v", reply.Error)
	}
	var result protocol.DesktopClipboardGetResult
	if err := json.Unmarshal(reply.Result, &result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return result.Text
}

// changedPixels counts pixels that differ by more than JPEG noise.
func changedPixels(a image.Image, b image.Image) int {
	changed := 0
	bounds := a.Bounds()
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			ar, ag, ab, _ := a.At(x, y).RGBA()
			br, bg, bb, _ := b.At(x, y).RGBA()
			if distance(ar, br)+distance(ag, bg)+distance(ab, bb) > 3*0x2000 {
				changed++
			}
		}
	}
	return changed
}

func distance(a uint32, b uint32) uint32 {
	if a > b {
		return a - b
	}
	return b - a
}

// pointer is where xdotool, a client independent of the daemon, says the pointer is.
func (h *harness) pointer(t *testing.T) string {
	t.Helper()
	result := h.exec(t, "pointer", `xdotool getmouselocation --shell | grep -E '^(X|Y)=' | tr '\n' ' '`)
	if result.ExitCode != 0 {
		t.Fatalf("getmouselocation: %+v", result)
	}
	return strings.TrimSpace(result.Stdout)
}

// buttonRecorder is an X client of its own: a full-screen override-redirect window that logs
// every button press and release the server delivers, by X button number.
type buttonRecorder struct {
	conn   *xgb.Conn
	window xproto.Window
	mu     sync.Mutex
	events []string
}

func recordButtons(t *testing.T, env map[string]string) *buttonRecorder {
	t.Helper()
	t.Setenv("DISPLAY", env["DISPLAY"])
	t.Setenv("XAUTHORITY", env["XAUTHORITY"])
	conn, err := xgb.NewConn()
	if err != nil {
		t.Fatalf("connect the recorder: %v", err)
	}
	screen := xproto.Setup(conn).DefaultScreen(conn)
	window, err := xproto.NewWindowId(conn)
	if err != nil {
		t.Fatalf("window id: %v", err)
	}
	err = xproto.CreateWindowChecked(conn, screen.RootDepth, window, screen.Root, 0, 0,
		protocol.DesktopWidth, protocol.DesktopHeight, 0, xproto.WindowClassInputOutput, screen.RootVisual,
		xproto.CwOverrideRedirect|xproto.CwEventMask,
		[]uint32{1, xproto.EventMaskButtonPress | xproto.EventMaskButtonRelease}).Check()
	if err != nil {
		t.Fatalf("create the recorder window: %v", err)
	}
	if err := xproto.MapWindowChecked(conn, window).Check(); err != nil {
		t.Fatalf("map the recorder window: %v", err)
	}
	recorder := &buttonRecorder{conn: conn, window: window}
	go func() {
		for {
			event, err := conn.WaitForEvent()
			if event == nil && err == nil {
				return
			}
			recorder.mu.Lock()
			switch e := event.(type) {
			case xproto.ButtonPressEvent:
				recorder.events = append(recorder.events, fmt.Sprintf("press %d", e.Detail))
			case xproto.ButtonReleaseEvent:
				recorder.events = append(recorder.events, fmt.Sprintf("release %d", e.Detail))
			}
			recorder.mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		_ = xproto.DestroyWindowChecked(conn, window).Check()
		conn.Close()
	})
	return recorder
}

func (r *buttonRecorder) take() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	events := r.events
	r.events = nil
	return events
}

// expect waits for exactly the given events, in order.
func (r *buttonRecorder) expect(t *testing.T, want ...string) {
	t.Helper()
	var got []string
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && len(got) < len(want) {
		time.Sleep(50 * time.Millisecond)
		got = append(got, r.take()...)
	}
	time.Sleep(100 * time.Millisecond)
	got = append(got, r.take()...)
	if strings.Join(got, ", ") != strings.Join(want, ", ") {
		t.Fatalf("X saw   %v\n want %v", got, want)
	}
}

// colourAt averages a 9x9 block, which smooths JPEG noise on a flat area.
func colourAt(frame image.Image, x int, y int) (int, int, int) {
	var red, green, blue uint32
	for dy := -4; dy <= 4; dy++ {
		for dx := -4; dx <= 4; dx++ {
			r, g, b, _ := frame.At(x+dx, y+dy).RGBA()
			red, green, blue = red+r>>8, green+g>>8, blue+b>>8
		}
	}
	return int(red / 81), int(green / 81), int(blue / 81)
}

func near(got int, want int) bool {
	return got >= want-24 && got <= want+24
}

func waitUntil(t *testing.T, what string, timeout time.Duration, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func TestDesktopEndToEnd(t *testing.T) {
	if os.Getenv("AGENTUM_DESKTOP_EXPECT_SANDBOX") == "refused" {
		t.Skip("this run checks the refusal only")
	}
	screen, stateDir, err := launchDesktop(t)
	// Launch covers the X server answering, xdotool and xclip resolving, and Chromium's sandbox
	// self-test: this is the capability the daemon reports.
	if ok, reason := desktop.Capability(err); !ok {
		t.Fatalf("the desktop is not available: %s", *reason)
	}
	h := newDesktopHarness(t, screen, stateDir)
	xauthority := screen.Env()["XAUTHORITY"]

	t.Run("Xvfb runs with -auth and only its filesystem socket", func(t *testing.T) {
		result := h.exec(t, "ps", "ps -eo args | grep '^Xvfb'")
		want := "Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -nolisten local -auth " + xauthority
		if !strings.Contains(result.Stdout, want) {
			t.Fatalf("Xvfb command line = %q, want %q", result.Stdout, want)
		}
		// The abstract socket ignores file permissions and is shared by everything in the
		// network namespace; only the filesystem socket may listen.
		sockets := h.exec(t, "sockets", "grep X11-unix/X99 /proc/net/unix")
		if strings.Contains(sockets.Stdout, "@/tmp/.X11-unix/X99") || !strings.Contains(sockets.Stdout, " /tmp/.X11-unix/X99") {
			t.Fatalf("X sockets:\n%s", sockets.Stdout)
		}
		info, err := os.Stat(xauthority)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("Xauthority = %v, %v", info, err)
		}
		dir, err := os.Stat(filepath.Dir(xauthority))
		if err != nil || dir.Mode().Perm() != 0o700 {
			t.Fatalf("desktop directory = %v, %v; want 0700", dir, err)
		}
		// Without the cookie the display refuses the client.
		refused := h.exec(t, "nocookie", "XAUTHORITY=/dev/null xdotool getmouselocation")
		if refused.ExitCode == 0 {
			t.Fatalf("a client without the cookie reached the display: %+v", refused)
		}
		allowed := h.exec(t, "cookie", "xdotool getmouselocation")
		if allowed.ExitCode != 0 {
			t.Fatalf("a client with the cookie was refused: %+v", allowed)
		}
	})

	// First, while no other window is up. xterm asks the server for the colour through Xlib, so
	// the screenshot's decoding is checked against a client that shares none of its code.
	t.Run("screenshot colours match what an X client drew", func(t *testing.T) {
		h.exec(t, "xterm-colour", "xterm -class TFColour -bg '#c83210' -fg '#c83210' -geometry 40x12+100+100 >/dev/null 2>&1 &")
		t.Cleanup(func() { h.exec(t, "xterm-colour-kill", "pkill -f TFColour") })
		var geometry string
		waitUntil(t, "the coloured xterm", 10*time.Second, func() bool {
			result := h.exec(t, "geometry", "xdotool search --onlyvisible --class TFColour getwindowgeometry --shell | grep -E '^(X|Y|WIDTH|HEIGHT)=' | tr '\\n' ' '")
			geometry = result.Stdout
			return result.ExitCode == 0 && strings.Contains(geometry, "WIDTH=")
		})
		var x, y, width, height int
		if _, err := fmt.Sscanf(geometry, "X=%d Y=%d WIDTH=%d HEIGHT=%d", &x, &y, &width, &height); err != nil {
			t.Fatalf("geometry %q: %v", geometry, err)
		}
		time.Sleep(500 * time.Millisecond)
		red, green, blue := colourAt(h.screenshot(t), x+width/2, y+height/2)
		if !near(red, 0xc8) || !near(green, 0x32) || !near(blue, 0x10) {
			t.Fatalf("the middle of the xterm reads as rgb(%d, %d, %d), want about rgb(200, 50, 16)", red, green, blue)
		}
	})

	t.Run("input reaches X as the contract says", func(t *testing.T) {
		before := h.pointer(t)
		if before == "X=100 Y=150" {
			t.Fatalf("the pointer already starts where the click goes")
		}
		recorder := recordButtons(t, screen.Env())

		h.input(t, map[string]any{"type": "click", "x": 100, "y": 150, "button": "left", "count": 2})
		if after := h.pointer(t); after != "X=100 Y=150" {
			t.Fatalf("pointer after the click = %q (was %q), want X=100 Y=150", after, before)
		}
		recorder.expect(t, "press 1", "release 1", "press 1", "release 1")

		h.input(t, map[string]any{"type": "click", "x": 700, "y": 500, "button": "middle", "count": 3})
		recorder.expect(t, "press 2", "release 2", "press 2", "release 2", "press 2", "release 2")

		// dy > 0 is down (button 5) and dx > 0 is right (button 7).
		h.input(t,
			map[string]any{"type": "scroll", "x": 200, "y": 200, "dx": 0, "dy": 2},
			map[string]any{"type": "scroll", "x": 200, "y": 200, "dx": 0, "dy": -1},
			map[string]any{"type": "scroll", "x": 200, "y": 200, "dx": 1, "dy": 0},
			map[string]any{"type": "scroll", "x": 200, "y": 200, "dx": -1, "dy": 0},
		)
		recorder.expect(t, "press 5", "release 5", "press 5", "release 5", "press 4", "release 4",
			"press 7", "release 7", "press 6", "release 6")

		h.input(t,
			map[string]any{"type": "mouse_move", "x": 300, "y": 300},
			map[string]any{"type": "mouse_down", "button": "right"},
		)
		recorder.expect(t, "press 3")
		h.input(t,
			map[string]any{"type": "mouse_move", "x": 400, "y": 350},
			map[string]any{"type": "mouse_up", "button": "right"},
		)
		recorder.expect(t, "release 3")
		if after := h.pointer(t); after != "X=400 Y=350" {
			t.Fatalf("pointer after the drag = %q, want X=400 Y=350", after)
		}
	})

	t.Run("clipboard_get on an empty clipboard is empty", func(t *testing.T) {
		if text := h.clipboard(t); text != "" {
			t.Fatalf("clipboard = %q, want empty", text)
		}
	})

	t.Run("typing into xterm shows on screen", func(t *testing.T) {
		h.exec(t, "xterm", "xterm &")
		waitUntil(t, "an xterm window", 10*time.Second, func() bool {
			return h.exec(t, "search", "xdotool search --onlyvisible --class xterm").ExitCode == 0
		})
		// Let the shell inside xterm draw its prompt before the "before" frame.
		time.Sleep(time.Second)
		before := h.screenshot(t)
		proof := filepath.Join(h.workdir, "typed-proof")
		// openbox centres a new window, so the middle of the screen is inside the xterm.
		h.input(t,
			map[string]any{"type": "click", "x": 640, "y": 400, "button": "left", "count": 1},
			map[string]any{"type": "type", "text": "echo typed-into-xterm > " + proof},
			map[string]any{"type": "key", "keys": "Return"},
		)
		waitUntil(t, "the typed command to run", 5*time.Second, func() bool {
			raw, err := os.ReadFile(proof)
			return err == nil && strings.TrimSpace(string(raw)) == "typed-into-xterm"
		})
		after := h.screenshot(t)
		if changed := changedPixels(before, after); changed < 200 {
			t.Fatalf("only %d pixels changed after typing", changed)
		}
	})

	t.Run("clipboard set and get round trip", func(t *testing.T) {
		text := "héllo ✓ from the clipboard\nline two"
		reply := h.dispatch(t, "set", protocol.OpDesktopClipboardSet, map[string]any{"text": text, "selections": []string{"clipboard", "primary"}})
		if reply.Error != nil {
			t.Fatalf("clipboard_set: %+v", reply.Error)
		}
		if got := h.clipboard(t); got != text {
			t.Fatalf("clipboard = %q, want %q", got, text)
		}
		primary := h.exec(t, "primary", "xclip -selection primary -o")
		if primary.Stdout != text {
			t.Fatalf("primary = %q", primary.Stdout)
		}
		// An empty set is how the server clears both selections at hand-back.
		reply = h.dispatch(t, "clear", protocol.OpDesktopClipboardSet, map[string]any{"text": "", "selections": []string{"clipboard", "primary"}})
		if reply.Error != nil {
			t.Fatalf("clear: %+v", reply.Error)
		}
		if got := h.clipboard(t); got != "" {
			t.Fatalf("clipboard after clear = %q", got)
		}
	})

	// The Screen view pastes by setting CLIPBOARD and pressing Ctrl+V. Only CLIPBOARD is set and
	// PRIMARY holds something else, so xterm's default PRIMARY paste would fail each check.
	t.Run("ctrl+v, ctrl+shift+v and shift+Insert paste CLIPBOARD into xterm", func(t *testing.T) {
		primary := h.exec(t, "primary-decoy", "printf decoy | xclip -selection primary -i >/dev/null 2>&1")
		if primary.ExitCode != 0 {
			t.Fatalf("xclip: %+v", primary)
		}
		// One focusing click: clicks in quick succession count as a multi-click, and xterm would
		// select the line into CLIPBOARD over the text under test.
		h.input(t, map[string]any{"type": "click", "x": 640, "y": 400, "button": "left", "count": 1})
		for index, chord := range []string{"ctrl+v", "ctrl+shift+v", "shift+Insert"} {
			text := fmt.Sprintf("paste-7-%d", index)
			reply := h.dispatch(t, "paste-set-"+text, protocol.OpDesktopClipboardSet, map[string]any{"text": text, "selections": []string{"clipboard"}})
			if reply.Error != nil {
				t.Fatalf("clipboard_set: %+v", reply.Error)
			}
			proof := filepath.Join(h.workdir, "pasted-"+text)
			h.input(t,
				map[string]any{"type": "type", "text": "echo "},
				map[string]any{"type": "key", "keys": chord},
				map[string]any{"type": "type", "text": " > " + proof},
				map[string]any{"type": "key", "keys": "Return"},
			)
			waitUntil(t, chord+" to paste into xterm", 5*time.Second, func() bool {
				raw, err := os.ReadFile(proof)
				return err == nil && strings.TrimSpace(string(raw)) == text
			})
		}
	})

	t.Run("a clipboard over 64 KiB is too_large, not cut", func(t *testing.T) {
		set := h.exec(t, "big-clipboard", `head -c 70000 /dev/zero | tr '\0' a | xclip -selection clipboard -i >/dev/null 2>&1`)
		if set.ExitCode != 0 {
			t.Fatalf("xclip: %+v", set)
		}
		reply := h.dispatch(t, "get-big", protocol.OpDesktopClipboardGet, map[string]any{})
		if code := errorCode(t, reply); code != protocol.ErrTooLarge {
			t.Fatalf("code = %s", code)
		}
		clear := h.dispatch(t, "clear-big", protocol.OpDesktopClipboardSet, map[string]any{"text": "", "selections": []string{"clipboard"}})
		if clear.Error != nil {
			t.Fatalf("clear: %+v", clear.Error)
		}
	})

	// Asked for --no-sandbox, as agents often do, the wrapper drops it and says so.
	t.Run("chromium started with exec keeps running, sandboxed even when asked not to be", func(t *testing.T) {
		stderr := filepath.Join(h.workdir, "chromium-stderr")
		result := h.exec(t, "chromium", "chromium --no-sandbox --disable-setuid-sandbox about:blank 2>"+stderr+" &")
		if result.ExitCode != 0 || result.DurationMS >= 3000 {
			t.Fatalf("exec = exit %d after %d ms", result.ExitCode, result.DurationMS)
		}
		t.Logf("exec of chromium returned exit %d after %d ms", result.ExitCode, result.DurationMS)
		profile := filepath.Join(stateDir, desktop.DirName, "chromium-profile")
		waitUntil(t, "a chromium window", 20*time.Second, func() bool {
			return h.exec(t, "chromium-window", "xdotool search --onlyvisible --class chromium").ExitCode == 0
		})
		time.Sleep(2 * time.Second)
		running := h.exec(t, "pgrep", "pgrep -f -- '--user-data-dir="+profile+"'")
		if running.ExitCode != 0 {
			t.Fatalf("chromium is not running with the pinned profile: %+v", running)
		}
		if _, err := os.Stat(profile); err != nil {
			t.Fatalf("the profile was not created: %v", err)
		}
		// Its renderers run in their own user namespace: the sandbox is on, not bypassed.
		sandboxed := h.exec(t, "sandboxed", `self=$(readlink /proc/self/ns/user); for pid in $(pgrep -f -- '--type=renderer'); do [ "$(readlink /proc/$pid/ns/user)" != "$self" ] && echo sandboxed; done`)
		if !strings.Contains(sandboxed.Stdout, "sandboxed") {
			t.Fatalf("no chromium renderer runs in its own user namespace: %+v", sandboxed)
		}
		if bypassed := h.exec(t, "no-sandbox", "pgrep -af -- '--(no|disable-setuid)-sandbox'"); bypassed.ExitCode == 0 {
			t.Fatalf("a chromium process still carries a sandbox-disabling flag: %s", bypassed.Stdout)
		}
		raw, err := os.ReadFile(stderr)
		if want := "chromium: ignored --no-sandbox --disable-setuid-sandbox; the sandbox stays on"; err != nil || !strings.Contains(string(raw), want) {
			t.Fatalf("chromium's stderr = %q, %v; want the line %q", raw, err, want)
		}
	})

	// Last, because it takes every window down with the X server.
	t.Run("a crashed X server is restarted", func(t *testing.T) {
		h.exec(t, "kill-x", "pkill -KILL -x Xvfb")
		waitUntil(t, "the screenshot to report the desktop unavailable", 3*time.Second, func() bool {
			reply := h.dispatch(t, "down", protocol.OpDesktopScreenshot, map[string]any{"quality": 10})
			return reply.Error != nil && reply.Error.Code == protocol.ErrDesktopUnavailable
		})
		waitUntil(t, "Xvfb to come back", 15*time.Second, func() bool {
			reply := h.dispatch(t, "up", protocol.OpDesktopScreenshot, map[string]any{"quality": 10})
			return reply.Error == nil
		})
		waitUntil(t, "openbox to come back", 15*time.Second, func() bool {
			return h.exec(t, "openbox", "pgrep -x openbox").ExitCode == 0
		})
	})
}

// Under Docker's default seccomp profile Chromium's sandbox cannot start, and the desktop must
// say so rather than fall back to --no-sandbox.
func TestDesktopSandboxRefusedByDefaultProfile(t *testing.T) {
	if os.Getenv("AGENTUM_DESKTOP_EXPECT_SANDBOX") != "refused" {
		t.Skip("set AGENTUM_DESKTOP_EXPECT_SANDBOX=refused and run without the desktop seccomp profile")
	}
	screen, _, err := launchDesktop(t)
	ok, reason := desktop.Capability(err)
	if ok || reason == nil || !strings.Contains(*reason, "sandbox") {
		t.Fatalf("capability = %v, reason %v", ok, reason)
	}
	t.Logf("reported reason: %s", *reason)
	// Nothing is left for the agent or for exec'd commands to reach.
	if screen != nil {
		t.Fatal("a desktop that failed its check was handed on")
	}
	for _, name := range []string{"Xvfb", "openbox"} {
		if processRunning(name) {
			t.Fatalf("%s still runs after the desktop failed its check", name)
		}
	}
}

// An X server this desktop did not start is someone else's display: the desktop refuses it
// rather than typing into it.
func TestDesktopRefusesADisplayItDoesNotOwn(t *testing.T) {
	const display = 98
	foreign := exec.Command("Xvfb", fmt.Sprintf(":%d", display), "-nolisten", "tcp")
	if err := foreign.Start(); err != nil {
		t.Fatalf("start the other X server: %v", err)
	}
	t.Cleanup(func() {
		_ = foreign.Process.Kill()
		_ = foreign.Wait()
	})
	lock := fmt.Sprintf("/tmp/.X%d-lock", display)
	waitUntil(t, "the other X server's lock", 5*time.Second, func() bool {
		_, err := os.Stat(lock)
		return err == nil
	})

	_, err := desktop.Start(context.Background(), desktop.Options{StateDir: t.TempDir(), Display: display, Logger: discardLogger()})
	if err == nil || !strings.Contains(err.Error(), fmt.Sprintf("process %d", foreign.Process.Pid)) {
		t.Fatalf("start on a taken display: err = %v", err)
	}
}
