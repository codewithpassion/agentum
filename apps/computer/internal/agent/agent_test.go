package agent_test

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agentum.dev/computer/internal/agent"
	"agentum.dev/computer/internal/audit"
	"agentum.dev/computer/internal/files"
	"agentum.dev/computer/internal/policy"
	"agentum.dev/computer/internal/protocol"
	"agentum.dev/computer/internal/runner"
)

type harness struct {
	agent    *agent.Agent
	commands *runner.Runner
	stateDir string
	workdir  string
}

func newHarness(t *testing.T, options policy.Options) *harness {
	t.Helper()
	return newHarnessWithRunner(t, options, runner.Options{})
}

func newHarnessWithRunner(t *testing.T, options policy.Options, runnerOptions runner.Options) *harness {
	t.Helper()
	stateDir := t.TempDir()
	workdir := filepath.Join(stateDir, "sessions")
	if err := os.MkdirAll(workdir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if options.Workdir == "" {
		options.Workdir = workdir
	}
	// The daemon always tells the policy where its state lives, so the tests do too.
	options.StateDir = stateDir
	options.SessionsDir = workdir
	rules, err := policy.New(options)
	if err != nil {
		t.Fatalf("policy: %v", err)
	}
	log, err := audit.Open(stateDir, audit.Options{})
	if err != nil {
		t.Fatalf("audit: %v", err)
	}
	t.Cleanup(func() { _ = log.Close() })
	runnerOptions.StateDir = stateDir
	runnerOptions.DefaultCwd = workdir
	runnerOptions.Logger = discardLogger()
	commands := runner.New(runnerOptions)
	return &harness{
		agent:    agent.New(rules, commands, files.NewTransfers(files.Options{ResolveWrite: rules.CheckWrite}), nil, log, discardLogger()),
		commands: commands,
		stateDir: stateDir,
		workdir:  options.Workdir,
	}
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// resolvedPath follows symlinks, because macOS puts temp dirs behind /var -> /private/var and
// pwd reports the resolved path.
func resolvedPath(t *testing.T, path string) string {
	t.Helper()
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return path
	}
	return real
}

func (h *harness) dispatch(t *testing.T, id string, op string, body map[string]any) protocol.Reply {
	t.Helper()
	body["id"] = id
	body["op"] = op
	frame, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}
	answer := h.agent.Dispatch(protocol.Envelope{ID: id, Op: op}, frame)
	var reply protocol.Reply
	if err := json.Unmarshal(answer, &reply); err != nil {
		t.Fatalf("decode reply: %v", err)
	}
	if reply.ID != id {
		t.Fatalf("reply id = %q, want %q", reply.ID, id)
	}
	return reply
}

func (h *harness) auditEntries(t *testing.T) []audit.Entry {
	t.Helper()
	file, err := os.Open(filepath.Join(h.stateDir, audit.FileName))
	if err != nil {
		t.Fatalf("open audit log: %v", err)
	}
	defer func() { _ = file.Close() }()
	var entries []audit.Entry
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		var entry audit.Entry
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			t.Fatalf("decode audit line: %v", err)
		}
		entries = append(entries, entry)
	}
	return entries
}

func execResultOf(t *testing.T, reply protocol.Reply) protocol.ExecResult {
	t.Helper()
	if reply.Error != nil {
		t.Fatalf("unexpected error reply: %+v", reply.Error)
	}
	var result protocol.ExecResult
	if err := json.Unmarshal(reply.Result, &result); err != nil {
		t.Fatalf("decode exec result: %v", err)
	}
	return result
}

func TestExecRunsAndIsAudited(t *testing.T) {
	h := newHarness(t, policy.Options{})
	reply := h.dispatch(t, "r1", protocol.OpExec, map[string]any{
		"command": "echo hello", "cwd": nil, "env": map[string]string{}, "timeout_ms": 5000,
	})
	result := execResultOf(t, reply)
	if strings.TrimSpace(result.Stdout) != "hello" || result.ExitCode != 0 {
		t.Fatalf("result = %+v", result)
	}
	entries := h.auditEntries(t)
	if len(entries) != 1 {
		t.Fatalf("wrote %d audit entries", len(entries))
	}
	if entries[0].Op != protocol.OpExec || entries[0].Outcome != audit.OutcomeOK || entries[0].Command != "echo hello" {
		t.Fatalf("audit entry = %+v", entries[0])
	}
}

// The server names a session's directory before anything has made it, so the first command of a
// session would otherwise die as "fork/exec /bin/sh: no such file or directory".
func TestExecCreatesAMissingDirectoryInsideTheWorkdir(t *testing.T) {
	h := newHarness(t, policy.Options{})
	session := filepath.Join(h.workdir, "sess-1", "uploads")
	reply := h.dispatch(t, "r1", protocol.OpExec, map[string]any{
		"command": "pwd", "cwd": session, "env": map[string]string{}, "timeout_ms": 5000,
	})
	result := execResultOf(t, reply)
	if result.ExitCode != 0 || strings.TrimSpace(result.Stdout) != resolvedPath(t, session) {
		t.Fatalf("result = %+v", result)
	}
	info, err := os.Stat(session)
	if err != nil {
		t.Fatalf("the directory was not created: %v", err)
	}
	// A machine can be shared; a session's work is not for every local user to read.
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("mode = %v, want 0700", info.Mode().Perm())
	}
}

// Creating one anywhere on the machine would turn every exec into a way for the server to make
// directories outside the root the operator pointed it at.
func TestExecRefusesAMissingDirectoryOutsideTheWorkdir(t *testing.T) {
	h := newHarness(t, policy.Options{})
	outside := filepath.Join(t.TempDir(), "nowhere")
	reply := h.dispatch(t, "r1", protocol.OpExec, map[string]any{
		"command": "pwd", "cwd": outside, "env": map[string]string{}, "timeout_ms": 5000,
	})
	if reply.Error == nil || reply.Error.Code != protocol.ErrBadRequest {
		t.Fatalf("reply = %+v", reply)
	}
	if reply.Error.Message != "working directory does not exist: "+outside {
		t.Fatalf("message = %q", reply.Error.Message)
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatal("the refused directory was created anyway")
	}
	entries := h.auditEntries(t)
	if len(entries) != 1 || entries[0].Outcome != audit.OutcomeError {
		t.Fatalf("audit entries = %+v", entries)
	}
}

func TestExecRefusesACwdThatIsNotADirectory(t *testing.T) {
	h := newHarness(t, policy.Options{})
	file := filepath.Join(h.workdir, "a-file")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	reply := h.dispatch(t, "r1", protocol.OpExec, map[string]any{
		"command": "pwd", "cwd": file, "env": map[string]string{}, "timeout_ms": 5000,
	})
	if reply.Error == nil || reply.Error.Code != protocol.ErrBadRequest {
		t.Fatalf("reply = %+v", reply)
	}
}

// A link inside the root that points out of it must not become a way to build a tree there.
func TestExecDoesNotCreateThroughASymlinkOutOfTheWorkdir(t *testing.T) {
	h := newHarness(t, policy.Options{})
	outside := t.TempDir()
	link := filepath.Join(h.workdir, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	target := filepath.Join(link, "made-here")
	reply := h.dispatch(t, "r1", protocol.OpExec, map[string]any{
		"command": "pwd", "cwd": target, "env": map[string]string{}, "timeout_ms": 5000,
	})
	if reply.Error == nil || reply.Error.Code != protocol.ErrBadRequest {
		t.Fatalf("reply = %+v", reply)
	}
	if _, err := os.Stat(filepath.Join(outside, "made-here")); !os.IsNotExist(err) {
		t.Fatal("a directory was created outside the working directory")
	}
}

// A command that never ran is not a success, whatever the reply says about its exit code.
func TestAnExecThatNeverStartedIsNotAuditedAsOK(t *testing.T) {
	h := newHarness(t, policy.Options{})
	head := protocol.Envelope{ID: "r1", Op: protocol.OpExec}
	if err := h.agent.Prepare(head); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	if !h.commands.Cancel("r1") {
		t.Fatal("the reserved command was not found")
	}
	reply := h.dispatch(t, "r1", protocol.OpExec, map[string]any{
		"command": "echo hi", "cwd": nil, "env": map[string]string{}, "timeout_ms": 5000,
	})
	if result := execResultOf(t, reply); result.ExitCode != runner.ExitKilled {
		t.Fatalf("result = %+v", result)
	}
	entries := h.auditEntries(t)
	if len(entries) != 1 || entries[0].Outcome != audit.OutcomeError || entries[0].Error == "" {
		t.Fatalf("audit entries = %+v", entries)
	}
}

// The deny list is enforced here, not asked of the server: a compromised relay cannot lift it.
func TestDeniedCommandIsRefusedAndAudited(t *testing.T) {
	h := newHarness(t, policy.Options{Deny: []string{`\brm\s+-rf\b`}})
	reply := h.dispatch(t, "r1", protocol.OpExec, map[string]any{
		"command": "rm -rf /", "cwd": nil, "env": map[string]string{}, "timeout_ms": 5000,
	})
	if reply.Error == nil || reply.Error.Code != protocol.ErrDenied {
		t.Fatalf("reply = %+v", reply)
	}
	entries := h.auditEntries(t)
	if len(entries) != 1 || entries[0].Outcome != audit.OutcomeDenied {
		t.Fatalf("audit = %+v", entries)
	}
}

func TestReadOnlyRefusesExecAndWrites(t *testing.T) {
	h := newHarness(t, policy.Options{ReadOnly: true})
	execReply := h.dispatch(t, "r1", protocol.OpExec, map[string]any{
		"command": "echo hi", "cwd": nil, "env": map[string]string{}, "timeout_ms": 5000,
	})
	if execReply.Error == nil || execReply.Error.Code != protocol.ErrDenied {
		t.Fatalf("exec reply = %+v", execReply)
	}
	putReply := h.dispatch(t, "r2", protocol.OpFilePut, map[string]any{
		"transfer_id": "x", "path": filepath.Join(h.workdir, "f"), "seq": 0,
		"data_b64": base64.StdEncoding.EncodeToString([]byte("x")), "final": true, "sha256": nil,
	})
	if putReply.Error == nil || putReply.Error.Code != protocol.ErrReadOnly {
		t.Fatalf("file_put reply = %+v", putReply)
	}

	// Reads still work, which is the point of read-only rather than disconnected.
	target := filepath.Join(h.workdir, "readable")
	if err := os.WriteFile(target, []byte("visible"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	getReply := h.dispatch(t, "r3", protocol.OpFileGet, map[string]any{
		"path": target, "offset": 0, "max_bytes": protocol.ChunkBytes,
	})
	if getReply.Error != nil {
		t.Fatalf("file_get reply = %+v", getReply.Error)
	}
}

func TestWorkdirOnlyRefusesAPathOutside(t *testing.T) {
	h := newHarness(t, policy.Options{WorkdirOnly: true})
	reply := h.dispatch(t, "r1", protocol.OpFileGet, map[string]any{
		"path": "/etc/hosts", "offset": 0, "max_bytes": protocol.ChunkBytes,
	})
	if reply.Error == nil || reply.Error.Code != protocol.ErrDenied {
		t.Fatalf("reply = %+v", reply)
	}
	if entries := h.auditEntries(t); len(entries) != 1 || entries[0].Outcome != audit.OutcomeDenied {
		t.Fatalf("audit = %+v", entries)
	}
}

func TestFileRoundTripThroughTheAgent(t *testing.T) {
	h := newHarness(t, policy.Options{WorkdirOnly: true})
	payload := []byte("a small file that fits in one chunk")
	sum := sha256.Sum256(payload)
	digest := hex.EncodeToString(sum[:])
	target := filepath.Join(h.workdir, "s1", "uploads", "file.txt")

	putReply := h.dispatch(t, "r1", protocol.OpFilePut, map[string]any{
		"transfer_id": "x", "path": target, "seq": 0,
		"data_b64": base64.StdEncoding.EncodeToString(payload), "final": true, "sha256": digest,
	})
	if putReply.Error != nil {
		t.Fatalf("file_put = %+v", putReply.Error)
	}
	getReply := h.dispatch(t, "r2", protocol.OpFileGet, map[string]any{
		"path": target, "offset": 0, "max_bytes": protocol.ChunkBytes,
	})
	if getReply.Error != nil {
		t.Fatalf("file_get = %+v", getReply.Error)
	}
	var result protocol.FileGetResult
	if err := json.Unmarshal(getReply.Result, &result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(result.DataB64)
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if string(decoded) != string(payload) {
		t.Fatalf("round trip differs: %q", decoded)
	}
	if result.SHA256 == nil || *result.SHA256 != digest {
		t.Fatalf("digest = %v", result.SHA256)
	}
}

func TestDigestMismatchComesBackAsBadRequest(t *testing.T) {
	h := newHarness(t, policy.Options{})
	wrong := strings.Repeat("0", 64)
	reply := h.dispatch(t, "r1", protocol.OpFilePut, map[string]any{
		"transfer_id": "x", "path": filepath.Join(h.workdir, "f"), "seq": 0,
		"data_b64": base64.StdEncoding.EncodeToString([]byte("x")), "final": true, "sha256": wrong,
	})
	if reply.Error == nil || reply.Error.Code != protocol.ErrBadRequest {
		t.Fatalf("reply = %+v", reply)
	}
}

// A cancel arriving under a request id the runner never saw is answered, not dropped.
func TestCancelOfAnUnknownCommandIsAnswered(t *testing.T) {
	h := newHarness(t, policy.Options{})
	reply := h.dispatch(t, "r1", protocol.OpCancel, map[string]any{"target_id": "nothing"})
	if reply.Error != nil {
		t.Fatalf("reply = %+v", reply.Error)
	}
	var result protocol.CancelResult
	if err := json.Unmarshal(reply.Result, &result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if result.Cancelled {
		t.Fatal("an unknown target reported as cancelled")
	}
}

func TestCancelStopsARunningCommand(t *testing.T) {
	h := newHarness(t, policy.Options{})
	done := make(chan protocol.Reply, 1)
	go func() {
		frame, _ := json.Marshal(map[string]any{
			"id": "slow", "op": protocol.OpExec, "command": "sleep 30",
			"cwd": nil, "env": map[string]string{}, "timeout_ms": 60000,
		})
		answer := h.agent.Dispatch(protocol.Envelope{ID: "slow", Op: protocol.OpExec}, frame)
		var reply protocol.Reply
		_ = json.Unmarshal(answer, &reply)
		done <- reply
	}()
	time.Sleep(500 * time.Millisecond)

	cancelReply := h.dispatch(t, "c1", protocol.OpCancel, map[string]any{"target_id": "slow"})
	var cancelled protocol.CancelResult
	if err := json.Unmarshal(cancelReply.Result, &cancelled); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !cancelled.Cancelled {
		t.Fatal("the running command was not found")
	}
	select {
	case reply := <-done:
		result := execResultOf(t, reply)
		if result.ExitCode != runner.ExitKilled {
			t.Fatalf("exit code = %d", result.ExitCode)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the cancelled command never returned")
	}
}

// The server maps not-found and is-a-directory to their own sandbox errors, so it needs the
// two told apart rather than one opaque failure.
func TestFileFailuresCarryTheirOwnCodes(t *testing.T) {
	h := newHarness(t, policy.Options{})
	missing := h.dispatch(t, "r1", protocol.OpFileGet, map[string]any{
		"path": filepath.Join(h.workdir, "nope"), "offset": 0, "max_bytes": protocol.ChunkBytes,
	})
	if missing.Error == nil || missing.Error.Code != protocol.ErrNotFound {
		t.Fatalf("missing file reply = %+v", missing)
	}
	directory := h.dispatch(t, "r2", protocol.OpFileGet, map[string]any{
		"path": h.workdir, "offset": 0, "max_bytes": protocol.ChunkBytes,
	})
	if directory.Error == nil || directory.Error.Code != protocol.ErrIsADirectory {
		t.Fatalf("directory reply = %+v", directory)
	}
}

// A reply that could not be written leaves the work done and its outcome unknown to the
// server, which is exactly the thing an audit log exists to record.
func TestDroppedReplyIsAudited(t *testing.T) {
	h := newHarness(t, policy.Options{})
	h.agent.OnReplyDropped(protocol.Envelope{ID: "r1", Op: protocol.OpExec}, errors.New("socket closed"))
	entries := h.auditEntries(t)
	if len(entries) != 1 {
		t.Fatalf("wrote %d audit entries", len(entries))
	}
	if entries[0].Outcome != audit.OutcomeReplyDropped || entries[0].RequestID != "r1" {
		t.Fatalf("entry = %+v", entries[0])
	}
}

// A socket drop must not kill work that is already under way. The session used to bound the
// command's context, so a 4408, a laptop waking or a relay deploy SIGKILLed every in-flight
// exec — and the plan promises the opposite: the registry outlives any one socket.
func TestACommandSurvivesADisconnectAndACancelOnTheNextSocket(t *testing.T) {
	h := newHarness(t, policy.Options{})
	marker := filepath.Join(t.TempDir(), "finished")

	done := make(chan protocol.Reply, 1)
	go func() {
		frame, _ := json.Marshal(map[string]any{
			"id": "long", "op": protocol.OpExec, "command": "sleep 2; touch " + marker,
			"cwd": nil, "env": map[string]string{}, "timeout_ms": 60000,
		})
		answer := h.agent.Dispatch(protocol.Envelope{ID: "long", Op: protocol.OpExec}, frame)
		var reply protocol.Reply
		_ = json.Unmarshal(answer, &reply)
		done <- reply
	}()
	time.Sleep(400 * time.Millisecond)

	// Everything a reconnect does to the agent.
	h.agent.OnDisconnect()

	select {
	case reply := <-done:
		result := execResultOf(t, reply)
		if result.ExitCode != 0 {
			t.Fatalf("the disconnect killed the command: exit %d", result.ExitCode)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the command never finished")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("the command did not run to completion: %v", err)
	}
}

func TestACancelOnTheNextSocketReachesACommandTheLastOneStarted(t *testing.T) {
	h := newHarness(t, policy.Options{})
	done := make(chan protocol.Reply, 1)
	go func() {
		frame, _ := json.Marshal(map[string]any{
			"id": "long", "op": protocol.OpExec, "command": "sleep 60",
			"cwd": nil, "env": map[string]string{}, "timeout_ms": 120000,
		})
		answer := h.agent.Dispatch(protocol.Envelope{ID: "long", Op: protocol.OpExec}, frame)
		var reply protocol.Reply
		_ = json.Unmarshal(answer, &reply)
		done <- reply
	}()
	time.Sleep(400 * time.Millisecond)

	h.agent.OnDisconnect()
	cancelReply := h.dispatch(t, "c1", protocol.OpCancel, map[string]any{"target_id": "long"})
	var cancelled protocol.CancelResult
	if err := json.Unmarshal(cancelReply.Result, &cancelled); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !cancelled.Cancelled {
		t.Fatal("a cancel after the reconnect did not find the command")
	}
	select {
	case reply := <-done:
		if result := execResultOf(t, reply); result.ExitCode != runner.ExitKilled {
			t.Fatalf("exit code = %d", result.ExitCode)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the cancelled command never returned")
	}
}

// Prepare claims the id on the read loop, so a cancel on the very next frame cannot be
// answered "unknown" while the command it names starts anyway.
func TestACancelThatOvertakesItsExecStillCounts(t *testing.T) {
	h := newHarness(t, policy.Options{})
	if err := h.agent.Prepare(protocol.Envelope{ID: "racy", Op: protocol.OpExec}); err != nil {
		t.Fatalf("prepare: %v", err)
	}

	cancelReply := h.dispatch(t, "c1", protocol.OpCancel, map[string]any{"target_id": "racy"})
	var cancelled protocol.CancelResult
	if err := json.Unmarshal(cancelReply.Result, &cancelled); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !cancelled.Cancelled {
		t.Fatal("a cancel for a reserved but unstarted command reported nothing to cancel")
	}

	marker := filepath.Join(t.TempDir(), "should-not-exist")
	frame, _ := json.Marshal(map[string]any{
		"id": "racy", "op": protocol.OpExec, "command": "touch " + marker,
		"cwd": nil, "env": map[string]string{}, "timeout_ms": 10000,
	})
	answer := h.agent.Dispatch(protocol.Envelope{ID: "racy", Op: protocol.OpExec}, frame)
	var reply protocol.Reply
	if err := json.Unmarshal(answer, &reply); err != nil {
		t.Fatalf("decode: %v", err)
	}
	result := execResultOf(t, reply)
	if result.ExitCode != runner.ExitKilled {
		t.Fatalf("exit code = %d, want %d", result.ExitCode, runner.ExitKilled)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("the cancelled command ran anyway")
	}
}

// An environment variable the shell or an interpreter executes would let an allowed command
// run something else entirely, so the request is refused rather than quietly stripped.
func TestEnvironmentInjectionIsRefusedNotStripped(t *testing.T) {
	h := newHarness(t, policy.Options{Allow: []string{`git (status|fetch)`}})
	for _, name := range []string{"LD_PRELOAD", "GIT_SSH_COMMAND", "PATH", "BASH_ENV", "HOME", "KUBECONFIG", "RUSTC_WRAPPER"} {
		reply := h.dispatch(t, "r-"+name, protocol.OpExec, map[string]any{
			"command": "git status", "cwd": nil,
			"env":        map[string]string{name: "/tmp/evil"},
			"timeout_ms": 5000,
		})
		if reply.Error == nil || reply.Error.Code != protocol.ErrDenied {
			t.Fatalf("%s was accepted: %+v", name, reply)
		}
		if !strings.Contains(reply.Error.Message, name) {
			t.Fatalf("the refusal for %s does not name it: %s", name, reply.Error.Message)
		}
	}
	// The allowed command still works without the injected variable.
	if reply := h.dispatch(t, "ok", protocol.OpExec, map[string]any{
		"command": "git status", "cwd": nil, "env": map[string]string{}, "timeout_ms": 5000,
	}); reply.Error != nil {
		t.Fatalf("the allowed command was refused: %+v", reply.Error)
	}
}

// Even with no allow or deny list, the loader variables are refused: nothing on this side
// runs before the dynamic linker does.
func TestLoaderVariablesAreRefusedOnAnUnconstrainedComputer(t *testing.T) {
	h := newHarness(t, policy.Options{})
	reply := h.dispatch(t, "r1", protocol.OpExec, map[string]any{
		"command": "true", "cwd": nil,
		"env":        map[string]string{"LD_PRELOAD": "/tmp/evil.so"},
		"timeout_ms": 5000,
	})
	if reply.Error == nil || reply.Error.Code != protocol.ErrDenied {
		t.Fatalf("LD_PRELOAD was accepted: %+v", reply)
	}
}

// The state directory holds the credential and the records the next sweep kills by. Reaching
// it is refused in the default, unconfined mode too.
func TestTheStateDirectoryIsNotReachableByDefault(t *testing.T) {
	h := newHarness(t, policy.Options{})
	for _, path := range []string{"credential", "config.json", filepath.Join("running", "999.json")} {
		reply := h.dispatch(t, "r-"+path, protocol.OpFileGet, map[string]any{
			"path": filepath.Join(h.stateDir, path), "offset": 0, "max_bytes": protocol.ChunkBytes,
		})
		if reply.Error == nil || reply.Error.Code != protocol.ErrDenied {
			t.Fatalf("%s was readable: %+v", path, reply)
		}
	}
}

// A refused exec must not leave its reservation behind: under sustained overload — the very
// case the queue cap exists for — every refusal would otherwise leak a map entry.
func TestARefusedExecReleasesItsReservation(t *testing.T) {
	h := newHarnessWithRunner(t, policy.Options{}, runner.Options{MaxConcurrent: 1, MaxQueue: 1})

	go func() {
		frame, _ := json.Marshal(map[string]any{
			"id": "blocker", "op": protocol.OpExec, "command": "sleep 5",
			"cwd": nil, "env": map[string]string{}, "timeout_ms": 30000,
		})
		h.agent.Dispatch(protocol.Envelope{ID: "blocker", Op: protocol.OpExec}, frame)
	}()
	go func() {
		frame, _ := json.Marshal(map[string]any{
			"id": "waiting", "op": protocol.OpExec, "command": "sleep 5",
			"cwd": nil, "env": map[string]string{}, "timeout_ms": 30000,
		})
		h.agent.Dispatch(protocol.Envelope{ID: "waiting", Op: protocol.OpExec}, frame)
	}()
	time.Sleep(700 * time.Millisecond)

	head := protocol.Envelope{ID: "overflow", Op: protocol.OpExec}
	if err := h.agent.Prepare(head); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	frame, _ := json.Marshal(map[string]any{
		"id": "overflow", "op": protocol.OpExec, "command": "true",
		"cwd": nil, "env": map[string]string{}, "timeout_ms": 5000,
	})
	var reply protocol.Reply
	if err := json.Unmarshal(h.agent.Dispatch(head, frame), &reply); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if reply.Error == nil || reply.Error.Code != protocol.ErrQueueFull {
		t.Fatalf("reply = %+v, want queue_full", reply)
	}

	// The id must be free again, which it is not if the refusal left the reservation behind.
	if err := h.agent.Prepare(head); err != nil {
		t.Fatalf("the refused exec leaked its reservation: %v", err)
	}
	h.agent.OnRefused(head)
	h.commands.Cancel("blocker")
	h.commands.Cancel("waiting")
}

// A request id that names something still running is not a malformed frame, and the server
// needs to be able to tell the two apart.
func TestADuplicateRequestIDHasItsOwnCode(t *testing.T) {
	h := newHarness(t, policy.Options{})
	head := protocol.Envelope{ID: "busy", Op: protocol.OpExec}
	if err := h.agent.Prepare(head); err != nil {
		t.Fatalf("prepare: %v", err)
	}
	defer h.agent.OnRefused(head)

	err := h.agent.Prepare(head)
	if err == nil {
		t.Fatal("the second claim on the same id succeeded")
	}
	var coded interface{ ReplyCode() string }
	if !errors.As(err, &coded) {
		t.Fatalf("the refusal carries no wire code: %v", err)
	}
	if coded.ReplyCode() != protocol.ErrDuplicateID {
		t.Fatalf("code = %q, want %q", coded.ReplyCode(), protocol.ErrDuplicateID)
	}
}

// Replacing a file should not silently change what can read or run it.
func TestAnUploadPreservesTheDestinationsMode(t *testing.T) {
	h := newHarness(t, policy.Options{})
	target := filepath.Join(h.workdir, "script.sh")
	if err := os.WriteFile(target, []byte("old"), 0o755); err != nil {
		t.Fatalf("seed: %v", err)
	}
	payload := []byte("new")
	sum := sha256.Sum256(payload)
	digest := hex.EncodeToString(sum[:])
	reply := h.dispatch(t, "r1", protocol.OpFilePut, map[string]any{
		"transfer_id": "x", "path": target, "seq": 0,
		"data_b64": base64.StdEncoding.EncodeToString(payload), "final": true, "sha256": digest,
	})
	if reply.Error != nil {
		t.Fatalf("file_put = %+v", reply.Error)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("mode = %v, want the destination's 0755 carried over", info.Mode().Perm())
	}

	// A file that did not exist stays owner-only.
	fresh := filepath.Join(h.workdir, "fresh.txt")
	if reply := h.dispatch(t, "r2", protocol.OpFilePut, map[string]any{
		"transfer_id": "y", "path": fresh, "seq": 0,
		"data_b64": base64.StdEncoding.EncodeToString(payload), "final": true, "sha256": digest,
	}); reply.Error != nil {
		t.Fatalf("file_put = %+v", reply.Error)
	}
	freshInfo, err := os.Stat(fresh)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if freshInfo.Mode().Perm() != 0o600 {
		t.Fatalf("new file mode = %v, want 0600", freshInfo.Mode().Perm())
	}
}

func TestUnknownOpIsAnswered(t *testing.T) {
	h := newHarness(t, policy.Options{})
	reply := h.dispatch(t, "r1", "teleport", map[string]any{})
	if reply.Error == nil || reply.Error.Code != protocol.ErrUnknownOp {
		t.Fatalf("reply = %+v", reply)
	}
}

func TestMalformedBodyIsAnswered(t *testing.T) {
	h := newHarness(t, policy.Options{})
	answer := h.agent.Dispatch(protocol.Envelope{ID: "r1", Op: protocol.OpExec},
		[]byte(`{"id":"r1","op":"exec","timeout_ms":"not a number"}`))
	var reply protocol.Reply
	if err := json.Unmarshal(answer, &reply); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if reply.Error == nil || reply.Error.Code != protocol.ErrBadRequest {
		t.Fatalf("reply = %+v", reply)
	}
}

// The audit log records what an agent did; environment values are not part of that, because
// they carry the caller's secrets.
func TestAuditNeverRecordsEnvironmentValues(t *testing.T) {
	h := newHarness(t, policy.Options{})
	h.dispatch(t, "r1", protocol.OpExec, map[string]any{
		"command": "true", "cwd": nil,
		"env":        map[string]string{"SECRET_TOKEN": "sk-do-not-log-me"},
		"timeout_ms": 5000,
	})
	raw, err := os.ReadFile(filepath.Join(h.stateDir, audit.FileName))
	if err != nil {
		t.Fatalf("read audit: %v", err)
	}
	if strings.Contains(string(raw), "sk-do-not-log-me") {
		t.Fatalf("an environment value reached the audit log:\n%s", raw)
	}
}
