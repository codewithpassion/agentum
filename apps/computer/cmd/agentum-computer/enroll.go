package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"agentum.dev/computer/internal/enroll"
	"agentum.dev/computer/internal/serverurl"
	"agentum.dev/computer/internal/state"
)

type enrollFlags struct {
	url       string
	code      string
	codeStdin bool
	name      string
	stateDir  string
	logFormat string
	desktop   bool
}

func bindEnrollFlags(set *flag.FlagSet) *enrollFlags {
	flags := &enrollFlags{}
	set.StringVar(&flags.url, "url", os.Getenv(state.EnvURL), "base URL of the Agentum server, for example https://agentum.example.com")
	set.StringVar(&flags.code, "code", os.Getenv(state.EnvEnrollCode), "single-use enrollment code; prefer "+state.EnvEnrollCode+" or --code-stdin, because a flag is visible in ps")
	set.BoolVar(&flags.codeStdin, "code-stdin", false, "read the enrollment code from standard input")
	set.StringVar(&flags.name, "name", "", "hostname to report instead of this machine's own")
	set.StringVar(&flags.stateDir, "state-dir", state.DefaultDir(), "where the credential and config are kept")
	set.StringVar(&flags.logFormat, "log-format", "text", "json or text")
	set.BoolVar(&flags.desktop, "desktop", false, "turn the virtual desktop on for every later run (Linux only)")
	return flags
}

// resolveCode reads the code from stdin when asked. A code on the command line is visible to
// every other user through ps and through docker inspect, so it is the last resort.
func (f *enrollFlags) resolveCode(stdin io.Reader) error {
	if !f.codeStdin {
		return nil
	}
	reader := bufio.NewReader(stdin)
	line, err := reader.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("read the enrollment code from standard input: %w", err)
	}
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return errors.New("--code-stdin was given but standard input carried no code")
	}
	f.code = trimmed
	return nil
}

func runEnroll(args []string) int {
	set := flag.NewFlagSet("enroll", flag.ContinueOnError)
	flags := bindEnrollFlags(set)
	if err := set.Parse(args); err != nil {
		return exitUsage
	}
	logger := newLogger(flags.logFormat)

	if err := flags.resolveCode(os.Stdin); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		return exitUsage
	}
	if strings.TrimSpace(flags.url) == "" || strings.TrimSpace(flags.code) == "" {
		fmt.Fprintf(os.Stderr, "both --url and --code are required (or %s and %s)\n", state.EnvURL, state.EnvEnrollCode)
		return exitUsage
	}

	ctx, stop := notifyContext()
	defer stop()

	result, err := performEnrollment(ctx, flags)
	if err != nil {
		switch {
		case errors.Is(err, enroll.ErrCodeRejected):
			fmt.Fprintln(os.Stderr, "The enrollment code was refused. Codes are single use and expire after 15 minutes; issue a new one from Settings → Computers.")
			return exitFailure
		case errors.Is(err, serverurl.ErrInsecure), errors.Is(err, enroll.ErrRedirected):
			fmt.Fprintln(os.Stderr, err.Error())
			return exitUsage
		default:
			return fail(logger, "enrollment failed", err)
		}
	}

	logger.Info("enrolled",
		"computer_id", result.ComputerID,
		"state_dir", flags.stateDir,
		"credential", state.CredentialPath(flags.stateDir))
	fmt.Printf("Enrolled as %s. Start the daemon with:\n  agentum-computer run\n", result.ComputerID)
	return exitOK
}

// performEnrollment exchanges the code and stores what came back. It is also the path `run`
// takes when it is handed a code and has no credential yet, which is what makes the container
// one-liner work across a restart.
func performEnrollment(ctx context.Context, flags *enrollFlags) (enroll.Result, error) {
	hostname := state.Hostname(flags.name)
	result, err := enroll.Do(ctx, enroll.DefaultClient(), flags.url, enroll.Request{
		EnrollmentCode: strings.TrimSpace(flags.code),
		Hostname:       hostname,
		OS:             state.OS(),
		Arch:           state.Arch(),
		Version:        version,
	})
	// The code is spent either way, and this process goes on to run commands that would
	// otherwise inherit it through the environment.
	scrubCode(flags)
	if err != nil {
		return enroll.Result{}, err
	}
	if err := state.WriteCredential(flags.stateDir, result.MachineCredential); err != nil {
		return enroll.Result{}, fmt.Errorf("store the machine credential: %w", err)
	}
	canonical, err := serverurl.Canonical(flags.url)
	if err != nil {
		return enroll.Result{}, err
	}
	config := state.Config{URL: canonical, ComputerID: result.ComputerID, Name: hostname, Desktop: flags.desktop}
	if err := state.SaveConfig(flags.stateDir, config); err != nil {
		return enroll.Result{}, fmt.Errorf("store the config: %w", err)
	}
	return result, nil
}

// scrubCode clears the enrollment code from this process, so a command it later runs cannot
// read it back out of the environment.
func scrubCode(flags *enrollFlags) {
	flags.code = ""
	_ = os.Unsetenv(state.EnvEnrollCode)
}
