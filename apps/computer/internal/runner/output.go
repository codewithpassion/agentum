package runner

import (
	"fmt"
	"sync"
	"unicode/utf8"

	"agentum.dev/computer/internal/protocol"
)

// The budget is split evenly across the two streams, and each stream keeps a head and a tail:
// a build or a test run puts the failure at the end, so head-only truncation throws away the
// part that matters. markerReserve keeps the elision note inside the budget.
const (
	perStreamCap  = protocol.ExecOutputMaxBytes / 2
	markerReserve = 64
	headCap       = (perStreamCap - markerReserve) / 2
	tailCap       = perStreamCap - markerReserve - headCap
)

// capped counts every byte written to it and keeps the head and the tail within the budget.
type capped struct {
	mu      sync.Mutex
	head    []byte
	tail    []byte
	total   int64
	headMax int
	tailMax int
}

func newCapped(headMax int, tailMax int) *capped {
	return &capped{headMax: headMax, tailMax: tailMax}
}

func (c *capped) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total += int64(len(p))

	rest := p
	if room := c.headMax - len(c.head); room > 0 {
		take := min(room, len(rest))
		c.head = append(c.head, rest[:take]...)
		rest = rest[take:]
	}
	if len(rest) == 0 || c.tailMax == 0 {
		return len(p), nil
	}
	// Keep only the last tailMax bytes: append, then drop from the front.
	if len(rest) >= c.tailMax {
		c.tail = append(c.tail[:0], rest[len(rest)-c.tailMax:]...)
		return len(p), nil
	}
	c.tail = append(c.tail, rest...)
	if overflow := len(c.tail) - c.tailMax; overflow > 0 {
		c.tail = append(c.tail[:0], c.tail[overflow:]...)
	}
	return len(p), nil
}

// snapshot renders the stream. The seams are cut back to rune boundaries so a multi-byte
// character split by the cap does not reach the model as a replacement character.
func (c *capped) snapshot() (text string, total int64, truncated bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Everything fit in the head, or the head and the tail meet: the bytes are contiguous and
	// there is no seam to repair.
	if c.total <= int64(len(c.head)) {
		return string(c.head), c.total, false
	}
	if int64(len(c.head)+len(c.tail)) >= c.total {
		return string(c.head) + string(c.tail), c.total, false
	}

	head := trimPartialSuffix(c.head)
	tail := trimPartialPrefix(c.tail)
	dropped := c.total - int64(len(head)+len(tail))
	marker := fmt.Sprintf("\n[... %d bytes dropped ...]\n", dropped)
	return string(head) + marker + string(tail), c.total, true
}

// trimPartialSuffix removes an incomplete rune left at the end of a byte-aligned cut. A cut can
// orphan at most three bytes, so the loop is bounded: binary output keeps its bytes.
func trimPartialSuffix(value []byte) []byte {
	for range utf8.UTFMax - 1 {
		if len(value) == 0 {
			return value
		}
		last, size := utf8.DecodeLastRune(value)
		if last != utf8.RuneError || size > 1 {
			return value
		}
		value = value[:len(value)-1]
	}
	return value
}

// trimPartialPrefix removes an incomplete rune left at the start of a byte-aligned cut.
func trimPartialPrefix(value []byte) []byte {
	for range utf8.UTFMax - 1 {
		if len(value) == 0 {
			return value
		}
		first, size := utf8.DecodeRune(value)
		if first != utf8.RuneError || size > 1 {
			return value
		}
		value = value[1:]
	}
	return value
}
