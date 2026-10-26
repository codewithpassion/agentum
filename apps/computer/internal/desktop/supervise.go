package desktop

import (
	"context"
	"os/exec"
	"syscall"
	"time"
)

// process is one supervised program. before, when set, gates every start, so a client of the
// display waits for the display; running, when set, hears the pid while it runs and 0 after.
type process struct {
	name    string
	argv    []string
	before  func(context.Context) error
	running func(pid int)
}

// supervise keeps one process running until ctx ends, restarting it with backoff.
func (d *Desktop) supervise(ctx context.Context, p process) {
	d.supervised.Add(1)
	go func() {
		defer d.supervised.Done()
		delay := restartMin
		for ctx.Err() == nil {
			if p.before != nil {
				if err := p.before(ctx); err != nil {
					return
				}
			}
			startedAt := time.Now()
			err := d.runOnce(ctx, p)
			if ctx.Err() != nil {
				return
			}
			if time.Since(startedAt) >= stableAfter {
				delay = restartMin
			}
			d.logger.Warn("a desktop process exited; restarting it", "process", p.name, "error", errorText(err), "restart_in", delay.String())
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			delay = min(delay*2, restartMax)
		}
	}()
}

// runOnce runs the process in its own group, so stopping it also stops whatever it started.
func (d *Desktop) runOnce(ctx context.Context, p process) error {
	command := exec.CommandContext(ctx, p.argv[0], p.argv[1:]...)
	command.Env = d.commandEnv()
	command.Dir = d.dir
	command.SysProcAttr = processAttributes()
	command.Cancel = func() error {
		return syscall.Kill(-command.Process.Pid, syscall.SIGTERM)
	}
	command.WaitDelay = stopGrace
	if err := command.Start(); err != nil {
		return err
	}
	if p.running != nil {
		p.running(command.Process.Pid)
		defer p.running(0)
	}
	return command.Wait()
}

func errorText(err error) string {
	if err == nil {
		return "exited cleanly"
	}
	return err.Error()
}
