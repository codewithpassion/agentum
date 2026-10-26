package desktop

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
)

// chromiumSelfTest starts Chromium headless with its sandbox on and asks it to render a blank
// page. Chromium refuses to start at all when its sandbox cannot, so a rendered page is proof.
// A throwaway profile keeps the test off the persistent one, whose lock a running browser holds;
// the flag comes after the wrapper's own, and Chromium takes the last value.
func (d *Desktop) chromiumSelfTest(ctx context.Context) error {
	profile, err := os.MkdirTemp(d.dir, "chromium-selftest-")
	if err != nil {
		return fmt.Errorf("chromium sandbox self-test could not create a profile: %w", err)
	}
	defer func() { _ = os.RemoveAll(profile) }()

	testCtx, cancel := context.WithTimeout(ctx, selfTestTimeout)
	defer cancel()
	command := exec.CommandContext(testCtx, "chromium",
		"--headless=new", "--disable-gpu", "--no-first-run",
		"--user-data-dir="+profile, "--dump-dom", "about:blank")
	command.Env = d.commandEnv()
	command.Dir = d.dir
	command.SysProcAttr = processAttributes()
	command.Cancel = func() error {
		return syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
	}
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	command.WaitDelay = stopGrace
	runErr := command.Run()
	if runErr == nil && strings.Contains(stdout.String(), "<html") {
		return nil
	}
	return fmt.Errorf("chromium sandbox self-test failed: %s", selfTestFailure(runErr, stderr.String()))
}

// selfTestFailure picks the line that says why: Chromium's stderr is mostly noise.
func selfTestFailure(runErr error, stderr string) string {
	for _, line := range strings.Split(stderr, "\n") {
		if strings.Contains(line, "No usable sandbox") || strings.Contains(line, "namespace") {
			if _, message, found := strings.Cut(line, "] "); found {
				return strings.TrimSpace(message)
			}
			return strings.TrimSpace(line)
		}
	}
	if runErr != nil {
		return runErr.Error()
	}
	return "it rendered nothing"
}
