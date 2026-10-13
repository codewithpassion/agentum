// Package protocol is the v1 wire contract between a computer and the Agentum relay: one JSON
// text frame per message, snake_case fields. The golden fixtures under testdata/protocol are the
// shared reference for the server's schemas. Treat the shapes as frozen: a change to an existing
// shape needs a new Version. New ops may be added under v1 only behind a hello capability, which
// is how the desktop ops arrived.
package protocol

import "encoding/json"

// Version rides on hello so a relay can refuse a client it cannot speak to.
const Version = 1

// Heartbeats are bare literals so the relay's auto-response can answer them without
// waking its Durable Object.
const (
	HeartbeatPing = "ping"
	HeartbeatPong = "pong"
)

// HeartbeatIntervalMS is how often the client pings. A socket that misses two answers is
// half-open, which no amount of TCP state will reveal.
const HeartbeatIntervalMS = 10_000

// Close codes. Each one means a different thing to the reconnect loop.
const (
	// CloseBadHello means the server could not read this client's hello. Reconnecting without
	// fixing the hello will only be refused again, so the backoff is what keeps it cheap.
	CloseBadHello = 4400
	// CloseRevoked is terminal: the credential is gone and retrying only hammers the server.
	CloseRevoked = 4401
	// CloseStale means the relay stopped hearing heartbeats; reconnecting is correct.
	CloseStale = 4408
	// CloseReplaced means a newer connection took over. Two clients sharing one credential
	// evict each other forever unless the loser waits a long time.
	CloseReplaced = 4409
)

// Sizes. The platform closes the whole socket on an oversized frame rather than failing one
// request, so every write is guarded well below the ceiling.
const (
	// ChunkBytes is the raw payload per file chunk, before base64.
	ChunkBytes = 256 * 1024
	// PlatformMaxFrameBytes was measured at 33,554,432 bytes during the Phase 8a spike.
	PlatformMaxFrameBytes = 32 << 20
	// MaxFrameBytes is the client's own refusal point. JSON escaping can multiply a capped
	// 1 MiB of output several times over, so the guard sits far under the platform limit.
	MaxFrameBytes = 8 << 20
	// ExecOutputMaxBytes is the head-plus-tail budget across both streams of one command.
	ExecOutputMaxBytes = 1 << 20
)

// Ops the relay may send.
const (
	OpExec    = "exec"
	OpCancel  = "cancel"
	OpFilePut = "file_put"
	OpFileGet = "file_get"

	// Desktop ops are only sent to a client whose hello advertised capabilities.desktop.
	OpDesktopScreenshot   = "desktop_screenshot"
	OpDesktopInput        = "desktop_input"
	OpDesktopClipboardGet = "desktop_clipboard_get"
	OpDesktopClipboardSet = "desktop_clipboard_set"
)

// Error codes carried back in a reply. The relay forwards them verbatim.
const (
	ErrBadRequest     = "bad_request"
	ErrOpFailed       = "op_failed"
	ErrQueueFull      = "queue_full"
	ErrDenied         = "denied"
	ErrReadOnly       = "read_only"
	ErrFrameTooBig    = "frame_too_large"
	ErrUnknownOp      = "unknown_op"
	ErrNotFound       = "not_found"
	ErrIsADirectory   = "is_a_directory"
	ErrTooLarge       = "too_large"
	ErrNotRegularFile = "not_a_regular_file"
	// ErrDuplicateID means the request id names something still running here, which the
	// server reads as "it is still going", not as a malformed request.
	ErrDuplicateID = "duplicate_id"
	// ErrDesktopUnavailable answers a desktop op on a computer whose desktop is not running.
	ErrDesktopUnavailable = "desktop_unavailable"
)

// Capabilities are what this machine has. Skills is this client's own verdict on whether the
// server's skill downloader can run here, which needs more than python3 and git being on PATH.
type Capabilities struct {
	Python3 bool `json:"python3"`
	Git     bool `json:"git"`
	Skills  bool `json:"skills"`
	// Desktop is true only once the X server answers, xdotool and xclip resolve and Chromium's
	// sandbox self-test passed. Both desktop fields are always sent; an old client omits them.
	Desktop bool `json:"desktop"`
	// DesktopUnavailableReason says why a requested desktop is not usable, and is null otherwise.
	DesktopUnavailableReason *string `json:"desktop_unavailable_reason"`
}

// DesktopReasonMaxChars is the server's cap on desktop_unavailable_reason.
const DesktopReasonMaxChars = 256

// Hello is the first frame the client sends after the upgrade.
type Hello struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocol_version"`
	Hostname        string `json:"hostname"`
	OS              string `json:"os"`
	Arch            string `json:"arch"`
	Version         string `json:"version"`
	RunAsUser       string `json:"run_as_user"`
	// Workdir is the absolute, resolved root this client keeps its per-session directories
	// under. The server builds every session path from it, because only this machine knows it.
	Workdir      string       `json:"workdir"`
	Capabilities Capabilities `json:"capabilities"`
}

// Envelope is the common head of every server request; the op-specific fields are decoded
// from the same frame a second time.
type Envelope struct {
	ID string `json:"id"`
	Op string `json:"op"`
}

type ExecRequest struct {
	Command   string            `json:"command"`
	Cwd       *string           `json:"cwd"`
	Env       map[string]string `json:"env"`
	TimeoutMS int64             `json:"timeout_ms"`
}

type CancelRequest struct {
	TargetID string `json:"target_id"`
}

type FilePutRequest struct {
	TransferID string `json:"transfer_id"`
	Path       string `json:"path"`
	Seq        int    `json:"seq"`
	DataB64    string `json:"data_b64"`
	Final      bool   `json:"final"`
	// SHA256 is the hex digest of the whole file, sent on the final chunk only.
	SHA256 *string `json:"sha256"`
}

type FileGetRequest struct {
	Path     string `json:"path"`
	Offset   int64  `json:"offset"`
	MaxBytes int    `json:"max_bytes"`
}

// DesktopScreenshotRequest asks for one JPEG of the whole display. A null quality means 60.
type DesktopScreenshotRequest struct {
	Quality *int `json:"quality"`
}

// DesktopAction is one input step, discriminated on Type. Every field but Type is a pointer so an
// action carries exactly its own fields on the wire, and a missing one is told apart from zero.
type DesktopAction struct {
	Type   string  `json:"type"`
	X      *int    `json:"x,omitempty"`
	Y      *int    `json:"y,omitempty"`
	Button *string `json:"button,omitempty"`
	Count  *int    `json:"count,omitempty"`
	DX     *int    `json:"dx,omitempty"`
	DY     *int    `json:"dy,omitempty"`
	Keys   *string `json:"keys,omitempty"`
	Text   *string `json:"text,omitempty"`
}

// Desktop action types.
const (
	ActionMouseMove = "mouse_move"
	ActionMouseDown = "mouse_down"
	ActionMouseUp   = "mouse_up"
	ActionClick     = "click"
	ActionScroll    = "scroll"
	ActionKey       = "key"
	ActionType      = "type"
)

// Mouse buttons an action may name.
const (
	ButtonLeft   = "left"
	ButtonMiddle = "middle"
	ButtonRight  = "right"
)

// Clipboard selections a set may target.
const (
	SelectionClipboard = "clipboard"
	SelectionPrimary   = "primary"
)

type DesktopInputRequest struct {
	Actions []DesktopAction `json:"actions"`
}

type DesktopClipboardSetRequest struct {
	Text       string   `json:"text"`
	Selections []string `json:"selections"`
}

// Desktop limits. The display is fixed, so coordinates are desktop pixels with no scaling.
const (
	DesktopWidth           = 1280
	DesktopHeight          = 800
	DesktopMaxActions      = 64
	DesktopMaxTypeChars    = 512
	DesktopMaxKeysChars    = 64
	DesktopMaxClickCount   = 3
	DesktopMaxScrollClicks = 50
	// DesktopMaxScrollClicksPerBatch caps |dx|+|dy| summed over a batch's scrolls.
	DesktopMaxScrollClicksPerBatch = 60
	DesktopMaxClipboardBytes       = 64 << 10
	DesktopDefaultQuality          = 60
	DesktopMaxQuality              = 95
	// DesktopMaxResultBytes keeps a screenshot well under every relay cap.
	DesktopMaxResultBytes = 3 << 20
	// DesktopMediaType is the only format screenshots come in.
	DesktopMediaType = "image/jpeg"
)

type DesktopScreenshotResult struct {
	DataB64   string `json:"data_b64"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	MediaType string `json:"media_type"`
}

// DesktopOKResult answers desktop_input and desktop_clipboard_set.
type DesktopOKResult struct {
	OK bool `json:"ok"`
}

type DesktopClipboardGetResult struct {
	Text string `json:"text"`
}

type ExecResult struct {
	ExitCode   int    `json:"exit_code"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	BytesTotal int64  `json:"bytes_total"`
	Truncated  bool   `json:"truncated"`
	DurationMS int64  `json:"duration_ms"`
}

type CancelResult struct {
	Cancelled bool `json:"cancelled"`
}

type FilePutResult struct {
	BytesWritten int64 `json:"bytes_written"`
	// SHA256 is present on the final chunk once the client has verified the whole-file digest.
	SHA256 *string `json:"sha256"`
}

type FileGetResult struct {
	DataB64 string `json:"data_b64"`
	EOF     bool   `json:"eof"`
	Size    int64  `json:"size"`
	// SHA256 is the whole-file digest, returned with the first window (offset 0) only.
	SHA256 *string `json:"sha256"`
}

type ReplyError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Reply carries exactly one of Result or Error.
type Reply struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *ReplyError     `json:"error,omitempty"`
}

// EncodeOK renders a successful reply. The result is marshalled first so a shape that cannot
// be encoded fails here rather than producing a half-written frame.
func EncodeOK(id string, result any) ([]byte, error) {
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Reply{ID: id, Result: encoded})
}

// EncodeError renders a failure reply. It never returns an error, because the socket must stay
// answerable even when the caller is already handling one.
func EncodeError(id string, code string, message string) []byte {
	encoded, err := json.Marshal(Reply{ID: id, Error: &ReplyError{Code: code, Message: message}})
	if err != nil {
		fallback, fallbackErr := json.Marshal(Reply{ID: id, Error: &ReplyError{Code: ErrOpFailed, Message: "reply encoding failed"}})
		if fallbackErr != nil {
			return []byte(`{"id":"","error":{"code":"op_failed","message":"reply encoding failed"}}`)
		}
		return fallback
	}
	return encoded
}
