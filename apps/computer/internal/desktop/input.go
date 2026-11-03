package desktop

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"agentum.dev/computer/internal/protocol"
)

// typeDelayMS is xdotool's per-character delay: its 12 ms default makes 512 characters take
// six seconds, far past any sensible request timeout.
const typeDelayMS = 2

// scrollDelayMS spaces wheel clicks; xdotool's 100 ms default makes a long scroll time out.
const scrollDelayMS = 5

// clickDelayMS spaces the repeats of a click; xdotool's 100 ms default made every click cost
// 100 ms and a triple click 300 ms. Toolkits count a double click by timestamp, not by gap.
const clickDelayMS = 0

var buttonNumbers = map[string]string{
	protocol.ButtonLeft:   "1",
	protocol.ButtonMiddle: "2",
	protocol.ButtonRight:  "3",
}

// keyChord is the contract's shape for key.keys: key names joined by "+", nothing else.
var keyChord = regexp.MustCompile(`^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$`)

// xdotoolCommands are xdotool's command names. xdotool reads an argument that matches one,
// in any case, as the next command even after "key --", so a chord must never be one.
var xdotoolCommands = map[string]bool{
	"behave": true, "behave_screen_edge": true, "click": true, "exec": true,
	"get_desktop": true, "get_desktop_for_window": true, "get_desktop_viewport": true, "get_num_desktops": true,
	"getactivewindow": true, "getdisplaygeometry": true, "getmouselocation": true, "getwindowclassname": true,
	"getwindowfocus": true, "getwindowgeometry": true, "getwindowname": true, "getwindowpid": true,
	"help": true, "key": true, "keydown": true, "keyup": true,
	"mousedown": true, "mousemove": true, "mousemove_relative": true, "mouseup": true,
	"search": true, "selectwindow": true, "set_desktop": true, "set_desktop_for_window": true,
	"set_desktop_viewport": true, "set_num_desktops": true, "set_window": true, "sleep": true,
	"type": true, "version": true, "windowactivate": true, "windowclose": true,
	"windowfocus": true, "windowkill": true, "windowlower": true, "windowmap": true,
	"windowminimize": true, "windowmove": true, "windowquit": true, "windowraise": true,
	"windowreparent": true, "windowsize": true, "windowstate": true, "windowunmap": true,
}

// ValidateActions enforces every limit the protocol puts on desktop_input.
func ValidateActions(actions []protocol.DesktopAction) error {
	if len(actions) < 1 || len(actions) > protocol.DesktopMaxActions {
		return fmt.Errorf("%w: actions must hold 1 to %d entries, not %d", ErrBadRequest, protocol.DesktopMaxActions, len(actions))
	}
	wheelClicks := 0
	for index, action := range actions {
		if err := validateAction(action); err != nil {
			return fmt.Errorf("%w: action %d (%s): %w", ErrBadRequest, index, action.Type, err)
		}
		if action.Type == protocol.ActionScroll {
			wheelClicks += abs(*action.DX) + abs(*action.DY)
		}
	}
	// Each wheel click is paced, so an unbounded batch would outlast its timeout.
	if wheelClicks > protocol.DesktopMaxScrollClicksPerBatch {
		return fmt.Errorf("%w: the batch scrolls %d wheel clicks, over the %d limit", ErrBadRequest, wheelClicks, protocol.DesktopMaxScrollClicksPerBatch)
	}
	return nil
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

func validateAction(action protocol.DesktopAction) error {
	switch action.Type {
	case protocol.ActionMouseMove:
		return validatePoint(action)
	case protocol.ActionMouseDown, protocol.ActionMouseUp:
		return validateButton(action.Button)
	case protocol.ActionClick:
		if err := validatePoint(action); err != nil {
			return err
		}
		if err := validateButton(action.Button); err != nil {
			return err
		}
		if action.Count == nil || *action.Count < 1 || *action.Count > protocol.DesktopMaxClickCount {
			return fmt.Errorf("count must be 1 to %d", protocol.DesktopMaxClickCount)
		}
		return nil
	case protocol.ActionScroll:
		if err := validatePoint(action); err != nil {
			return err
		}
		for _, delta := range []*int{action.DX, action.DY} {
			if delta == nil || *delta < -protocol.DesktopMaxScrollClicks || *delta > protocol.DesktopMaxScrollClicks {
				return fmt.Errorf("dx and dy are required and must be within ±%d", protocol.DesktopMaxScrollClicks)
			}
		}
		return nil
	case protocol.ActionKey:
		if action.Keys == nil {
			return errors.New("keys is required")
		}
		length := utf8.RuneCountInString(*action.Keys)
		if length < 1 || length > protocol.DesktopMaxKeysChars {
			return fmt.Errorf("keys must be 1 to %d characters", protocol.DesktopMaxKeysChars)
		}
		if !keyChord.MatchString(*action.Keys) {
			return errors.New("keys must be key names of letters, digits and _ joined by +")
		}
		if xdotoolCommands[strings.ToLower(*action.Keys)] {
			return errors.New("keys must be a key name, not an xdotool command")
		}
		return nil
	case protocol.ActionType:
		if action.Text == nil {
			return errors.New("text is required")
		}
		length := utf8.RuneCountInString(*action.Text)
		if length < 1 || length > protocol.DesktopMaxTypeChars {
			return fmt.Errorf("text must be 1 to %d characters", protocol.DesktopMaxTypeChars)
		}
		return nil
	default:
		return errors.New("unknown action type")
	}
}

func validatePoint(action protocol.DesktopAction) error {
	if action.X == nil || action.Y == nil {
		return errors.New("x and y are required")
	}
	if *action.X < 0 || *action.X >= protocol.DesktopWidth || *action.Y < 0 || *action.Y >= protocol.DesktopHeight {
		return fmt.Errorf("x must be 0 to %d and y 0 to %d", protocol.DesktopWidth-1, protocol.DesktopHeight-1)
	}
	return nil
}

func validateButton(button *string) error {
	if button == nil {
		return errors.New("button is required")
	}
	if _, known := buttonNumbers[*button]; !known {
		return errors.New("button must be left, middle or right")
	}
	return nil
}

// xdotoolStep is one xdotool invocation. Stdin carries typed text, so it never shows in the
// process list where another local user could read it.
type xdotoolStep struct {
	args  []string
	stdin string
}

// stepsFor turns a validated action into xdotool invocations, one command each: chaining xdotool
// commands in one process would let a key name be read as the next command.
func stepsFor(action protocol.DesktopAction) []xdotoolStep {
	switch action.Type {
	case protocol.ActionMouseMove:
		return []xdotoolStep{moveTo(action)}
	case protocol.ActionMouseDown:
		return []xdotoolStep{{args: []string{"mousedown", buttonNumbers[*action.Button]}}}
	case protocol.ActionMouseUp:
		return []xdotoolStep{{args: []string{"mouseup", buttonNumbers[*action.Button]}}}
	case protocol.ActionClick:
		// Move and click share one process: both take only numbers, so nothing typed can read as a command.
		return []xdotoolStep{{args: []string{
			"mousemove", strconv.Itoa(*action.X), strconv.Itoa(*action.Y),
			"click", "--repeat", strconv.Itoa(*action.Count), "--delay", strconv.Itoa(clickDelayMS), buttonNumbers[*action.Button],
		}}}
	case protocol.ActionScroll:
		steps := []xdotoolStep{moveTo(action)}
		// X has no wheel axis, only buttons: 4 up, 5 down, 6 left, 7 right.
		steps = append(steps, wheel(*action.DY, "5", "4")...)
		return append(steps, wheel(*action.DX, "7", "6")...)
	case protocol.ActionKey:
		return []xdotoolStep{{args: []string{"key", "--", *action.Keys}}}
	case protocol.ActionType:
		return []xdotoolStep{{args: []string{"type", "--delay", strconv.Itoa(typeDelayMS), "--file", "-"}, stdin: *action.Text}}
	default:
		return nil
	}
}

func moveTo(action protocol.DesktopAction) xdotoolStep {
	return xdotoolStep{args: []string{"mousemove", strconv.Itoa(*action.X), strconv.Itoa(*action.Y)}}
}

func wheel(delta int, positive string, negative string) []xdotoolStep {
	button := positive
	if delta < 0 {
		button, delta = negative, -delta
	}
	if delta == 0 {
		return nil
	}
	return []xdotoolStep{{args: []string{"click", "--repeat", strconv.Itoa(delta), "--delay", strconv.Itoa(scrollDelayMS), button}}}
}

// InputBudget is the contract's desktop_input timeout: 2 s plus 5 ms per typed character.
func InputBudget(actions []protocol.DesktopAction) time.Duration {
	typed := 0
	for _, action := range actions {
		if action.Type == protocol.ActionType && action.Text != nil {
			typed += utf8.RuneCountInString(*action.Text)
		}
	}
	return 2*time.Second + time.Duration(typed)*5*time.Millisecond
}

// Input runs a validated batch in order. The error names the failing action by index and type
// only: typed text and key names are never repeated back into logs.
func (d *Desktop) Input(actions []protocol.DesktopAction) error {
	ctx, cancel := context.WithTimeout(context.Background(), InputBudget(actions))
	defer cancel()
	release, err := acquire(ctx, d.turn)
	if err != nil {
		return err
	}
	defer release()
	if err := d.ensureRunning(); err != nil {
		return err
	}
	for index, action := range actions {
		for _, step := range stepsFor(action) {
			command := exec.CommandContext(ctx, "xdotool", step.args...)
			command.Env = d.commandEnv()
			command.Dir = d.dir
			if step.stdin != "" {
				command.Stdin = strings.NewReader(step.stdin)
			}
			if err := command.Run(); err != nil {
				return fmt.Errorf("action %d (%s) failed: %w", index, action.Type, err)
			}
		}
	}
	return nil
}

// ensureRunning turns a dead display into ErrUnavailable before any helper runs against it.
func (d *Desktop) ensureRunning() error {
	conn, err := d.connect(time.Second)
	if err != nil {
		return err
	}
	conn.Close()
	return nil
}
