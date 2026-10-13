package main

import (
	"context"
	"errors"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"agentum.dev/computer/internal/protocol"
	"agentum.dev/computer/internal/serverurl"
	"agentum.dev/computer/internal/state"
)

func TestCommandExitCodes(t *testing.T) {
	empty := t.TempDir()
	cases := []struct {
		name string
		args []string
		want int
	}{
		{"no arguments", nil, exitUsage},
		{"unknown command", []string{"teleport"}, exitUsage},
		{"version", []string{"version"}, exitOK},
		{"help", []string{"help"}, exitOK},
		{"status without enrollment", []string{"status", "--state-dir", empty}, exitNotReady},
		{"enroll without a url or code", []string{"enroll", "--state-dir", empty}, exitUsage},
		{"run without enrollment", []string{"run", "--state-dir", empty, "--allow-root"}, exitUsage},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := run(testCase.args); got != testCase.want {
				t.Fatalf("run(%v) = %d, want %d", testCase.args, got, testCase.want)
			}
		})
	}
}

func TestStatusReportsAnEnrolledComputer(t *testing.T) {
	dir := t.TempDir()
	if err := state.WriteCredential(dir, "mc_secret"); err != nil {
		t.Fatalf("write credential: %v", err)
	}
	if err := state.SaveConfig(dir, state.Config{URL: "https://example.com", ComputerID: "cmp_1", Name: "box"}); err != nil {
		t.Fatalf("save config: %v", err)
	}
	if got := run([]string{"status", "--state-dir", dir, "--json"}); got != exitOK {
		t.Fatalf("status = %d, want %d", got, exitOK)
	}
}

func enrollServer(t *testing.T, calls *int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		*calls++
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"data":{"computer_id":"cmp_1","machine_credential":"mc_from_server"}}`))
	}))
	t.Cleanup(server.Close)
	return server
}

// The container one-liner passes --code on every restart. The first start spends it; later
// ones must ignore it, because a single-use code cannot be spent twice.
func TestRunEnrollsOnceThenIgnoresTheCode(t *testing.T) {
	dir := t.TempDir()
	calls := 0
	server := enrollServer(t, &calls)

	config, credential, err := ensureEnrolled(context.Background(),
		&enrollFlags{stateDir: dir, url: server.URL, code: "code-1", name: "box", logFormat: "text"})
	if err != nil {
		t.Fatalf("first start: %v", err)
	}
	if credential != "mc_from_server" || config.ComputerID != "cmp_1" || config.URL != server.URL {
		t.Fatalf("config = %+v, credential = %q", config, credential)
	}
	if calls != 1 {
		t.Fatalf("the first start made %d enrollment calls", calls)
	}
	info, err := os.Stat(state.CredentialPath(dir))
	if err != nil {
		t.Fatalf("stat credential: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credential mode is %v", info.Mode().Perm())
	}

	config, credential, err = ensureEnrolled(context.Background(),
		&enrollFlags{stateDir: dir, url: server.URL, code: "code-1", name: "box", logFormat: "text"})
	if err != nil {
		t.Fatalf("second start: %v", err)
	}
	if calls != 1 {
		t.Fatalf("the second start spent the code again (%d calls)", calls)
	}
	if credential != "mc_from_server" || config.ComputerID != "cmp_1" {
		t.Fatalf("second start returned %+v, %q", config, credential)
	}
}

// The whole of `run` end to end, for the one outcome an operator has to be able to act on:
// a revoked credential leaves exit 3 and exactly one dial, not a reconnect loop.
func TestRunExitsThreeOnRevocationWithoutRetrying(t *testing.T) {
	dials := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		dials++
		socket, err := websocket.Accept(writer, request, nil)
		if err != nil {
			return
		}
		// Read hello, then revoke.
		_, _, _ = socket.Read(request.Context())
		_ = socket.Close(protocol.CloseRevoked, "revoked")
	}))
	defer server.Close()

	dir := t.TempDir()
	if err := state.WriteCredential(dir, "mc_secret"); err != nil {
		t.Fatalf("write credential: %v", err)
	}
	if err := state.SaveConfig(dir, state.Config{URL: server.URL, ComputerID: "cmp_1", Name: "box"}); err != nil {
		t.Fatalf("save config: %v", err)
	}

	done := make(chan int, 1)
	go func() { done <- run([]string{"run", "--state-dir", dir, "--allow-root", "--log-format", "text"}) }()
	select {
	case code := <-done:
		if code != exitRevoked {
			t.Fatalf("run exited %d, want %d", code, exitRevoked)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("run did not exit after the credential was revoked")
	}
	if dials != 1 {
		t.Fatalf("dialled %d times after a revocation, want 1", dials)
	}
}

// The container's lifecycle, in the three states it actually goes through: a first start
// with a code, a restart with the volume present, and a restart that still carries the now
// spent code in its arguments.
func TestContainerLifecycleEnrollsOnceThenServes(t *testing.T) {
	dir := t.TempDir()
	calls := 0
	server := enrollServer(t, &calls)

	first := &enrollFlags{stateDir: dir, url: server.URL, code: "code-1", name: "box", logFormat: "text"}
	config, credential, err := ensureEnrolled(context.Background(), first)
	if err != nil {
		t.Fatalf("first start: %v", err)
	}
	if calls != 1 || credential != "mc_from_server" || config.ComputerID != "cmp_1" {
		t.Fatalf("first start: %d calls, %+v, %q", calls, config, credential)
	}

	// Restart with the volume present and no code at all.
	restart := &enrollFlags{stateDir: dir, url: server.URL, logFormat: "text"}
	config, credential, err = ensureEnrolled(context.Background(), restart)
	if err != nil {
		t.Fatalf("restart: %v", err)
	}
	if calls != 1 || credential != "mc_from_server" {
		t.Fatalf("restart re-enrolled: %d calls", calls)
	}

	// Restart with the spent code still in the arguments, which is what --restart does.
	spent := &enrollFlags{stateDir: dir, url: server.URL, code: "code-1", logFormat: "text"}
	_, credential, err = ensureEnrolled(context.Background(), spent)
	if err != nil {
		t.Fatalf("restart with a spent code: %v", err)
	}
	if calls != 1 {
		t.Fatalf("the spent code was presented again: %d calls", calls)
	}
	if credential != "mc_from_server" {
		t.Fatalf("credential = %q", credential)
	}
}

// The image sets these rather than putting the code in the arguments, where ps and
// docker inspect would show it.
func TestURLAndCodeComeFromTheEnvironment(t *testing.T) {
	dir := t.TempDir()
	calls := 0
	server := enrollServer(t, &calls)
	t.Setenv(state.EnvURL, server.URL)
	t.Setenv(state.EnvEnrollCode, "code-from-env")

	set := flag.NewFlagSet("run", flag.ContinueOnError)
	flags := bindEnrollFlags(set)
	if err := set.Parse(nil); err != nil {
		t.Fatalf("parse: %v", err)
	}
	flags.stateDir = dir
	if flags.url != server.URL || flags.code != "code-from-env" {
		t.Fatalf("the environment was not read: %+v", flags)
	}

	if _, _, err := ensureEnrolled(context.Background(), flags); err != nil {
		t.Fatalf("enroll: %v", err)
	}
	if calls != 1 {
		t.Fatalf("%d enrollment calls", calls)
	}
	// The code is spent, and this process goes on to run commands.
	if os.Getenv(state.EnvEnrollCode) != "" {
		t.Fatal("the enrollment code was left in the environment")
	}
}

func TestCodeCanBeReadFromStandardInput(t *testing.T) {
	flags := &enrollFlags{codeStdin: true}
	if err := flags.resolveCode(strings.NewReader("code-from-stdin\n")); err != nil {
		t.Fatalf("resolveCode: %v", err)
	}
	if flags.code != "code-from-stdin" {
		t.Fatalf("code = %q", flags.code)
	}
	empty := &enrollFlags{codeStdin: true}
	if err := empty.resolveCode(strings.NewReader("\n")); err == nil {
		t.Fatal("an empty standard input was accepted")
	}
	untouched := &enrollFlags{code: "from-flag"}
	if err := untouched.resolveCode(strings.NewReader("ignored")); err != nil {
		t.Fatalf("resolveCode: %v", err)
	}
	if untouched.code != "from-flag" {
		t.Fatalf("stdin overrode the flag: %q", untouched.code)
	}
}

// Plaintext to a real host would put the enrollment code and then the credential on the wire.
func TestPlaintextToARemoteHostIsRefused(t *testing.T) {
	dir := t.TempDir()
	_, _, err := ensureEnrolled(context.Background(),
		&enrollFlags{stateDir: dir, url: "http://agentum.example.com", code: "c", logFormat: "text"})
	if !errors.Is(err, serverurl.ErrInsecure) {
		t.Fatalf("error = %v, want ErrInsecure", err)
	}
	if got := run([]string{"run", "--state-dir", dir, "--allow-root", "--url", "http://example.com", "--code", "c"}); got != exitUsage {
		t.Fatalf("run exited %d, want %d", got, exitUsage)
	}
}

func TestRunWithoutACredentialOrCodeIsNotEnrolled(t *testing.T) {
	_, _, err := ensureEnrolled(context.Background(),
		&enrollFlags{stateDir: t.TempDir(), url: "https://example.com", logFormat: "text"})
	if !errors.Is(err, state.ErrNotEnrolled) {
		t.Fatalf("error = %v, want ErrNotEnrolled", err)
	}
}

// Moving a computer to another server is a flag, not a re-enrollment.
func TestStoredURLCanBeOverriddenAtRun(t *testing.T) {
	dir := t.TempDir()
	if err := state.WriteCredential(dir, "mc"); err != nil {
		t.Fatalf("write credential: %v", err)
	}
	if err := state.SaveConfig(dir, state.Config{URL: "https://old.example.com", ComputerID: "cmp_1"}); err != nil {
		t.Fatalf("save config: %v", err)
	}
	config, _, err := ensureEnrolled(context.Background(),
		&enrollFlags{stateDir: dir, url: "https://new.example.com/", logFormat: "text"})
	if err != nil {
		t.Fatalf("ensureEnrolled: %v", err)
	}
	if config.URL != "https://new.example.com" {
		t.Fatalf("url = %q", config.URL)
	}
}

func TestAnEnrolledComputerWithNoStoredURLNeedsTheFlag(t *testing.T) {
	dir := t.TempDir()
	if err := state.WriteCredential(dir, "mc"); err != nil {
		t.Fatalf("write credential: %v", err)
	}
	if _, _, err := ensureEnrolled(context.Background(), &enrollFlags{stateDir: dir, logFormat: "text"}); err == nil {
		t.Fatal("a computer with no URL at all started anyway")
	}
}
