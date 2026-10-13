//go:build !unix

package files

// syscallNonblock has no equivalent outside unix; the mode check after the open still rejects
// anything that is not a regular file.
const syscallNonblock = 0
