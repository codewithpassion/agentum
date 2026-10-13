// Package agent turns a request frame into work: it applies the local policy, runs the op,
// records it, and renders the reply.
package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"agentum.dev/computer/internal/audit"
	"agentum.dev/computer/internal/desktop"
	"agentum.dev/computer/internal/files"
	"agentum.dev/computer/internal/policy"
	"agentum.dev/computer/internal/protocol"
	"agentum.dev/computer/internal/runner"
)

type Agent struct {
	policy    *policy.Policy
	runner    *runner.Runner
	transfers *files.Transfers
	// desktop is nil when this computer runs no desktop; its ops then answer desktop_unavailable.
	desktop *desktop.Desktop
	log     *audit.Log
	logger  *slog.Logger
}

func New(rules *policy.Policy, commands *runner.Runner, transfers *files.Transfers, screen *desktop.Desktop, log *audit.Log, logger *slog.Logger) *Agent {
	if logger == nil {
		logger = slog.Default()
	}
	return &Agent{policy: rules, runner: commands, transfers: transfers, desktop: screen, log: log, logger: logger}
}

// OnDisconnect drops the uploads that were mid-flight. The server restarts a transfer from
// chunk zero after a reconnect, so a half-written temporary file is only a leak.
func (a *Agent) OnDisconnect() {
	a.transfers.Abandon()
}

// codedError carries the wire code a refusal should be reported with, so the connection
// layer does not have to know what this one can fail with.
type codedError struct {
	code string
	err  error
}

func (e *codedError) Error() string     { return e.err.Error() }
func (e *codedError) Unwrap() error     { return e.err }
func (e *codedError) ReplyCode() string { return e.code }

// Prepare claims an exec's request id on the read loop, before the frame is handed to a
// goroutine. Without it a cancel on the next frame can be answered "unknown" while the
// command it names starts anyway.
func (a *Agent) Prepare(head protocol.Envelope) error {
	if head.Op != protocol.OpExec {
		return nil
	}
	if err := a.runner.Reserve(head.ID); err != nil {
		if errors.Is(err, runner.ErrDuplicateID) {
			// Its own code: the server reads this as "that request is still running here",
			// which is a different thing from a frame it got wrong.
			return &codedError{code: protocol.ErrDuplicateID, err: err}
		}
		return err
	}
	return nil
}

// OnRefused releases a claim for a frame that will not be dispatched after all.
func (a *Agent) OnRefused(head protocol.Envelope) {
	if head.Op == protocol.OpExec {
		a.runner.Release(head.ID)
	}
}

// Dispatch answers one request. It always returns a frame: a request the relay is waiting on
// must never be met with silence.
func (a *Agent) Dispatch(head protocol.Envelope, frame []byte) []byte {
	switch head.Op {
	case protocol.OpExec:
		return a.exec(head, frame)
	case protocol.OpCancel:
		return a.cancel(head, frame)
	case protocol.OpFilePut:
		return a.filePut(head, frame)
	case protocol.OpFileGet:
		return a.fileGet(head, frame)
	case protocol.OpDesktopScreenshot:
		return a.desktopScreenshot(head, frame)
	case protocol.OpDesktopInput:
		return a.desktopInput(head, frame)
	case protocol.OpDesktopClipboardGet:
		return a.desktopClipboardGet(head)
	case protocol.OpDesktopClipboardSet:
		return a.desktopClipboardSet(head, frame)
	default:
		a.record(audit.Entry{Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeError, Error: "unknown op"})
		return protocol.EncodeError(head.ID, protocol.ErrUnknownOp, fmt.Sprintf("this computer does not implement the op %q", head.Op))
	}
}

func (a *Agent) exec(head protocol.Envelope, frame []byte) []byte {
	var request protocol.ExecRequest
	if err := json.Unmarshal(frame, &request); err != nil {
		a.runner.Release(head.ID)
		return a.fail(head, protocol.ErrBadRequest, fmt.Errorf("decode exec: %w", err))
	}
	cwd := ""
	if request.Cwd != nil {
		cwd = *request.Cwd
	}
	deny := func(err error) []byte {
		a.runner.Release(head.ID)
		a.record(audit.Entry{
			Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeDenied,
			Command: request.Command, Cwd: cwd, Error: err.Error(),
		})
		a.logger.Warn("refused a command", "id", head.ID, "error", err.Error())
		return protocol.EncodeError(head.ID, protocol.ErrDenied, err.Error())
	}

	if err := a.policy.CheckExec(request.Command); err != nil {
		return deny(err)
	}
	// A variable the shell or an interpreter executes would let an allowed command run
	// something else entirely, so the request is refused rather than quietly stripped: the
	// command may well depend on what was asked for.
	accepted, refused := a.policy.FilterEnv(request.Env)
	if len(refused) > 0 {
		return deny(fmt.Errorf("%w: this computer does not accept the environment variable(s) %s from the server; add --allow-env to permit one",
			policy.ErrDenied, strings.Join(refused, ", ")))
	}
	request.Env = accepted

	// Settled before the command is handed to the runner: a missing directory reaches Go as
	// "fork/exec /bin/sh: no such file or directory", which names the wrong thing entirely.
	resolvedCwd, err := a.policy.ResolveExecDir(request.Cwd)
	if err != nil {
		a.runner.Release(head.ID)
		a.record(audit.Entry{
			Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeError,
			Command: request.Command, Cwd: cwd, Error: err.Error(),
		})
		return protocol.EncodeError(head.ID, protocol.ErrBadRequest, err.Error())
	}
	request.Cwd = &resolvedCwd
	cwd = resolvedCwd

	startedAt := time.Now()
	completion, err := a.runner.Run(head.ID, request)
	if err != nil {
		code := protocol.ErrOpFailed
		switch {
		case errors.Is(err, runner.ErrQueueFull):
			code = protocol.ErrQueueFull
		case errors.Is(err, runner.ErrDuplicateID):
			code = protocol.ErrDuplicateID
		}
		a.record(audit.Entry{
			Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeError,
			Command: request.Command, Cwd: cwd, Error: err.Error(),
			DurationMS: time.Since(startedAt).Milliseconds(),
		})
		return protocol.EncodeError(head.ID, code, err.Error())
	}

	// "ok" means the command ran, whatever it exited with. A command that never started — the
	// shell could not be exec'd, or a cancel beat it — is not a success anyone should read as one.
	result := completion.Result
	exitCode := result.ExitCode
	outcome := audit.OutcomeOK
	if !completion.Started {
		outcome = audit.OutcomeError
	}
	a.record(audit.Entry{
		Op: head.Op, RequestID: head.ID, Outcome: outcome,
		Command: request.Command, Cwd: cwd, ExitCode: &exitCode, Error: completion.NotStartedReason,
		Bytes: result.BytesTotal, Truncated: result.Truncated, DurationMS: result.DurationMS,
	})
	return a.ok(head, result)
}

func (a *Agent) cancel(head protocol.Envelope, frame []byte) []byte {
	var request protocol.CancelRequest
	if err := json.Unmarshal(frame, &request); err != nil {
		return a.fail(head, protocol.ErrBadRequest, fmt.Errorf("decode cancel: %w", err))
	}
	// The runner outlives any one socket, so a cancel that arrives on a reconnected socket
	// still reaches a command the previous connection started.
	cancelled := a.runner.Cancel(request.TargetID)
	a.record(audit.Entry{
		Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeOK,
		Command: "cancel " + request.TargetID,
	})
	a.logger.Info("cancel", "id", head.ID, "target_id", request.TargetID, "cancelled", cancelled)
	return a.ok(head, protocol.CancelResult{Cancelled: cancelled})
}

func (a *Agent) filePut(head protocol.Envelope, frame []byte) []byte {
	var request protocol.FilePutRequest
	if err := json.Unmarshal(frame, &request); err != nil {
		return a.fail(head, protocol.ErrBadRequest, fmt.Errorf("decode file_put: %w", err))
	}
	// The path is resolved and policed inside the transfer, which re-checks it again just
	// before the rename; the two are up to a minute apart.
	result, err := a.transfers.Put(request)
	if err != nil {
		code := codeForFileError(err, a.policy.ReadOnly())
		outcome := audit.OutcomeError
		if code == protocol.ErrDenied || code == protocol.ErrReadOnly {
			outcome = audit.OutcomeDenied
		}
		a.record(audit.Entry{
			Op: head.Op, RequestID: head.ID, Outcome: outcome,
			Path: request.Path, Error: err.Error(),
		})
		return protocol.EncodeError(head.ID, code, err.Error())
	}
	a.record(audit.Entry{
		Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeOK,
		Path: request.Path, Bytes: result.BytesWritten,
	})
	return a.ok(head, result)
}

func (a *Agent) fileGet(head protocol.Envelope, frame []byte) []byte {
	var request protocol.FileGetRequest
	if err := json.Unmarshal(frame, &request); err != nil {
		return a.fail(head, protocol.ErrBadRequest, fmt.Errorf("decode file_get: %w", err))
	}
	resolved, err := a.policy.CheckRead(request.Path)
	if err != nil {
		a.record(audit.Entry{
			Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeDenied,
			Path: request.Path, Error: err.Error(),
		})
		return protocol.EncodeError(head.ID, protocol.ErrDenied, err.Error())
	}
	result, err := files.Get(request, resolved, a.transfers.MaxFileBytes())
	if err != nil {
		code := codeForFileError(err, a.policy.ReadOnly())
		a.record(audit.Entry{
			Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeError,
			Path: resolved, Error: err.Error(),
		})
		return protocol.EncodeError(head.ID, code, err.Error())
	}
	a.record(audit.Entry{
		Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeOK,
		Path: resolved, Bytes: int64(len(result.DataB64)),
	})
	return a.ok(head, result)
}

// codeForFileError names the failure precisely enough that the server can map it to the
// right sandbox error rather than one opaque failure.
func codeForFileError(err error, readOnly bool) string {
	switch {
	case errors.Is(err, policy.ErrDenied):
		if readOnly {
			return protocol.ErrReadOnly
		}
		return protocol.ErrDenied
	case errors.Is(err, files.ErrTooManyTransfers):
		return protocol.ErrQueueFull
	case errors.Is(err, files.ErrTooLarge):
		return protocol.ErrTooLarge
	case errors.Is(err, files.ErrIsDirectory):
		return protocol.ErrIsADirectory
	case errors.Is(err, files.ErrNotRegular):
		return protocol.ErrNotRegularFile
	case errors.Is(err, os.ErrNotExist):
		return protocol.ErrNotFound
	case errors.Is(err, files.ErrBadRequest):
		return protocol.ErrBadRequest
	default:
		return protocol.ErrOpFailed
	}
}

// OnReplyDropped records an answer that could not be written because its socket had closed.
// The server may reissue the request, so the outcome of the work already done is unknown.
func (a *Agent) OnReplyDropped(head protocol.Envelope, cause error) {
	a.logger.Warn("dropped a reply whose socket had closed", "id", head.ID, "op", head.Op, "error", cause.Error())
	a.record(audit.Entry{
		Op:        head.Op,
		RequestID: head.ID,
		Outcome:   audit.OutcomeReplyDropped,
		Error:     cause.Error(),
	})
}

func (a *Agent) ok(head protocol.Envelope, result any) []byte {
	encoded, err := protocol.EncodeOK(head.ID, result)
	if err != nil {
		return protocol.EncodeError(head.ID, protocol.ErrOpFailed, err.Error())
	}
	return encoded
}

func (a *Agent) fail(head protocol.Envelope, code string, err error) []byte {
	a.record(audit.Entry{Op: head.Op, RequestID: head.ID, Outcome: audit.OutcomeError, Error: err.Error()})
	return protocol.EncodeError(head.ID, code, err.Error())
}

// record never fails an operation: a full disk should not stop the machine from working, only
// from proving what it did.
func (a *Agent) record(entry audit.Entry) {
	if a.log == nil {
		return
	}
	if err := a.log.Record(entry); err != nil {
		a.logger.Warn("could not write the audit log", "error", err.Error())
	}
}
