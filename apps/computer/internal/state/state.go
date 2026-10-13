// Package state owns the state directory: where it is, what the config holds, and how the
// machine credential is written so that only this user can read it.
package state

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"agentum.dev/computer/internal/protocol"
)

const (
	// ConfigFileName is JSON rather than TOML: the repository already reads JSON everywhere,
	// and it needs no dependency.
	ConfigFileName     = "config.json"
	CredentialFileName = "credential"
	// SessionsDirName is the root the relay puts its per-session directories under, and the
	// default working directory for a command that arrives without one.
	SessionsDirName = "sessions"

	// EnvURL and friends are the environment names the container and the service unit set.
	EnvURL        = "AGENTUM_URL"
	EnvEnrollCode = "AGENTUM_ENROLL_CODE"
	EnvStateDir   = "AGENTUM_STATE_DIR"

	// ContainerStateDir is the default inside the image, where there is no home directory
	// worth persisting.
	ContainerStateDir = "/var/lib/agentum-computer"
)

// ErrNotEnrolled means there is no credential on disk yet.
var ErrNotEnrolled = errors.New("this computer is not enrolled")

// Config is what enrollment leaves behind for `run` to pick up.
type Config struct {
	URL        string `json:"url"`
	ComputerID string `json:"computer_id"`
	// Name is what was reported as the hostname at enrollment, so a later run keeps reporting
	// the same identity even if the machine is renamed.
	Name string `json:"name,omitempty"`
	// Desktop turns the virtual desktop on for every run, as --desktop does for one.
	Desktop bool `json:"desktop,omitempty"`
}

// DefaultDir resolves the state directory: the explicit environment variable first, then the
// user's home, then the container path for an image that has neither.
func DefaultDir() string {
	if fromEnv := strings.TrimSpace(os.Getenv(EnvStateDir)); fromEnv != "" {
		return fromEnv
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".agentum")
	}
	return ContainerStateDir
}

func ConfigPath(dir string) string     { return filepath.Join(dir, ConfigFileName) }
func CredentialPath(dir string) string { return filepath.Join(dir, CredentialFileName) }
func SessionsDir(dir string) string    { return filepath.Join(dir, SessionsDirName) }

// Ensure creates the state directory with owner-only permissions and tightens one that
// already exists: MkdirAll leaves an existing 0755 directory alone, and this one holds the
// machine credential. A directory owned by somebody else is refused outright.
func Ensure(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create the state directory %s: %w", dir, err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("stat the state directory %s: %w", dir, err)
	}
	if owner, known := ownerUID(info); known && owner != os.Getuid() {
		return fmt.Errorf("the state directory %s belongs to uid %d, not to uid %d; refusing to keep this computer's credential somewhere another user controls",
			dir, owner, os.Getuid())
	}
	if info.Mode().Perm()&0o077 != 0 {
		if err := os.Chmod(dir, 0o700); err != nil {
			return fmt.Errorf("restrict the state directory %s: %w", dir, err)
		}
	}
	return nil
}

func LoadConfig(dir string) (Config, error) {
	raw, err := os.ReadFile(ConfigPath(dir))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Config{}, ErrNotEnrolled
		}
		return Config{}, fmt.Errorf("read %s: %w", ConfigPath(dir), err)
	}
	var config Config
	if err := json.Unmarshal(raw, &config); err != nil {
		return Config{}, fmt.Errorf("parse %s: %w", ConfigPath(dir), err)
	}
	return config, nil
}

func SaveConfig(dir string, config Config) error {
	if err := Ensure(dir); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("encode the config: %w", err)
	}
	return writeFileAtomically(ConfigPath(dir), append(encoded, '\n'), 0o600)
}

// ReadCredential returns the machine credential, and nothing else ever reads that file.
func ReadCredential(dir string) (string, error) {
	raw, err := os.ReadFile(CredentialPath(dir))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", ErrNotEnrolled
		}
		return "", fmt.Errorf("read %s: %w", CredentialPath(dir), err)
	}
	credential := strings.TrimSpace(string(raw))
	if credential == "" {
		return "", ErrNotEnrolled
	}
	return credential, nil
}

// WriteCredential stores the credential at 0600. The mode is set explicitly after the rename
// because a wide umask can only take permission bits away at creation, never restore them.
func WriteCredential(dir string, credential string) error {
	if strings.TrimSpace(credential) == "" {
		return errors.New("refusing to store an empty credential")
	}
	if err := Ensure(dir); err != nil {
		return err
	}
	return writeFileAtomically(CredentialPath(dir), []byte(strings.TrimSpace(credential)+"\n"), 0o600)
}

// IsEnrolled reports whether a credential is on disk, for status output.
func IsEnrolled(dir string) bool {
	_, err := ReadCredential(dir)
	return err == nil
}

func writeFileAtomically(path string, contents []byte, mode os.FileMode) error {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".tmp-*")
	if err != nil {
		return fmt.Errorf("create a temporary file in %s: %w", directory, err)
	}
	name := temporary.Name()
	defer func() { _ = os.Remove(name) }()

	if _, err := temporary.Write(contents); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("set the mode of %s: %w", name, err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close %s: %w", name, err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("move %s into place at %s: %w", name, path, err)
	}
	// The rename keeps the temporary file's mode, but an existing target replaced in place on
	// some filesystems does not, so the mode is asserted once more.
	if err := os.Chmod(path, mode); err != nil {
		return fmt.Errorf("set the mode of %s: %w", path, err)
	}
	return nil
}

// CheckRoot refuses to run as root unless the operator says so. A prompt-injected command on
// a machine with the owner's files is bad enough without uid 0.
func CheckRoot(uid int, allowRoot bool) error {
	if uid != 0 || allowRoot {
		return nil
	}
	return errors.New("refusing to run as root: create an unprivileged user for this computer, or pass --allow-root if you accept the risk")
}

// RunAsUser is the name reported in hello. A container often has no passwd entry, so the uid
// is the fallback rather than an error.
func RunAsUser() string {
	if current, err := user.Current(); err == nil && current.Username != "" {
		return current.Username
	}
	if name := strings.TrimSpace(os.Getenv("USER")); name != "" {
		return name
	}
	return "uid-" + strconv.Itoa(os.Getuid())
}

// pydanticProbeTimeout bounds the one import this probe runs. A cold interpreter on a slow disk
// can take seconds; anything past this is a machine we would rather report as skill-less than
// hang the hello behind.
const pydanticProbeTimeout = 10 * time.Second

// DetectCapabilities reports what this machine has. It runs python3 once, so callers build the
// hello from it rather than asking per request.
func DetectCapabilities() protocol.Capabilities {
	python3, git := hasTool("python3"), hasTool("git")
	return protocol.Capabilities{
		Python3: python3,
		Git:     git,
		// The server's skill downloader is a python3 script that clones with git and imports
		// pydantic. Reporting the two tools alone let a machine without pydantic through, and
		// then every command on it failed inside sandbox init.
		Skills: python3 && git && hasPydantic(),
	}
}

func hasTool(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// hasPydantic asks the interpreter, because the package can come from a distro package, a venv
// or a user site directory and no path on disk settles it. Argv, never a shell string.
func hasPydantic() bool {
	ctx, cancel := context.WithTimeout(context.Background(), pydanticProbeTimeout)
	defer cancel()
	return exec.CommandContext(ctx, "python3", "-c", "import pydantic").Run() == nil
}

// Hostname is what the machine calls itself, or the override given at enrollment.
func Hostname(override string) string {
	if trimmed := strings.TrimSpace(override); trimmed != "" {
		return trimmed
	}
	name, err := os.Hostname()
	if err != nil || name == "" {
		return "unknown"
	}
	return name
}

// OS and Arch are reported in hello and at enrollment.
func OS() string   { return runtime.GOOS }
func Arch() string { return runtime.GOARCH }
