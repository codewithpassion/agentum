// Command agentum-computer connects a machine you own to Agentum, so an agent's commands
// and file transfers run here instead of in a disposable sandbox.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
)

// version is stamped at build time with -ldflags "-X main.version=…".
var version = "0.0.0-dev"

// Exit codes. The README's troubleshooting table is written against these.
const (
	exitOK       = 0
	exitFailure  = 1
	exitUsage    = 2
	exitRevoked  = 3
	exitNotReady = 4
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		usage(os.Stderr)
		return exitUsage
	}
	command, rest := args[0], args[1:]
	switch command {
	case "enroll":
		return runEnroll(rest)
	case "run":
		return runServe(rest)
	case "status":
		return runStatus(rest)
	case "version", "--version", "-v":
		fmt.Println(version)
		return exitOK
	case "help", "--help", "-h":
		usage(os.Stdout)
		return exitOK
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", command)
		usage(os.Stderr)
		return exitUsage
	}
}

func usage(to *os.File) {
	fmt.Fprint(to, `agentum-computer — connect a machine you own to Agentum

Usage:
  agentum-computer enroll --url <base> --code <code> [--name <name>] [--state-dir <dir>] [--desktop]
  agentum-computer run [--url <base>] [--code <code>] [flags]
  agentum-computer status [--state-dir <dir>]
  agentum-computer version

Environment:
  AGENTUM_URL           default for --url
  AGENTUM_ENROLL_CODE   default for --code
  AGENTUM_STATE_DIR     default for --state-dir

Run "agentum-computer <command> --help" for the flags of one command.
`)
}

// notifyContext cancels on the signals a service manager sends, so a stop takes the running
// commands with it rather than orphaning them.
func notifyContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
}

func newLogger(format string) *slog.Logger {
	if format == "text" {
		return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	}
	return slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
}

func fail(logger *slog.Logger, message string, err error) int {
	if logger == nil {
		fmt.Fprintf(os.Stderr, "%s: %v\n", message, err)
		return exitFailure
	}
	logger.Error(message, "error", err.Error())
	return exitFailure
}

var errNotEnrolled = errors.New("this computer is not enrolled; run `agentum-computer enroll --url <base> --code <code>` first")
