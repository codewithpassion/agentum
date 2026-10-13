package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"agentum.dev/computer/internal/agent"
	"agentum.dev/computer/internal/audit"
	"agentum.dev/computer/internal/conn"
	"agentum.dev/computer/internal/desktop"
	"agentum.dev/computer/internal/files"
	"agentum.dev/computer/internal/policy"
	"agentum.dev/computer/internal/protocol"
	"agentum.dev/computer/internal/runner"
	"agentum.dev/computer/internal/serverurl"
	"agentum.dev/computer/internal/state"
)

// nameList collects a repeatable flag, because one value per flag reads better in a unit file
// than one flag holding a delimiter that a value may contain.
type nameList []string

func (n *nameList) String() string { return strings.Join(*n, ", ") }

func (n *nameList) Set(value string) error {
	if strings.TrimSpace(value) == "" {
		return errors.New("an empty value is not useful here; remove the flag instead")
	}
	*n = append(*n, value)
	return nil
}

func runServe(args []string) int {
	set := flag.NewFlagSet("run", flag.ContinueOnError)
	url := set.String("url", os.Getenv(state.EnvURL), "base URL of the Agentum server; defaults to the enrolled one")
	code := set.String("code", os.Getenv(state.EnvEnrollCode), "enrollment code to use when this computer is not enrolled yet")
	codeStdin := set.Bool("code-stdin", false, "read the enrollment code from standard input")
	name := set.String("name", "", "hostname to report instead of this machine's own")
	stateDir := set.String("state-dir", state.DefaultDir(), "where the credential, config and audit log are kept")
	workdir := set.String("workdir", "", "root for the per-session directories; defaults to <state-dir>/sessions")
	allowRoot := set.Bool("allow-root", false, "run as root anyway")
	readOnly := set.Bool("read-only", false, "refuse every exec and every write")
	workdirOnly := set.Bool("workdir-only", false, "refuse file operations outside the working directory")
	maxConcurrent := set.Int("max-concurrent", 4, "how many commands may run at once")
	maxQueue := set.Int("max-queue", 32, "how many commands may wait for a slot")
	maxExecSeconds := set.Int("max-exec-seconds", 1800, "longest deadline this computer will honour for one command")
	maxFileBytes := set.Int64("max-file-bytes", 256<<20, "largest file this computer will send or receive")
	logFormat := set.String("log-format", "json", "json or text")
	auditMaxBytes := set.Int64("audit-max-bytes", audit.DefaultMaxBytes, "size at which the audit log is rotated")
	auditKeep := set.Int("audit-keep", audit.DefaultKeep, "how many rotated audit logs to keep")
	withDesktop := set.Bool("desktop", false, "run a virtual X desktop agents can see and drive (Linux only); also enabled by \"desktop\": true in config.json")
	desktopDisplay := set.Int("desktop-display", desktop.DefaultDisplay, "X display number the desktop takes")
	var allow, deny, allowEnv nameList
	set.Var(&allow, "allow", "regular expression a command must match in full; repeatable, and an empty list allows everything")
	set.Var(&deny, "deny", "regular expression a command must not match; repeatable, and checked before --allow")
	set.Var(&allowEnv, "allow-env", "environment variable the server may set even on a constrained computer; repeatable")

	if err := set.Parse(args); err != nil {
		return exitUsage
	}
	logger := newLogger(*logFormat)

	if err := state.CheckRoot(os.Getuid(), *allowRoot); err != nil {
		logger.Error(err.Error())
		return exitUsage
	}
	if err := state.Ensure(*stateDir); err != nil {
		return fail(logger, "could not prepare the state directory", err)
	}

	ctx, stop := notifyContext()
	defer stop()

	enrollment := &enrollFlags{url: *url, code: *code, codeStdin: *codeStdin, name: *name, stateDir: *stateDir, logFormat: *logFormat, desktop: *withDesktop}
	if err := enrollment.resolveCode(os.Stdin); err != nil {
		logger.Error(err.Error())
		return exitUsage
	}
	config, credential, err := ensureEnrolled(ctx, enrollment)
	if err != nil {
		switch {
		case errors.Is(err, state.ErrNotEnrolled):
			logger.Error(errNotEnrolled.Error())
			return exitUsage
		case errors.Is(err, serverurl.ErrInsecure):
			logger.Error(err.Error())
			return exitUsage
		default:
			return fail(logger, "could not start", err)
		}
	}

	sessions := *workdir
	if sessions == "" {
		sessions = state.SessionsDir(*stateDir)
	}
	if err := policy.EnsureDirectory(sessions); err != nil {
		return fail(logger, "could not prepare the working directory", err)
	}

	rules, err := policy.New(policy.Options{
		ReadOnly:    *readOnly,
		Allow:       allow,
		Deny:        deny,
		AllowEnv:    allowEnv,
		WorkdirOnly: *workdirOnly,
		Workdir:     sessions,
		StateDir:    *stateDir,
		SessionsDir: sessions,
	})
	if err != nil {
		return fail(logger, "the local policy is not usable", err)
	}
	// One value from here on: the policy's resolved root is what the server is told about, what
	// commands default to, and what the containment checks compare against.
	sessions = rules.Workdir()

	log, err := audit.Open(*stateDir, audit.Options{MaxBytes: *auditMaxBytes, Keep: *auditKeep})
	if err != nil {
		return fail(logger, "could not open the audit log", err)
	}
	defer func() { _ = log.Close() }()

	capabilities := state.DetectCapabilities()
	desktopEnabled := *withDesktop || config.Desktop
	var screen *desktop.Desktop
	var commandEnv map[string]string
	if desktopEnabled {
		// Checked before hello is built: hello is fixed for a connection, and the server only
		// sends desktop ops to a computer that said it can take them. A desktop that fails the
		// check is stopped, so commands get no DISPLAY that nothing is serving.
		screen, err = desktop.Launch(ctx, desktop.Options{StateDir: *stateDir, Display: *desktopDisplay, Logger: logger})
		if screen != nil {
			// The desktop outlives any one connection but not this function, whatever ends it.
			defer screen.Stop()
			commandEnv = screen.Env()
		}
		capabilities.Desktop, capabilities.DesktopUnavailableReason = desktop.Capability(err)
		if err != nil {
			logger.Warn("the desktop is not available to agents", "error", err.Error())
		}
	}

	// Commands started by a previous run survive a kill, reparented to PID 1, so they are
	// reaped before this one accepts anything new.
	if reaped := runner.Sweep(*stateDir, logger); reaped > 0 {
		logger.Warn("reaped commands left behind by a previous run", "count", reaped)
	}

	commands := runner.New(runner.Options{
		BaseContext:   ctx,
		MaxConcurrent: *maxConcurrent,
		MaxQueue:      *maxQueue,
		MaxTimeout:    time.Duration(*maxExecSeconds) * time.Second,
		DefaultCwd:    sessions,
		StateDir:      *stateDir,
		BaseEnv:       commandEnv,
		Logger:        logger,
	})
	defer commands.Shutdown()

	transfers := files.NewTransfers(files.Options{
		ResolveWrite: rules.CheckWrite,
		MaxFileBytes: *maxFileBytes,
	})
	worker := agent.New(rules, commands, transfers, screen, log, logger)
	hello := protocol.Hello{
		Type:            "hello",
		ProtocolVersion: protocol.Version,
		Hostname:        state.Hostname(firstNonEmpty(*name, config.Name)),
		OS:              state.OS(),
		Arch:            state.Arch(),
		Version:         version,
		RunAsUser:       state.RunAsUser(),
		Workdir:         sessions,
		Capabilities:    capabilities,
	}

	client, err := conn.New(conn.Options{
		BaseURL:        config.URL,
		Credential:     credential,
		Hello:          hello,
		Dispatch:       worker.Dispatch,
		Prepare:        worker.Prepare,
		OnRefused:      worker.OnRefused,
		OnDisconnect:   worker.OnDisconnect,
		OnReplyDropped: worker.OnReplyDropped,
		Logger:         logger,
	})
	if err != nil {
		if errors.Is(err, serverurl.ErrInsecure) {
			logger.Error(err.Error())
			return exitUsage
		}
		return fail(logger, "could not prepare the connection", err)
	}

	logger.Info("starting",
		"computer_id", config.ComputerID,
		"url", config.URL,
		"version", version,
		"run_as", hello.RunAsUser,
		"state_dir", *stateDir,
		"workdir", sessions,
		"read_only", *readOnly,
		"workdir_only", *workdirOnly,
		"allow_patterns", len(allow),
		"deny_patterns", len(deny),
		"allow_env", len(allowEnv),
		"max_exec_seconds", *maxExecSeconds,
		"max_file_bytes", *maxFileBytes,
		"desktop", desktopEnabled,
		"capabilities", hello.Capabilities)

	err = client.Run(ctx)
	// Shutdown runs through the deferred call above, so nothing this daemon started outlives
	// it on purpose.
	switch {
	case errors.Is(err, conn.ErrRevoked):
		return exitRevoked
	case errors.Is(err, context.Canceled), err == nil:
		logger.Info("stopped")
		return exitOK
	default:
		return fail(logger, "stopped", err)
	}
}

// ensureEnrolled loads the stored credential, or exchanges a code for one. The container
// one-liner passes the same code on every restart, so a code presented by an already-enrolled
// computer is ignored rather than spent.
func ensureEnrolled(ctx context.Context, flags *enrollFlags) (state.Config, string, error) {
	credential, err := state.ReadCredential(flags.stateDir)
	if err == nil {
		scrubCode(flags)
		config, configErr := state.LoadConfig(flags.stateDir)
		if configErr != nil && !errors.Is(configErr, state.ErrNotEnrolled) {
			return state.Config{}, "", configErr
		}
		if strings.TrimSpace(flags.url) != "" {
			canonical, urlErr := serverurl.Canonical(flags.url)
			if urlErr != nil {
				return state.Config{}, "", urlErr
			}
			config.URL = canonical
		}
		if config.URL == "" {
			return state.Config{}, "", errors.New("no server URL is stored and none was given; pass --url")
		}
		return config, credential, nil
	}
	if !errors.Is(err, state.ErrNotEnrolled) {
		return state.Config{}, "", err
	}
	if strings.TrimSpace(flags.code) == "" {
		return state.Config{}, "", state.ErrNotEnrolled
	}

	enrollCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	result, err := performEnrollment(enrollCtx, flags)
	if err != nil {
		return state.Config{}, "", fmt.Errorf("enroll: %w", err)
	}
	config, err := state.LoadConfig(flags.stateDir)
	if err != nil {
		return state.Config{}, "", err
	}
	return config, result.MachineCredential, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
