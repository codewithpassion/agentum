//go:build !unix

package state

import "io/fs"

// ownerUID has no portable equivalent; the caller treats "unknown" as "do not object".
func ownerUID(_ fs.FileInfo) (int, bool) {
	return 0, false
}
