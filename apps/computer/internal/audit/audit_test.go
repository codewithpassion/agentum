package audit_test

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"agentum.dev/computer/internal/audit"
)

func TestRecordsAreOneJSONLinePerOperation(t *testing.T) {
	stateDir := t.TempDir()
	log, err := audit.Open(stateDir, audit.Options{})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	exitCode := 7
	entries := []audit.Entry{
		{Op: "exec", RequestID: "a", Outcome: audit.OutcomeOK, Command: "git status", ExitCode: &exitCode},
		{Op: "file_put", RequestID: "b", Outcome: audit.OutcomeDenied, Path: "/etc/passwd", Error: "outside the working directory"},
	}
	for _, entry := range entries {
		if err := log.Record(entry); err != nil {
			t.Fatalf("record: %v", err)
		}
	}
	if err := log.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	lines := readLines(t, filepath.Join(stateDir, audit.FileName))
	if len(lines) != 2 {
		t.Fatalf("wrote %d lines, want 2", len(lines))
	}
	var first audit.Entry
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatalf("decode line 1: %v", err)
	}
	if first.Op != "exec" || first.Outcome != audit.OutcomeOK || first.Time == "" {
		t.Fatalf("entry = %+v", first)
	}
	if first.ExitCode == nil || *first.ExitCode != 7 {
		t.Fatalf("exit code = %v", first.ExitCode)
	}
}

// The log names the commands an agent ran on a machine that may have other users on it.
func TestLogIsOwnerOnly(t *testing.T) {
	stateDir := t.TempDir()
	path := filepath.Join(stateDir, audit.FileName)
	// A log left behind by an older, wider umask must be tightened on open.
	if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	log, err := audit.Open(stateDir, audit.Options{})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = log.Close() }()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("audit log mode is %v", info.Mode().Perm())
	}
}

func TestLongCommandIsTruncated(t *testing.T) {
	stateDir := t.TempDir()
	log, err := audit.Open(stateDir, audit.Options{})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := log.Record(audit.Entry{Op: "exec", Command: strings.Repeat("x", 9000)}); err != nil {
		t.Fatalf("record: %v", err)
	}
	if err := log.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	var entry audit.Entry
	if err := json.Unmarshal([]byte(readLines(t, filepath.Join(stateDir, audit.FileName))[0]), &entry); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(entry.Command) > 4200 {
		t.Fatalf("recorded command is %d bytes", len(entry.Command))
	}
}

// The entry shape has no place to put environment values, which is the point: they carry the
// caller's secrets and this file is plain text.
func TestEntryCarriesNoEnvironment(t *testing.T) {
	encoded, err := json.Marshal(audit.Entry{Op: "exec"})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if strings.Contains(strings.ToLower(string(encoded)), "env") {
		t.Fatalf("the entry shape has an environment field: %s", encoded)
	}
}

// The log is append-only and a busy machine runs a lot of commands; without rotation it is
// the one file on this computer that grows forever.
func TestLogRotatesAndKeepsABoundedHistory(t *testing.T) {
	stateDir := t.TempDir()
	log, err := audit.Open(stateDir, audit.Options{MaxBytes: 512, Keep: 2})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	for index := range 60 {
		if err := log.Record(audit.Entry{Op: "exec", RequestID: strconv.Itoa(index), Command: strings.Repeat("x", 60)}); err != nil {
			t.Fatalf("record %d: %v", index, err)
		}
	}
	if err := log.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	live := filepath.Join(stateDir, audit.FileName)
	info, err := os.Stat(live)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Size() > 512 {
		t.Fatalf("the live log is %d bytes, over the rotation size", info.Size())
	}
	for _, kept := range []string{live + ".1", live + ".2"} {
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("%s is missing: %v", kept, err)
		}
	}
	if _, err := os.Stat(live + ".3"); err == nil {
		t.Fatal("more files were kept than asked for")
	}
	// The newest entry is in the live file, which is what makes tailing it useful.
	lines := readLines(t, live)
	if len(lines) == 0 || !strings.Contains(lines[len(lines)-1], `"request_id":"59"`) {
		t.Fatalf("the last entry is not in the live log: %v", lines)
	}
}

func readLines(t *testing.T, path string) []string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer func() { _ = file.Close() }()
	var lines []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) != "" {
			lines = append(lines, scanner.Text())
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan: %v", err)
	}
	return lines
}
