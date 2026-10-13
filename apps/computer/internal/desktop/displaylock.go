package desktop

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// displayLockPath is where an X server on the display records its pid.
func displayLockPath(display int) string {
	return fmt.Sprintf("/tmp/.X%d-lock", display)
}

// lockHolder reads the pid an X server wrote to its lock file, and 0 when there is no lock.
func lockHolder(path string) (int, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read %s: %w", path, err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		return 0, fmt.Errorf("%s does not hold a process id", path)
	}
	return pid, nil
}

// checkDisplayFree refuses a display whose lock names a live process: that is someone else's X
// server, and the desktop never drives it. A stale lock is left for Xvfb, which clears it.
func checkDisplayFree(path string, display int) error {
	pid, err := lockHolder(path)
	if err != nil {
		return err
	}
	if pid == 0 || !alive(pid) {
		return nil
	}
	return fmt.Errorf("display :%d is already in use by process %d; stop it or pick another display with --desktop-display", display, pid)
}

// ownsDisplay passes only while the display's lock names the Xvfb this desktop started.
func (d *Desktop) ownsDisplay() error {
	ours := int(d.xvfbPID.Load())
	if ours == 0 {
		return errors.New("the X server is not running")
	}
	holder, err := lockHolder(d.lockPath)
	if err != nil {
		return err
	}
	if holder != ours {
		return fmt.Errorf("display :%d is held by process %d, not by this desktop's X server", d.display, holder)
	}
	return nil
}

func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
