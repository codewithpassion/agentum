package desktop

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"agentum.dev/computer/internal/protocol"
)

// clipboardBudget keeps a clipboard op inside the server's 3 s timeout, even when the selection
// owner never answers.
const clipboardBudget = 2500 * time.Millisecond

var knownSelections = map[string]bool{
	protocol.SelectionClipboard: true,
	protocol.SelectionPrimary:   true,
}

// ValidateClipboardSet enforces the protocol's limits on desktop_clipboard_set.
func ValidateClipboardSet(request protocol.DesktopClipboardSetRequest) error {
	if len(request.Text) > protocol.DesktopMaxClipboardBytes {
		return fmt.Errorf("%w: text is %d bytes, over the %d limit", ErrBadRequest, len(request.Text), protocol.DesktopMaxClipboardBytes)
	}
	if len(request.Selections) < 1 || len(request.Selections) > len(knownSelections) {
		return fmt.Errorf("%w: selections must name 1 or 2 selections", ErrBadRequest)
	}
	seen := map[string]bool{}
	for _, selection := range request.Selections {
		if !knownSelections[selection] {
			return fmt.Errorf("%w: selection %q is not clipboard or primary", ErrBadRequest, selection)
		}
		if seen[selection] {
			return fmt.Errorf("%w: selection %q is listed twice", ErrBadRequest, selection)
		}
		seen[selection] = true
	}
	return nil
}

// ClipboardGet reads CLIPBOARD as text. A clipboard nobody owns, or one holding no text, reads as
// "". Anything over the protocol's clipboard cap is refused rather than cut.
func (d *Desktop) ClipboardGet() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), clipboardBudget)
	defer cancel()
	release, err := acquire(ctx, d.turn)
	if err != nil {
		return "", err
	}
	defer release()
	if err := d.ensureRunning(); err != nil {
		return "", err
	}
	command := exec.CommandContext(ctx, "xclip", "-selection", protocol.SelectionClipboard, "-o", "-t", "UTF8_STRING")
	command.Env = d.commandEnv()
	command.Dir = d.dir
	stdout := &cappedBuffer{limit: protocol.DesktopMaxClipboardBytes}
	var stderr bytes.Buffer
	command.Stdout = stdout
	command.Stderr = &stderr
	err = command.Run()
	if stdout.overflow {
		return "", fmt.Errorf("%w: the clipboard holds more than %d bytes", ErrTooLarge, protocol.DesktopMaxClipboardBytes)
	}
	if err != nil {
		if noSelection(stderr.String()) {
			return "", nil
		}
		return "", fmt.Errorf("xclip could not read the clipboard: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.buffer.String(), nil
}

// noSelection recognises xclip's answer when no client owns the selection, or the owner offers
// no text: both are an empty clipboard to the caller.
func noSelection(stderr string) bool {
	return strings.Contains(stderr, "not available")
}

// ClipboardSet makes the text the content of each named selection. xclip stays behind as the
// selection owner until something else takes the selection.
func (d *Desktop) ClipboardSet(text string, selections []string) error {
	ctx, cancel := context.WithTimeout(context.Background(), clipboardBudget)
	defer cancel()
	release, err := acquire(ctx, d.turn)
	if err != nil {
		return err
	}
	defer release()
	if err := d.ensureRunning(); err != nil {
		return err
	}
	for _, selection := range selections {
		command := exec.CommandContext(ctx, "xclip", "-selection", selection, "-i")
		command.Env = d.commandEnv()
		command.Dir = d.dir
		command.Stdin = strings.NewReader(text)
		// No stdout or stderr pipes: the forked owner would hold them open and Run would wait
		// for it. Its own group keeps it out of the daemon's signals.
		command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := command.Run(); err != nil {
			return fmt.Errorf("xclip could not set the %s selection: %w", selection, err)
		}
	}
	return nil
}

// cappedBuffer keeps up to limit bytes and then fails the write, which stops the copy.
type cappedBuffer struct {
	buffer   bytes.Buffer
	limit    int
	overflow bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if c.buffer.Len()+len(p) > c.limit {
		c.overflow = true
		return 0, errors.New("clipboard over the size limit")
	}
	return c.buffer.Write(p)
}
