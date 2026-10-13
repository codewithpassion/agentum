package protocol_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"agentum.dev/computer/internal/protocol"
)

// fixtureDir is the package-top-level testdata the server's schemas are checked against too,
// so both sides narrow the same bytes.
func fixtureDir(t *testing.T) string {
	t.Helper()
	return filepath.Join("..", "..", "testdata", "protocol")
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixtureDir(t), name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return raw
}

// equalJSON compares meaning, not bytes, so the repository's formatter can own the fixtures.
func equalJSON(t *testing.T, want []byte, got []byte) {
	t.Helper()
	var wantValue, gotValue any
	if err := json.Unmarshal(want, &wantValue); err != nil {
		t.Fatalf("decode expected: %v", err)
	}
	if err := json.Unmarshal(got, &gotValue); err != nil {
		t.Fatalf("decode produced: %v", err)
	}
	if !reflect.DeepEqual(wantValue, gotValue) {
		t.Fatalf("round trip differs\n want: %s\n  got: %s", want, got)
	}
}

// roundTrip decodes a fixture into T, re-encodes it, and insists nothing moved.
func roundTrip[T any](t *testing.T, name string) T {
	t.Helper()
	raw := readFixture(t, name)
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("decode %s: %v", name, err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encode %s: %v", name, err)
	}
	equalJSON(t, raw, encoded)
	return value
}

// roundTripRequest covers a server request, whose frame is the envelope and the op body
// flattened together: the client decodes the same bytes twice, so the test recombines them.
func roundTripRequest[T any](t *testing.T, name string, op string) T {
	t.Helper()
	raw := readFixture(t, name)
	var head protocol.Envelope
	if err := json.Unmarshal(raw, &head); err != nil {
		t.Fatalf("decode envelope of %s: %v", name, err)
	}
	if head.ID == "" {
		t.Fatalf("%s has no id", name)
	}
	if head.Op != op {
		t.Fatalf("%s op = %q, want %q", name, head.Op, op)
	}
	var body T
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode body of %s: %v", name, err)
	}
	encodedBody, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("encode body of %s: %v", name, err)
	}
	merged := map[string]json.RawMessage{}
	if err := json.Unmarshal(encodedBody, &merged); err != nil {
		t.Fatalf("re-read body of %s: %v", name, err)
	}
	merged["id"], _ = json.Marshal(head.ID)
	merged["op"], _ = json.Marshal(head.Op)
	encoded, err := json.Marshal(merged)
	if err != nil {
		t.Fatalf("encode %s: %v", name, err)
	}
	equalJSON(t, raw, encoded)
	return body
}

func TestHelloRoundTrip(t *testing.T) {
	hello := roundTrip[protocol.Hello](t, "client_to_server_hello.json")
	if hello.ProtocolVersion != protocol.Version {
		t.Fatalf("protocol_version = %d, want %d", hello.ProtocolVersion, protocol.Version)
	}
	if hello.Type != "hello" {
		t.Fatalf("type = %q, want hello", hello.Type)
	}
	// Skills is the client's verdict, not python3 && git: this fixture has python3 and no git.
	if !hello.Capabilities.Python3 || hello.Capabilities.Git || hello.Capabilities.Skills {
		t.Fatalf("capabilities = %+v", hello.Capabilities)
	}
	// The server has nothing else to build a session path from, so an absent workdir would
	// leave it guessing at a directory on this machine.
	if hello.Workdir != "/var/lib/agentum-computer/sessions" {
		t.Fatalf("workdir = %q", hello.Workdir)
	}
}

// An exec envelope and its op-specific body decode from the same frame, which is how the
// client reads every request.
func TestExecRequestRoundTrip(t *testing.T) {
	raw := readFixture(t, "server_to_client_exec.json")
	var head protocol.Envelope
	if err := json.Unmarshal(raw, &head); err != nil {
		t.Fatalf("decode envelope: %v", err)
	}
	if head.ID != "req-01HQ7" || head.Op != protocol.OpExec {
		t.Fatalf("envelope = %+v", head)
	}
	request := roundTripRequest[protocol.ExecRequest](t, "server_to_client_exec.json", protocol.OpExec)
	if request.Cwd == nil || *request.Cwd == "" {
		t.Fatal("cwd should decode to a value")
	}
	if request.TimeoutMS != 120_000 {
		t.Fatalf("timeout_ms = %d", request.TimeoutMS)
	}
	if request.Env["TFY_SESSION_ID"] != "sess-42" {
		t.Fatalf("env = %v", request.Env)
	}
}

// A null cwd must survive as null rather than collapsing to "", which would silently move the
// command into the process's own working directory.
func TestExecNullCwdStaysNull(t *testing.T) {
	request := roundTripRequest[protocol.ExecRequest](t, "server_to_client_exec_null_cwd.json", protocol.OpExec)
	if request.Cwd != nil {
		t.Fatalf("cwd = %q, want null", *request.Cwd)
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if string(fields["cwd"]) != "null" {
		t.Fatalf("cwd re-encoded as %s", fields["cwd"])
	}
}

func TestCancelRoundTrip(t *testing.T) {
	request := roundTripRequest[protocol.CancelRequest](t, "server_to_client_cancel.json", protocol.OpCancel)
	if request.TargetID != "req-01HQ7" {
		t.Fatalf("target_id = %q", request.TargetID)
	}
}

func TestFilePutRoundTrip(t *testing.T) {
	chunk := roundTripRequest[protocol.FilePutRequest](t, "server_to_client_file_put_chunk.json", protocol.OpFilePut)
	if chunk.Final || chunk.SHA256 != nil || chunk.Seq != 0 {
		t.Fatalf("chunk = %+v", chunk)
	}
	final := roundTripRequest[protocol.FilePutRequest](t, "server_to_client_file_put_final.json", protocol.OpFilePut)
	if !final.Final || final.SHA256 == nil || final.Seq != 1 {
		t.Fatalf("final = %+v", final)
	}
	if final.TransferID != chunk.TransferID {
		t.Fatalf("transfer ids differ: %q and %q", chunk.TransferID, final.TransferID)
	}
}

func TestFileGetRoundTrip(t *testing.T) {
	request := roundTripRequest[protocol.FileGetRequest](t, "server_to_client_file_get.json", protocol.OpFileGet)
	if request.Offset != 262_144 || request.MaxBytes != protocol.ChunkBytes {
		t.Fatalf("request = %+v", request)
	}
}

func TestResultRoundTrips(t *testing.T) {
	exec := roundTrip[protocol.Reply](t, "client_to_server_reply_exec.json")
	var execResult protocol.ExecResult
	if err := json.Unmarshal(exec.Result, &execResult); err != nil {
		t.Fatalf("decode exec result: %v", err)
	}
	if execResult.ExitCode != 124 || !execResult.Truncated || execResult.BytesTotal != 3_000_000 {
		t.Fatalf("exec result = %+v", execResult)
	}

	roundTrip[protocol.Reply](t, "client_to_server_reply_cancel.json")

	put := roundTrip[protocol.Reply](t, "client_to_server_reply_file_put.json")
	var putResult protocol.FilePutResult
	if err := json.Unmarshal(put.Result, &putResult); err != nil {
		t.Fatalf("decode file_put result: %v", err)
	}
	if putResult.SHA256 == nil || putResult.BytesWritten != 17 {
		t.Fatalf("file_put result = %+v", putResult)
	}

	get := roundTrip[protocol.Reply](t, "client_to_server_reply_file_get.json")
	var getResult protocol.FileGetResult
	if err := json.Unmarshal(get.Result, &getResult); err != nil {
		t.Fatalf("decode file_get result: %v", err)
	}
	if getResult.SHA256 != nil || !getResult.EOF {
		t.Fatalf("file_get result = %+v", getResult)
	}
}

func TestErrorReplyRoundTrip(t *testing.T) {
	failure := roundTrip[protocol.Reply](t, "client_to_server_reply_error.json")
	if failure.Result != nil {
		t.Fatalf("an error reply must carry no result, got %s", failure.Result)
	}
	if failure.Error == nil || failure.Error.Code != protocol.ErrDenied {
		t.Fatalf("error = %+v", failure.Error)
	}
}

// The encoders produce exactly the fixtures, so a change to either side shows up here.
func TestEncodersMatchFixtures(t *testing.T) {
	digest := "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
	encoded, err := protocol.EncodeOK("req-01HQA", protocol.FilePutResult{BytesWritten: 17, SHA256: &digest})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	equalJSON(t, readFixture(t, "client_to_server_reply_file_put.json"), encoded)

	equalJSON(t,
		readFixture(t, "client_to_server_reply_error.json"),
		protocol.EncodeError("req-01HQC", protocol.ErrDenied, "command refused by the local deny list"),
	)
}

// A successful reply must not carry an error key, and a failure must not carry a result key;
// the relay decides which branch it is on by their presence.
func TestReplyBranchesAreExclusive(t *testing.T) {
	ok, err := protocol.EncodeOK("id-1", protocol.CancelResult{Cancelled: false})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var okFields map[string]json.RawMessage
	if err := json.Unmarshal(ok, &okFields); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, present := okFields["error"]; present {
		t.Fatal("a successful reply carried an error key")
	}
	var failureFields map[string]json.RawMessage
	if err := json.Unmarshal(protocol.EncodeError("id-1", protocol.ErrQueueFull, "busy"), &failureFields); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, present := failureFields["result"]; present {
		t.Fatal("an error reply carried a result key")
	}
}

// The fixture is the list the server maps against, so adding a code without publishing it
// fails here rather than reaching the server as an unrecognised string.
func TestErrorCodeFixtureMatchesTheConstants(t *testing.T) {
	declared := []string{
		protocol.ErrBadRequest,
		protocol.ErrDenied,
		protocol.ErrDesktopUnavailable,
		protocol.ErrDuplicateID,
		protocol.ErrFrameTooBig,
		protocol.ErrIsADirectory,
		protocol.ErrNotRegularFile,
		protocol.ErrNotFound,
		protocol.ErrOpFailed,
		protocol.ErrQueueFull,
		protocol.ErrReadOnly,
		protocol.ErrTooLarge,
		protocol.ErrUnknownOp,
	}
	sort.Strings(declared)

	var fixture struct {
		Codes []string `json:"codes"`
	}
	if err := json.Unmarshal(readFixture(t, "error_codes.json"), &fixture); err != nil {
		t.Fatalf("decode the fixture: %v", err)
	}
	published := append([]string(nil), fixture.Codes...)
	sort.Strings(published)

	if !reflect.DeepEqual(declared, published) {
		t.Fatalf("the published codes have drifted\n declared: %v\npublished: %v", declared, published)
	}
	for _, code := range published {
		if code == "" || code != strings.ToLower(code) {
			t.Fatalf("error codes are lower snake_case; %q is not", code)
		}
	}
}

// A hello from a client with the desktop requested carries both fields; one without them is
// what an old client sends, and must still read as "no desktop".
func TestHelloDesktopFields(t *testing.T) {
	plain := roundTrip[protocol.Hello](t, "client_to_server_hello.json")
	if plain.Capabilities.Desktop || plain.Capabilities.DesktopUnavailableReason != nil {
		t.Fatalf("capabilities = %+v", plain.Capabilities)
	}
	desktop := roundTrip[protocol.Hello](t, "client_to_server_hello_desktop.json")
	if !desktop.Capabilities.Desktop || desktop.Capabilities.DesktopUnavailableReason != nil {
		t.Fatalf("capabilities = %+v", desktop.Capabilities)
	}
	unavailable := roundTrip[protocol.Hello](t, "client_to_server_hello_desktop_unavailable.json")
	reason := unavailable.Capabilities.DesktopUnavailableReason
	if unavailable.Capabilities.Desktop || reason == nil || *reason == "" || len([]rune(*reason)) > protocol.DesktopReasonMaxChars {
		t.Fatalf("capabilities = %+v", unavailable.Capabilities)
	}

	var old protocol.Hello
	if err := json.Unmarshal([]byte(`{"type":"hello","capabilities":{"python3":true,"git":true,"skills":true}}`), &old); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if old.Capabilities.Desktop || old.Capabilities.DesktopUnavailableReason != nil {
		t.Fatalf("an old hello read as %+v", old.Capabilities)
	}
}

func TestDesktopScreenshotRoundTrip(t *testing.T) {
	withQuality := roundTripRequest[protocol.DesktopScreenshotRequest](t, "server_to_client_desktop_screenshot.json", protocol.OpDesktopScreenshot)
	if withQuality.Quality == nil || *withQuality.Quality != 60 {
		t.Fatalf("quality = %v", withQuality.Quality)
	}
	// null must stay null: it means "the default", which a zero would not.
	withoutQuality := roundTripRequest[protocol.DesktopScreenshotRequest](t, "server_to_client_desktop_screenshot_null_quality.json", protocol.OpDesktopScreenshot)
	if withoutQuality.Quality != nil {
		t.Fatalf("quality = %d, want null", *withoutQuality.Quality)
	}
}

// Every action type in one request, each carrying only its own fields: a zero coordinate must
// survive, and no action may gain another type's keys on the way back out.
func TestDesktopInputRoundTrip(t *testing.T) {
	request := roundTripRequest[protocol.DesktopInputRequest](t, "server_to_client_desktop_input.json", protocol.OpDesktopInput)
	seen := map[string]bool{}
	for _, action := range request.Actions {
		seen[action.Type] = true
	}
	for _, want := range []string{
		protocol.ActionMouseMove, protocol.ActionMouseDown, protocol.ActionMouseUp, protocol.ActionClick,
		protocol.ActionScroll, protocol.ActionKey, protocol.ActionType,
	} {
		if !seen[want] {
			t.Fatalf("the fixture has no %s action", want)
		}
	}
	first := request.Actions[0]
	if first.X == nil || *first.X != 0 {
		t.Fatalf("a zero x did not survive: %+v", first)
	}
}

func TestDesktopClipboardRoundTrips(t *testing.T) {
	roundTripRequest[struct{}](t, "server_to_client_desktop_clipboard_get.json", protocol.OpDesktopClipboardGet)
	set := roundTripRequest[protocol.DesktopClipboardSetRequest](t, "server_to_client_desktop_clipboard_set.json", protocol.OpDesktopClipboardSet)
	if set.Text == "" || len(set.Selections) != 2 {
		t.Fatalf("clipboard_set = %+v", set)
	}
}

func TestDesktopResultRoundTrips(t *testing.T) {
	shot := roundTrip[protocol.Reply](t, "client_to_server_reply_desktop_screenshot.json")
	var shotResult protocol.DesktopScreenshotResult
	if err := json.Unmarshal(shot.Result, &shotResult); err != nil {
		t.Fatalf("decode screenshot result: %v", err)
	}
	if shotResult.Width != protocol.DesktopWidth || shotResult.Height != protocol.DesktopHeight || shotResult.MediaType != protocol.DesktopMediaType {
		t.Fatalf("screenshot result = %+v", shotResult)
	}

	for _, name := range []string{"client_to_server_reply_desktop_input.json", "client_to_server_reply_desktop_clipboard_set.json"} {
		reply := roundTrip[protocol.Reply](t, name)
		var ok protocol.DesktopOKResult
		if err := json.Unmarshal(reply.Result, &ok); err != nil || !ok.OK {
			t.Fatalf("%s result = %s (%v)", name, reply.Result, err)
		}
	}

	get := roundTrip[protocol.Reply](t, "client_to_server_reply_desktop_clipboard_get.json")
	var getResult protocol.DesktopClipboardGetResult
	if err := json.Unmarshal(get.Result, &getResult); err != nil {
		t.Fatalf("decode clipboard_get result: %v", err)
	}

	encoded, err := protocol.EncodeOK("req-01HR3", protocol.DesktopOKResult{OK: true})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	equalJSON(t, readFixture(t, "client_to_server_reply_desktop_input.json"), encoded)
}

// The guard has to stay far enough under the platform ceiling that JSON escaping of a capped
// command output cannot cross it.
func TestFrameGuardLeavesHeadroom(t *testing.T) {
	if protocol.MaxFrameBytes >= protocol.PlatformMaxFrameBytes {
		t.Fatal("the client guard must sit below the platform limit")
	}
	worstCaseEscaped := protocol.ExecOutputMaxBytes * 6
	if worstCaseEscaped > protocol.MaxFrameBytes {
		t.Fatalf("a fully escaped %d byte output (%d) exceeds the guard", protocol.ExecOutputMaxBytes, worstCaseEscaped)
	}
}
