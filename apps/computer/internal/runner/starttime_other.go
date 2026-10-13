//go:build !linux && !darwin

package runner

// processStartTime has no portable equivalent. The sweep treats "unknown" as "do not touch
// it", so on such a platform an orphaned group is reported and left alone rather than risking
// a recycled pid.
func processStartTime(_ int) (uint64, bool) {
	return 0, false
}
