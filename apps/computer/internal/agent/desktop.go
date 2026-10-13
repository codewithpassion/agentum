package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"agentum.dev/computer/internal/audit"
	"agentum.dev/computer/internal/desktop"
	"agentum.dev/computer/internal/protocol"
)

// errNoDesktop answers a desktop op on a computer that never started one.
var errNoDesktop = fmt.Errorf("%w; start the daemon with --desktop", desktop.ErrUnavailable)

func (a *Agent) desktopScreenshot(head protocol.Envelope, frame []byte) []byte {
	var request protocol.DesktopScreenshotRequest
	if err := json.Unmarshal(frame, &request); err != nil {
		return a.fail(head, protocol.ErrBadRequest, fmt.Errorf("decode desktop_screenshot: %w", err))
	}
	quality, err := desktop.ScreenshotQuality(request.Quality)
	if err != nil {
		return a.desktopFailure(head, audit.Entry{}, err)
	}
	if a.desktop == nil {
		return a.desktopFailure(head, audit.Entry{}, errNoDesktop)
	}
	startedAt := time.Now()
	result, err := a.desktop.Screenshot(quality)
	entry := audit.Entry{DurationMS: time.Since(startedAt).Milliseconds()}
	if err != nil {
		return a.desktopFailure(head, entry, err)
	}
	entry.Bytes = int64(len(result.DataB64))
	a.desktopRecord(head, entry)
	return a.ok(head, result)
}

func (a *Agent) desktopInput(head protocol.Envelope, frame []byte) []byte {
	var request protocol.DesktopInputRequest
	if err := json.Unmarshal(frame, &request); err != nil {
		return a.fail(head, protocol.ErrBadRequest, fmt.Errorf("decode desktop_input: %w", err))
	}
	entry := audit.Entry{}
	// An oversized batch is refused below; its types are not worth a line thousands long.
	if len(request.Actions) <= protocol.DesktopMaxActions {
		for _, action := range request.Actions {
			entry.Actions = append(entry.Actions, action.Type)
		}
	}
	if err := desktop.ValidateActions(request.Actions); err != nil {
		return a.desktopFailure(head, entry, err)
	}
	if a.policy.ReadOnly() {
		return a.desktopReadOnly(head, entry)
	}
	if a.desktop == nil {
		return a.desktopFailure(head, entry, errNoDesktop)
	}
	startedAt := time.Now()
	err := a.desktop.Input(request.Actions)
	entry.DurationMS = time.Since(startedAt).Milliseconds()
	if err != nil {
		return a.desktopFailure(head, entry, err)
	}
	a.desktopRecord(head, entry)
	return a.ok(head, protocol.DesktopOKResult{OK: true})
}

func (a *Agent) desktopClipboardGet(head protocol.Envelope) []byte {
	if a.desktop == nil {
		return a.desktopFailure(head, audit.Entry{}, errNoDesktop)
	}
	text, err := a.desktop.ClipboardGet()
	if err != nil {
		return a.desktopFailure(head, audit.Entry{}, err)
	}
	a.desktopRecord(head, audit.Entry{Bytes: int64(len(text))})
	return a.ok(head, protocol.DesktopClipboardGetResult{Text: text})
}

func (a *Agent) desktopClipboardSet(head protocol.Envelope, frame []byte) []byte {
	var request protocol.DesktopClipboardSetRequest
	if err := json.Unmarshal(frame, &request); err != nil {
		return a.fail(head, protocol.ErrBadRequest, fmt.Errorf("decode desktop_clipboard_set: %w", err))
	}
	entry := audit.Entry{Bytes: int64(len(request.Text))}
	if err := desktop.ValidateClipboardSet(request); err != nil {
		return a.desktopFailure(head, entry, err)
	}
	if a.policy.ReadOnly() {
		return a.desktopReadOnly(head, entry)
	}
	if a.desktop == nil {
		return a.desktopFailure(head, entry, errNoDesktop)
	}
	if err := a.desktop.ClipboardSet(request.Text, request.Selections); err != nil {
		return a.desktopFailure(head, entry, err)
	}
	a.desktopRecord(head, entry)
	return a.ok(head, protocol.DesktopOKResult{OK: true})
}

func (a *Agent) desktopReadOnly(head protocol.Envelope, entry audit.Entry) []byte {
	message := "this computer is read-only and refuses desktop input and clipboard writes"
	entry.Op, entry.RequestID, entry.Outcome, entry.Error = head.Op, head.ID, audit.OutcomeDenied, message
	a.record(entry)
	return protocol.EncodeError(head.ID, protocol.ErrReadOnly, message)
}

// desktopFailure maps a desktop error to its wire code. The desktop package never puts typed
// text, key names or clipboard contents in an error, so the message is safe to record.
func (a *Agent) desktopFailure(head protocol.Envelope, entry audit.Entry, err error) []byte {
	code := protocol.ErrOpFailed
	switch {
	case errors.Is(err, desktop.ErrBadRequest):
		code = protocol.ErrBadRequest
	case errors.Is(err, desktop.ErrUnavailable):
		code = protocol.ErrDesktopUnavailable
	case errors.Is(err, desktop.ErrTooLarge):
		code = protocol.ErrTooLarge
	}
	entry.Op, entry.RequestID, entry.Outcome, entry.Error = head.Op, head.ID, audit.OutcomeError, err.Error()
	a.record(entry)
	return protocol.EncodeError(head.ID, code, err.Error())
}

func (a *Agent) desktopRecord(head protocol.Envelope, entry audit.Entry) {
	entry.Op, entry.RequestID, entry.Outcome = head.Op, head.ID, audit.OutcomeOK
	a.record(entry)
}
