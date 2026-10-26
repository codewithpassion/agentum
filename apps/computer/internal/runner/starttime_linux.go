//go:build linux

package runner

import (
	"os"
	"strconv"
	"strings"
)

// processStartTime reads field 22 of /proc/<pid>/stat, the tick at which the process started.
// Together with the pid it identifies a process across pid reuse.
func processStartTime(pid int) (uint64, bool) {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, false
	}
	// The comm field is parenthesised and may itself contain spaces and parentheses, so the
	// numeric fields start after its final ')'.
	line := string(raw)
	commEnd := strings.LastIndexByte(line, ')')
	if commEnd < 0 || commEnd+2 >= len(line) {
		return 0, false
	}
	fields := strings.Fields(line[commEnd+2:])
	// Field 3 (state) is now index 0, so field 22 (starttime) is index 19.
	const startTimeIndex = 19
	if len(fields) <= startTimeIndex {
		return 0, false
	}
	value, err := strconv.ParseUint(fields[startTimeIndex], 10, 64)
	if err != nil {
		return 0, false
	}
	return value, true
}
