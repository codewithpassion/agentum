package agent_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"agentum.dev/computer/internal/audit"
	"agentum.dev/computer/internal/policy"
	"agentum.dev/computer/internal/protocol"
)

func errorCode(t *testing.T, reply protocol.Reply) string {
	t.Helper()
	if reply.Error == nil {
		t.Fatalf("expected an error reply, got %s", reply.Result)
	}
	return reply.Error.Code
}

// Without a desktop every desktop op is answered, and with a code the server can map, rather
// than as an unknown op.
func TestDesktopOpsWithoutADesktopAreUnavailable(t *testing.T) {
	h := newHarness(t, policy.Options{})
	requests := []struct {
		op   string
		body map[string]any
	}{
		{protocol.OpDesktopScreenshot, map[string]any{"quality": nil}},
		{protocol.OpDesktopInput, map[string]any{"actions": []any{map[string]any{"type": "key", "keys": "Return"}}}},
		{protocol.OpDesktopClipboardGet, map[string]any{}},
		{protocol.OpDesktopClipboardSet, map[string]any{"text": "x", "selections": []string{"clipboard"}}},
	}
	for index, request := range requests {
		reply := h.dispatch(t, "req-"+request.op, request.op, request.body)
		if code := errorCode(t, reply); code != protocol.ErrDesktopUnavailable {
			t.Fatalf("%d %s: code = %s", index, request.op, code)
		}
	}
}

// A request outside the contract's limits is a bad request whether or not a desktop runs.
func TestDesktopLimitsAreBadRequests(t *testing.T) {
	h := newHarness(t, policy.Options{})
	cases := []struct {
		op   string
		body map[string]any
	}{
		{protocol.OpDesktopScreenshot, map[string]any{"quality": 96}},
		{protocol.OpDesktopScreenshot, map[string]any{"quality": 1.5}},
		{protocol.OpDesktopInput, map[string]any{"actions": []any{}}},
		{protocol.OpDesktopInput, map[string]any{"actions": []any{map[string]any{"type": "mouse_move", "x": 1280, "y": 0}}}},
		{protocol.OpDesktopInput, map[string]any{"actions": []any{map[string]any{"type": "type", "text": strings.Repeat("a", 513)}}}},
		{protocol.OpDesktopClipboardSet, map[string]any{"text": strings.Repeat("a", 65537), "selections": []string{"clipboard"}}},
		{protocol.OpDesktopClipboardSet, map[string]any{"text": "a", "selections": []string{"clipboard", "clipboard"}}},
	}
	for index, testCase := range cases {
		reply := h.dispatch(t, "req-bad", testCase.op, testCase.body)
		if code := errorCode(t, reply); code != protocol.ErrBadRequest {
			t.Fatalf("case %d (%s): code = %s", index, testCase.op, code)
		}
	}
}

// Read-only refuses what writes to the desktop and leaves looking alone.
func TestReadOnlyRefusesDesktopWrites(t *testing.T) {
	h := newHarness(t, policy.Options{ReadOnly: true})
	input := h.dispatch(t, "req-input", protocol.OpDesktopInput, map[string]any{"actions": []any{map[string]any{"type": "type", "text": "hunter2"}}})
	if code := errorCode(t, input); code != protocol.ErrReadOnly {
		t.Fatalf("input code = %s", code)
	}
	set := h.dispatch(t, "req-set", protocol.OpDesktopClipboardSet, map[string]any{"text": "hunter2", "selections": []string{"primary"}})
	if code := errorCode(t, set); code != protocol.ErrReadOnly {
		t.Fatalf("clipboard_set code = %s", code)
	}
	// Reads are not refused for being read-only; this computer simply has no desktop.
	shot := h.dispatch(t, "req-shot", protocol.OpDesktopScreenshot, map[string]any{"quality": 30})
	if code := errorCode(t, shot); code != protocol.ErrDesktopUnavailable {
		t.Fatalf("screenshot code = %s", code)
	}
	get := h.dispatch(t, "req-get", protocol.OpDesktopClipboardGet, map[string]any{})
	if code := errorCode(t, get); code != protocol.ErrDesktopUnavailable {
		t.Fatalf("clipboard_get code = %s", code)
	}
}

// What a human types, the keys they press and what they paste never reach the audit log; the
// batch's action types and the clipboard's size do.
func TestDesktopAuditRecordsTypesNotContent(t *testing.T) {
	h := newHarness(t, policy.Options{ReadOnly: true})
	h.dispatch(t, "req-input", protocol.OpDesktopInput, map[string]any{"actions": []any{
		map[string]any{"type": "type", "text": "correct-horse-battery"},
		map[string]any{"type": "key", "keys": "ctrl+secretchord"},
	}})
	h.dispatch(t, "req-set", protocol.OpDesktopClipboardSet, map[string]any{"text": "pasted-token-xyz", "selections": []string{"clipboard"}})

	raw, err := os.ReadFile(filepath.Join(h.stateDir, audit.FileName))
	if err != nil {
		t.Fatalf("read audit: %v", err)
	}
	for _, secret := range []string{"correct-horse-battery", "secretchord", "pasted-token-xyz"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("the audit log recorded %q:\n%s", secret, raw)
		}
	}
	entries := h.auditEntries(t)
	if len(entries) != 2 {
		t.Fatalf("entries = %+v", entries)
	}
	if got := strings.Join(entries[0].Actions, ","); got != "type,key" || entries[0].Outcome != audit.OutcomeDenied {
		t.Fatalf("input entry = %+v", entries[0])
	}
	if entries[1].Bytes != int64(len("pasted-token-xyz")) {
		t.Fatalf("clipboard entry = %+v", entries[1])
	}
}
