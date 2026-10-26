//go:build unix

package files

import "syscall"

// syscallNonblock keeps an open of a FIFO nobody is writing to from blocking the request.
const syscallNonblock = syscall.O_NONBLOCK
