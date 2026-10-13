package desktop

import "syscall"

// processAttributes puts a desktop process in its own group and ties it to the daemon, so a
// killed daemon does not leave an X server holding the display number.
func processAttributes() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGTERM}
}
