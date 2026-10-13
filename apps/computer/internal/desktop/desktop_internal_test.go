package desktop

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"agentum.dev/computer/internal/protocol"
)

func intp(value int) *int       { return &value }
func strp(value string) *string { return &value }
func point(kind string, x, y int) protocol.DesktopAction {
	return protocol.DesktopAction{Type: kind, X: intp(x), Y: intp(y)}
}

// The file is what Xvfb, libXau and the in-process client all read, so its bytes are pinned.
func TestWriteXauthorityFormatAndMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Xauthority")
	if err := os.WriteFile(path, []byte("stale"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cookie := bytes.Repeat([]byte{0xab}, cookieBytes)
	if err := WriteXauthority(path, "99", cookie); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600", info.Mode().Perm())
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var want bytes.Buffer
	_ = binary.Write(&want, binary.BigEndian, uint16(0xffff))
	for _, field := range []string{"", "99", "MIT-MAGIC-COOKIE-1", string(cookie)} {
		_ = binary.Write(&want, binary.BigEndian, uint16(len(field)))
		want.WriteString(field)
	}
	if !bytes.Equal(raw, want.Bytes()) {
		t.Fatalf("entry = %x\n want %x", raw, want.Bytes())
	}
}

func TestValidActionsPass(t *testing.T) {
	actions := []protocol.DesktopAction{
		point(protocol.ActionMouseMove, 0, 0),
		point(protocol.ActionMouseMove, protocol.DesktopWidth-1, protocol.DesktopHeight-1),
		{Type: protocol.ActionMouseDown, Button: strp("left")},
		{Type: protocol.ActionMouseUp, Button: strp("middle")},
		{Type: protocol.ActionClick, X: intp(1), Y: intp(2), Button: strp("right"), Count: intp(3)},
		// 10 + 50 is exactly the batch's wheel budget.
		{Type: protocol.ActionScroll, X: intp(1), Y: intp(2), DX: intp(-10), DY: intp(50)},
		{Type: protocol.ActionKey, Keys: strp("ctrl+shift+Tab")},
		{Type: protocol.ActionType, Text: strp(strings.Repeat("é", protocol.DesktopMaxTypeChars))},
	}
	if err := ValidateActions(actions); err != nil {
		t.Fatalf("validate: %v", err)
	}
}

func TestKeyChordsThatPass(t *testing.T) {
	for _, keys := range []string{"Return", "ctrl+l", "ctrl+shift+Tab", "KP_Enter", "F5", "super", "a", "ctrl+getmouselocation"} {
		if err := ValidateActions([]protocol.DesktopAction{{Type: protocol.ActionKey, Keys: strp(keys)}}); err != nil {
			t.Errorf("%q: %v", keys, err)
		}
	}
}

// xdotool runs an argument that names one of its commands, in any case, even after "key --".
func TestKeyChordsThatAreBadRequests(t *testing.T) {
	for _, keys := range []string{
		"ctrl-l", "+a", "a+", "ctrl++", "ctrl+l Return", "ctrl+l\n", "é", "ctrl+é", "a;b", "--help",
		"getmouselocation", "GETMOUSELOCATION", "exec", "windowkill", "mousemove_relative", "sleep", "help", "Help",
	} {
		err := ValidateActions([]protocol.DesktopAction{{Type: protocol.ActionKey, Keys: strp(keys)}})
		if !errors.Is(err, ErrBadRequest) {
			t.Errorf("%q: err = %v, want a bad request", keys, err)
		}
	}
}

// The wheel budget is summed over the whole batch, both axes, either direction.
func TestScrollBudgetIsPerBatch(t *testing.T) {
	scroll := func(dx, dy int) protocol.DesktopAction {
		return protocol.DesktopAction{Type: protocol.ActionScroll, X: intp(1), Y: intp(1), DX: intp(dx), DY: intp(dy)}
	}
	if err := ValidateActions([]protocol.DesktopAction{scroll(0, 30), scroll(-10, -20)}); err != nil {
		t.Fatalf("60 wheel clicks: %v", err)
	}
	for name, actions := range map[string][]protocol.DesktopAction{
		"two scrolls of 30 and 31":  {scroll(0, 30), scroll(0, -31)},
		"one scroll over both axes": {scroll(-31, 30)},
		"many small scrolls":        {scroll(5, 5), scroll(5, 5), scroll(5, 5), scroll(5, 5), scroll(5, 5), scroll(5, 5), scroll(1, 0)},
	} {
		if err := ValidateActions(actions); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v, want a bad request", name, err)
		}
	}
}

// Every limit in the contract is a bad_request, never something xdotool gets to interpret.
func TestInvalidActionsAreBadRequests(t *testing.T) {
	cases := map[string][]protocol.DesktopAction{
		"no actions":        {},
		"too many actions":  make([]protocol.DesktopAction, protocol.DesktopMaxActions+1),
		"unknown type":      {{Type: "drag"}},
		"x past the edge":   {point(protocol.ActionMouseMove, protocol.DesktopWidth, 0)},
		"negative y":        {point(protocol.ActionMouseMove, 0, -1)},
		"missing y":         {{Type: protocol.ActionMouseMove, X: intp(1)}},
		"missing button":    {{Type: protocol.ActionMouseDown}},
		"unknown button":    {{Type: protocol.ActionMouseUp, Button: strp("back")}},
		"click count zero":  {{Type: protocol.ActionClick, X: intp(1), Y: intp(1), Button: strp("left"), Count: intp(0)}},
		"click count four":  {{Type: protocol.ActionClick, X: intp(1), Y: intp(1), Button: strp("left"), Count: intp(4)}},
		"click no count":    {{Type: protocol.ActionClick, X: intp(1), Y: intp(1), Button: strp("left")}},
		"scroll too far":    {{Type: protocol.ActionScroll, X: intp(1), Y: intp(1), DX: intp(0), DY: intp(51)}},
		"scroll missing dx": {{Type: protocol.ActionScroll, X: intp(1), Y: intp(1), DY: intp(1)}},
		"empty keys":        {{Type: protocol.ActionKey, Keys: strp("")}},
		"keys too long":     {{Type: protocol.ActionKey, Keys: strp(strings.Repeat("a", protocol.DesktopMaxKeysChars+1))}},
		"two chords":        {{Type: protocol.ActionKey, Keys: strp("ctrl+l Return")}},
		"missing keys":      {{Type: protocol.ActionKey}},
		"empty text":        {{Type: protocol.ActionType, Text: strp("")}},
		"text too long":     {{Type: protocol.ActionType, Text: strp(strings.Repeat("a", protocol.DesktopMaxTypeChars+1))}},
		"missing text":      {{Type: protocol.ActionType}},
	}
	for name, actions := range cases {
		if err := ValidateActions(actions); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v, want a bad request", name, err)
		}
	}
}

// Typed text travels on stdin and keys after "--": neither can become an xdotool option, and
// typed text never shows in the process list.
func TestStepsForEachAction(t *testing.T) {
	cases := []struct {
		action protocol.DesktopAction
		want   []xdotoolStep
	}{
		{point(protocol.ActionMouseMove, 10, 20), []xdotoolStep{{args: []string{"mousemove", "10", "20"}}}},
		{protocol.DesktopAction{Type: protocol.ActionMouseDown, Button: strp("right")}, []xdotoolStep{{args: []string{"mousedown", "3"}}}},
		{protocol.DesktopAction{Type: protocol.ActionMouseUp, Button: strp("left")}, []xdotoolStep{{args: []string{"mouseup", "1"}}}},
		{
			protocol.DesktopAction{Type: protocol.ActionClick, X: intp(5), Y: intp(6), Button: strp("middle"), Count: intp(2)},
			[]xdotoolStep{{args: []string{"mousemove", "5", "6", "click", "--repeat", "2", "--delay", "0", "2"}}},
		},
		{
			protocol.DesktopAction{Type: protocol.ActionScroll, X: intp(5), Y: intp(6), DX: intp(-2), DY: intp(3)},
			[]xdotoolStep{
				{args: []string{"mousemove", "5", "6"}},
				{args: []string{"click", "--repeat", "3", "--delay", "5", "5"}},
				{args: []string{"click", "--repeat", "2", "--delay", "5", "6"}},
			},
		},
		{
			protocol.DesktopAction{Type: protocol.ActionScroll, X: intp(5), Y: intp(6), DX: intp(1), DY: intp(-1)},
			[]xdotoolStep{
				{args: []string{"mousemove", "5", "6"}},
				{args: []string{"click", "--repeat", "1", "--delay", "5", "4"}},
				{args: []string{"click", "--repeat", "1", "--delay", "5", "7"}},
			},
		},
		{protocol.DesktopAction{Type: protocol.ActionKey, Keys: strp("-ctrl+l")}, []xdotoolStep{{args: []string{"key", "--", "-ctrl+l"}}}},
		{
			protocol.DesktopAction{Type: protocol.ActionType, Text: strp("--help me")},
			[]xdotoolStep{{args: []string{"type", "--delay", "2", "--file", "-"}, stdin: "--help me"}},
		},
	}
	for _, testCase := range cases {
		got := stepsFor(testCase.action)
		if !reflect.DeepEqual(got, testCase.want) {
			t.Errorf("%s: steps = %+v\n want %+v", testCase.action.Type, got, testCase.want)
		}
	}
}

func TestInputBudgetFollowsTheContract(t *testing.T) {
	actions := []protocol.DesktopAction{
		{Type: protocol.ActionType, Text: strp(strings.Repeat("a", 512))},
		{Type: protocol.ActionKey, Keys: strp("Return")},
	}
	if got := InputBudget(actions); got != 2*time.Second+512*5*time.Millisecond {
		t.Fatalf("budget = %s", got)
	}
}

func TestScreenshotQuality(t *testing.T) {
	if quality, err := ScreenshotQuality(nil); err != nil || quality != 60 {
		t.Fatalf("null quality = %d, %v", quality, err)
	}
	for _, good := range []int{1, 95} {
		if quality, err := ScreenshotQuality(intp(good)); err != nil || quality != good {
			t.Fatalf("quality %d = %d, %v", good, quality, err)
		}
	}
	for _, bad := range []int{0, 96, -1} {
		if _, err := ScreenshotQuality(intp(bad)); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("quality %d: err = %v", bad, err)
		}
	}
}

func TestClipboardSetLimits(t *testing.T) {
	good := protocol.DesktopClipboardSetRequest{Text: strings.Repeat("a", protocol.DesktopMaxClipboardBytes), Selections: []string{"primary", "clipboard"}}
	if err := ValidateClipboardSet(good); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if err := ValidateClipboardSet(protocol.DesktopClipboardSetRequest{Text: "", Selections: []string{"clipboard"}}); err != nil {
		t.Fatalf("an empty text clears the clipboard and is allowed: %v", err)
	}
	bad := map[string]protocol.DesktopClipboardSetRequest{
		"text over 64 KiB":  {Text: strings.Repeat("a", protocol.DesktopMaxClipboardBytes+1), Selections: []string{"clipboard"}},
		"no selections":     {Text: "a"},
		"three selections":  {Text: "a", Selections: []string{"clipboard", "primary", "clipboard"}},
		"repeated":          {Text: "a", Selections: []string{"primary", "primary"}},
		"unknown selection": {Text: "a", Selections: []string{"secondary"}},
	}
	for name, request := range bad {
		if err := ValidateClipboardSet(request); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

func TestNoSelectionRecognisesXclip(t *testing.T) {
	if !noSelection("Error: target UTF8_STRING not available\n") {
		t.Fatal("xclip's no-owner message should read as an empty clipboard")
	}
	if noSelection("Error: Can't open display: :99\n") {
		t.Fatal("a display error is not an empty clipboard")
	}
}

func TestCapabilityReason(t *testing.T) {
	if ok, reason := Capability(nil); !ok || reason != nil {
		t.Fatalf("nil error = %v, %v", ok, reason)
	}
	ok, reason := Capability(errors.New(strings.Repeat("é", 300)))
	if ok || reason == nil || len([]rune(*reason)) != protocol.DesktopReasonMaxChars {
		t.Fatalf("long reason = %v, %v", ok, reason)
	}
}

// A little-endian BGRx pixel, which is what Xvfb serves at depth 24, becomes the right RGB.
func TestPixelLayoutDecode(t *testing.T) {
	layout := pixelLayout{bytesPerPixel: 4, order: binary.LittleEndian, red: 0xff0000, green: 0xff00, blue: 0xff}
	frame, err := layout.decode([]byte{0x10, 0x20, 0x30, 0x00, 0xff, 0x00, 0x00, 0x00}, 2, 1)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got := frame.Pix[:8]; !bytes.Equal(got, []byte{0x30, 0x20, 0x10, 0xff, 0x00, 0x00, 0xff, 0xff}) {
		t.Fatalf("pixels = %x", got)
	}
	if _, err := layout.decode([]byte{0, 0, 0}, 2, 1); err == nil {
		t.Fatal("a short image should be refused")
	}
}

// A frame whose JPEG would not fit the relay's cap is refused, not sent. Noise at the top quality
// is the worst case for the encoder; a real 1280x800 desktop cannot reach the cap.
func TestEncodeScreenshotRefusesAnOversizedFrame(t *testing.T) {
	noise := image.NewRGBA(image.Rect(0, 0, 2000, 2000))
	if _, err := rand.Read(noise.Pix); err != nil {
		t.Fatalf("noise: %v", err)
	}
	if _, err := encodeScreenshot(noise, protocol.DesktopMaxQuality); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want too large", err)
	}

	small := image.NewRGBA(image.Rect(0, 0, 32, 16))
	result, err := encodeScreenshot(small, protocol.DesktopMaxQuality)
	if err != nil {
		t.Fatalf("small frame: %v", err)
	}
	if result.Width != 32 || result.Height != 16 || result.MediaType != "image/jpeg" || result.DataB64 == "" {
		t.Fatalf("result = %d x %d %s", result.Width, result.Height, result.MediaType)
	}
}

func TestClipboardReadStopsAtTheCap(t *testing.T) {
	buffer := &cappedBuffer{limit: 4}
	if n, err := buffer.Write([]byte("abc")); n != 3 || err != nil || buffer.overflow {
		t.Fatalf("under the cap: %d, %v, overflow %v", n, err, buffer.overflow)
	}
	if _, err := buffer.Write([]byte("de")); err == nil || !buffer.overflow {
		t.Fatalf("over the cap: %v, overflow %v", err, buffer.overflow)
	}
	if buffer.buffer.String() != "abc" {
		t.Fatalf("kept %q", buffer.buffer.String())
	}
}

// The directory holds the X cookie and the browser profile, whatever mode it had before.
func TestPrepareDirIsPrivate(t *testing.T) {
	stateDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(stateDir, DirName), 0o755); err != nil {
		t.Fatalf("seed: %v", err)
	}
	dir, err := prepareDir(stateDir)
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	info, err := os.Stat(dir)
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("mode = %v, %v; want 0700", info, err)
	}
}

func writeLock(t *testing.T, path string, pid int) {
	t.Helper()
	// Xvfb's own format: the pid right-aligned in ten columns and a newline.
	if err := os.WriteFile(path, []byte(fmt.Sprintf("%10d\n", pid)), 0o444); err != nil {
		t.Fatalf("write lock: %v", err)
	}
}

func deadPID(t *testing.T) int {
	t.Helper()
	command := exec.Command("true")
	if err := command.Run(); err != nil {
		t.Fatalf("run true: %v", err)
	}
	return command.Process.Pid
}

func TestADisplayHeldByALiveProcessIsRefused(t *testing.T) {
	dir := t.TempDir()
	live := filepath.Join(dir, "live")
	writeLock(t, live, os.Getpid())
	if err := checkDisplayFree(live, 42); err == nil || !strings.Contains(err.Error(), "already in use") {
		t.Fatalf("live holder: err = %v", err)
	}
	stale := filepath.Join(dir, "stale")
	writeLock(t, stale, deadPID(t))
	if err := checkDisplayFree(stale, 42); err != nil {
		t.Fatalf("a stale lock is Xvfb's to clear: %v", err)
	}
	if err := checkDisplayFree(filepath.Join(dir, "missing"), 42); err != nil {
		t.Fatalf("no lock: %v", err)
	}
	garbage := filepath.Join(dir, "garbage")
	if err := os.WriteFile(garbage, []byte("not a pid\n"), 0o444); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := checkDisplayFree(garbage, 42); err == nil {
		t.Fatal("an unreadable lock should not pass as free")
	}
}

// connect only dials a display whose lock names this desktop's own Xvfb; a listener stands in
// for the X socket and records whether it was dialled at all.
func TestConnectNeverDialsSomeoneElsesDisplay(t *testing.T) {
	dir := t.TempDir()
	socket := filepath.Join(dir, "X42")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	dialled := make(chan struct{}, 4)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			dialled <- struct{}{}
			_ = conn.Close()
		}
	}()

	screen := newDesktop(Options{Display: 42}, dir, make([]byte, cookieBytes))
	screen.socket = socket
	screen.lockPath = filepath.Join(dir, ".X42-lock")
	const ours = 4242
	screen.xvfbPID.Store(ours)

	writeLock(t, screen.lockPath, os.Getpid())
	if _, err := screen.connect(200 * time.Millisecond); !errors.Is(err, ErrUnavailable) || !strings.Contains(err.Error(), "not by this desktop's X server") {
		t.Fatalf("foreign holder: err = %v", err)
	}
	select {
	case <-dialled:
		t.Fatal("a display held by another process was dialled")
	case <-time.After(100 * time.Millisecond):
	}

	// The control: with our own pid in the lock the same socket is dialled.
	writeLock(t, screen.lockPath+"-ours", ours)
	screen.lockPath += "-ours"
	_, _ = screen.connect(200 * time.Millisecond)
	select {
	case <-dialled:
	case <-time.After(time.Second):
		t.Fatal("our own display was not dialled")
	}
}

// holdSlots fills every slot and hands them back a second after the op's budget. The desktops
// here have no display, so an op that gets to run answers ErrUnavailable and one refused for want
// of a slot answers ErrBusy; an op that queued for a slot before starting its budget would run
// late and answer ErrUnavailable.
func holdSlots(t *testing.T, slots chan struct{}, budget time.Duration) {
	t.Helper()
	held := 0
	for len(slots) < cap(slots) {
		slots <- struct{}{}
		held++
	}
	// Exactly what was put in comes back out, never a slot the op under test took since.
	timer := time.AfterFunc(budget+time.Second, func() {
		for range held {
			<-slots
		}
	})
	t.Cleanup(func() { timer.Stop() })
}

func assertBusyWithin(t *testing.T, budget time.Duration, op func() error) {
	t.Helper()
	startedAt := time.Now()
	err := op()
	elapsed := time.Since(startedAt)
	if !errors.Is(err, ErrBusy) {
		t.Fatalf("err = %v, want busy", err)
	}
	if elapsed < budget-100*time.Millisecond || elapsed > budget+500*time.Millisecond {
		t.Fatalf("answered after %s, want about %s", elapsed, budget)
	}
}

func idleDesktop() *Desktop {
	return newDesktop(Options{Display: 4242}, os.TempDir(), make([]byte, cookieBytes))
}

func TestInputThatCannotStartInItsBudgetDoesNotRun(t *testing.T) {
	t.Parallel()
	screen := idleDesktop()
	actions := []protocol.DesktopAction{{Type: protocol.ActionKey, Keys: strp("Return")}}
	holdSlots(t, screen.turn, InputBudget(actions))
	assertBusyWithin(t, InputBudget(actions), func() error { return screen.Input(actions) })
}

func TestClipboardGetThatCannotStartInItsBudgetDoesNotRun(t *testing.T) {
	t.Parallel()
	screen := idleDesktop()
	holdSlots(t, screen.turn, clipboardBudget)
	assertBusyWithin(t, clipboardBudget, func() error { _, err := screen.ClipboardGet(); return err })
}

func TestClipboardSetThatCannotStartInItsBudgetDoesNotRun(t *testing.T) {
	t.Parallel()
	screen := idleDesktop()
	holdSlots(t, screen.turn, clipboardBudget)
	assertBusyWithin(t, clipboardBudget, func() error { return screen.ClipboardSet("x", []string{protocol.SelectionClipboard}) })
}

// Two captures run at once and a third waits; captures never wait for input.
func TestScreenshotSlots(t *testing.T) {
	t.Parallel()
	screen := idleDesktop()
	screen.turn <- struct{}{}
	screen.shots <- struct{}{}
	if _, err := screen.Screenshot(60); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("with one capture and an input running: err = %v, want the capture to run", err)
	}
	holdSlots(t, screen.shots, screenshotBudget)
	assertBusyWithin(t, screenshotBudget, func() error { _, err := screen.Screenshot(60); return err })
}

func TestSelfTestFailureNamesTheSandbox(t *testing.T) {
	stderr := "noise\n[9:9:0923/133226.005471:ERROR:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox! If this is a Debian system...\n"
	if got := selfTestFailure(errors.New("exit status 1"), stderr); !strings.HasPrefix(got, "No usable sandbox!") {
		t.Fatalf("reason = %q", got)
	}
	if got := selfTestFailure(errors.New("exit status 1"), "noise"); got != "exit status 1" {
		t.Fatalf("reason = %q", got)
	}
}
