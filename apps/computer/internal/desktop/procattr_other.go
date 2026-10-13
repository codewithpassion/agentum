//go:build !linux

package desktop

import "syscall"

// processAttributes only has to compile here: Start refuses every OS but Linux.
func processAttributes() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}
