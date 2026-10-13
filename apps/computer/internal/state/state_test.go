package state_test

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"agentum.dev/computer/internal/protocol"
	"agentum.dev/computer/internal/state"
)

// The credential is the whole of this machine's authority; nothing else on a shared box may
// read it.
func TestCredentialIsWrittenOwnerOnly(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	if err := state.WriteCredential(dir, "mc_secret"); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := os.Stat(state.CredentialPath(dir))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credential mode is %v, want 0600", info.Mode().Perm())
	}
	directory, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat the state directory: %v", err)
	}
	if directory.Mode().Perm()&0o077 != 0 {
		t.Fatalf("state directory mode is %v", directory.Mode().Perm())
	}
	read, err := state.ReadCredential(dir)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if read != "mc_secret" {
		t.Fatalf("read back %q", read)
	}
}

// Re-enrollment overwrites an existing credential, and must not inherit a wider mode from it.
func TestRewritingACredentialTightensTheMode(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(state.CredentialPath(dir), []byte("old\n"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := state.WriteCredential(dir, "new"); err != nil {
		t.Fatalf("write: %v", err)
	}
	info, err := os.Stat(state.CredentialPath(dir))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credential mode is %v, want 0600", info.Mode().Perm())
	}
	read, err := state.ReadCredential(dir)
	if err != nil || read != "new" {
		t.Fatalf("read back %q, %v", read, err)
	}
}

func TestEmptyCredentialIsRefused(t *testing.T) {
	dir := t.TempDir()
	if err := state.WriteCredential(dir, "   "); err == nil {
		t.Fatal("an empty credential was stored")
	}
	if err := os.WriteFile(state.CredentialPath(dir), []byte("\n"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := state.ReadCredential(dir); err == nil {
		t.Fatal("an empty credential file read as enrolled")
	}
}

func TestConfigRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if _, err := state.LoadConfig(dir); err == nil {
		t.Fatal("an unenrolled directory loaded a config")
	}
	want := state.Config{URL: "https://agentum.example.com", ComputerID: "cmp_1", Name: "office-box"}
	if err := state.SaveConfig(dir, want); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := state.LoadConfig(dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got != want {
		t.Fatalf("config = %+v, want %+v", got, want)
	}
	info, err := os.Stat(state.ConfigPath(dir))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("config mode is %v", info.Mode().Perm())
	}
}

func TestIsEnrolled(t *testing.T) {
	dir := t.TempDir()
	if state.IsEnrolled(dir) {
		t.Fatal("an empty directory reported as enrolled")
	}
	if err := state.WriteCredential(dir, "mc"); err != nil {
		t.Fatalf("write: %v", err)
	}
	if !state.IsEnrolled(dir) {
		t.Fatal("a stored credential did not report as enrolled")
	}
}

// Running as root gives a prompt-injected command the run of the machine, so it takes an
// explicit decision.
func TestRootIsRefusedWithoutTheFlag(t *testing.T) {
	if err := state.CheckRoot(0, false); err == nil {
		t.Fatal("root was allowed without --allow-root")
	} else if !strings.Contains(err.Error(), "--allow-root") {
		t.Fatalf("the refusal does not say how to override it: %v", err)
	}
	if err := state.CheckRoot(0, true); err != nil {
		t.Fatalf("--allow-root was not honoured: %v", err)
	}
	if err := state.CheckRoot(1000, false); err != nil {
		t.Fatalf("an unprivileged user was refused: %v", err)
	}
}

func TestStateDirResolution(t *testing.T) {
	t.Setenv(state.EnvStateDir, "/somewhere/explicit")
	if got := state.DefaultDir(); got != "/somewhere/explicit" {
		t.Fatalf("with the environment set, DefaultDir() = %q", got)
	}
	t.Setenv(state.EnvStateDir, "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	if got := state.DefaultDir(); got != filepath.Join(home, ".agentum") {
		t.Fatalf("with a home directory, DefaultDir() = %q", got)
	}
}

func TestHostnameOverride(t *testing.T) {
	if got := state.Hostname(" office-box "); got != "office-box" {
		t.Fatalf("Hostname(override) = %q", got)
	}
	if got := state.Hostname(""); got == "" {
		t.Fatal("Hostname() returned nothing")
	}
}

func TestRunAsUserIsNeverEmpty(t *testing.T) {
	if state.RunAsUser() == "" {
		t.Fatal("RunAsUser() returned nothing")
	}
}

func TestSessionsDirSitsUnderTheStateDir(t *testing.T) {
	dir := t.TempDir()
	if got := state.SessionsDir(dir); got != filepath.Join(dir, "sessions") {
		t.Fatalf("SessionsDir = %q", got)
	}
}

// fakeTool writes an executable that exits with code, so a test can stand in for a real binary
// on PATH without needing python3 or git on the machine running the suite.
func fakeTool(t *testing.T, dir, name string, code int) {
	t.Helper()
	script := fmt.Sprintf("#!/bin/sh\nexit %d\n", code)
	if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
		t.Fatalf("writing %s: %v", name, err)
	}
}

// Skills is the one capability that is a verdict rather than a lookup, and it is the gate that
// keeps the server's skill downloader off a machine that cannot run it.
func TestDetectCapabilitiesReportsSkillsOnlyWhenTheImportSucceeds(t *testing.T) {
	for _, testCase := range []struct {
		name        string
		python3     bool
		git         bool
		importExits int
		want        protocol.Capabilities
	}{
		{
			name:        "no python3 at all",
			git:         true,
			importExits: 0,
			want:        protocol.Capabilities{Python3: false, Git: true, Skills: false},
		},
		{
			name:        "python3 and git, but the pydantic import fails",
			python3:     true,
			git:         true,
			importExits: 1,
			want:        protocol.Capabilities{Python3: true, Git: true, Skills: false},
		},
		{
			name:        "python3 and pydantic, but no git to clone with",
			python3:     true,
			importExits: 0,
			want:        protocol.Capabilities{Python3: true, Git: false, Skills: false},
		},
		{
			name:        "all three",
			python3:     true,
			git:         true,
			importExits: 0,
			want:        protocol.Capabilities{Python3: true, Git: true, Skills: true},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			dir := t.TempDir()
			if testCase.python3 {
				fakeTool(t, dir, "python3", testCase.importExits)
			}
			if testCase.git {
				fakeTool(t, dir, "git", 0)
			}
			// The temporary directory is the whole of PATH, so a real python3 on the machine
			// running the suite cannot answer for the one this case is describing.
			t.Setenv("PATH", dir)
			if got := state.DetectCapabilities(); got != testCase.want {
				t.Fatalf("DetectCapabilities() = %+v, want %+v", got, testCase.want)
			}
		})
	}
}
