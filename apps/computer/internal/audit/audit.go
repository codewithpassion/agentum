// Package audit writes one JSON line per operation to a file the machine's owner controls,
// so what an agent did here is readable without the server's cooperation.
package audit

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// FileName is the audit log inside the state directory.
const FileName = "audit.jsonl"

// commandLimit matches the server's own truncation of the recorded command.
const commandLimit = 4096

// Entry is one operation. Environment values are deliberately absent: they can carry the
// caller's secrets and the log is plain text on disk.
type Entry struct {
	Time       string `json:"time"`
	Op         string `json:"op"`
	RequestID  string `json:"request_id"`
	Outcome    string `json:"outcome"`
	Command    string `json:"command,omitempty"`
	Cwd        string `json:"cwd,omitempty"`
	Path       string `json:"path,omitempty"`
	ExitCode   *int   `json:"exit_code,omitempty"`
	Bytes      int64  `json:"bytes,omitempty"`
	Truncated  bool   `json:"truncated,omitempty"`
	DurationMS int64  `json:"duration_ms,omitempty"`
	Error      string `json:"error,omitempty"`
	// Actions lists a desktop_input batch's action types in order. Typed text, key names and
	// clipboard contents are never recorded, only their types and sizes.
	Actions []string `json:"actions,omitempty"`
}

// Outcomes an entry can record.
const (
	OutcomeOK           = "ok"
	OutcomeDenied       = "denied"
	OutcomeError        = "error"
	OutcomeReplyDropped = "reply_dropped"
)

// Rotation keeps the log from growing without bound on a busy machine. It is size based and
// deliberately small: this is a local record, not a shipping pipeline.
const (
	DefaultMaxBytes = 8 << 20
	DefaultKeep     = 3
)

type Options struct {
	// MaxBytes is the size at which the log is rotated.
	MaxBytes int64
	// Keep is how many rotated files are retained beside the live one.
	Keep int
}

type Log struct {
	options Options
	path    string

	mu    sync.Mutex
	file  *os.File
	bytes int64
}

// Open creates the log with owner-only permissions. A machine can be shared, and the command
// lines an agent ran are not for every local user to read.
func Open(stateDir string, options Options) (*Log, error) {
	if options.MaxBytes <= 0 {
		options.MaxBytes = DefaultMaxBytes
	}
	// Zero would mean "rotate by deleting the log", which is nobody's intent from a zero
	// value; an operator who wants that passes a negative Keep.
	if options.Keep == 0 {
		options.Keep = DefaultKeep
	}
	if options.Keep < 0 {
		options.Keep = 0
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, fmt.Errorf("create %s: %w", stateDir, err)
	}
	path := filepath.Join(stateDir, FileName)
	log := &Log{options: options, path: path}
	if err := log.openFile(); err != nil {
		return nil, err
	}
	return log, nil
}

func (l *Log) openFile() error {
	file, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open %s: %w", l.path, err)
	}
	// An existing log may predate this rule, or have been created with a wider umask.
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return fmt.Errorf("restrict %s: %w", l.path, err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return fmt.Errorf("stat %s: %w", l.path, err)
	}
	l.file = file
	l.bytes = info.Size()
	return nil
}

// rotate renames the live log aside and starts a new one. The caller holds the lock.
func (l *Log) rotate() error {
	if err := l.file.Close(); err != nil {
		return fmt.Errorf("close %s: %w", l.path, err)
	}
	// Shift the kept files down, dropping the oldest.
	_ = os.Remove(fmt.Sprintf("%s.%d", l.path, l.options.Keep))
	for index := l.options.Keep - 1; index >= 1; index-- {
		_ = os.Rename(fmt.Sprintf("%s.%d", l.path, index), fmt.Sprintf("%s.%d", l.path, index+1))
	}
	if l.options.Keep >= 1 {
		if err := os.Rename(l.path, l.path+".1"); err != nil {
			return fmt.Errorf("rotate %s: %w", l.path, err)
		}
	} else if err := os.Remove(l.path); err != nil {
		return fmt.Errorf("remove %s: %w", l.path, err)
	}
	return l.openFile()
}

func (l *Log) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.file.Close()
}

// Record appends one entry. A failure to write is not allowed to fail the operation, so it is
// reported and swallowed by the caller's logger instead.
func (l *Log) Record(entry Entry) error {
	if entry.Time == "" {
		entry.Time = time.Now().UTC().Format(time.RFC3339Nano)
	}
	entry.Command = truncate(entry.Command, commandLimit)
	encoded, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("encode audit entry: %w", err)
	}
	line := append(encoded, '\n')

	l.mu.Lock()
	defer l.mu.Unlock()
	if l.bytes+int64(len(line)) > l.options.MaxBytes {
		if err := l.rotate(); err != nil {
			return err
		}
	}
	written, err := l.file.Write(line)
	l.bytes += int64(written)
	if err != nil {
		return fmt.Errorf("write audit entry: %w", err)
	}
	return nil
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "…"
}
