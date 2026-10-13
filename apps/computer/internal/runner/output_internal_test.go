package runner

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"agentum.dev/computer/internal/protocol"
)

func TestShortOutputIsKeptWhole(t *testing.T) {
	buffer := newCapped(headCap, tailCap)
	if _, err := buffer.Write([]byte("hello")); err != nil {
		t.Fatalf("write: %v", err)
	}
	text, total, truncated := buffer.snapshot()
	if text != "hello" || total != 5 || truncated {
		t.Fatalf("snapshot = %q, %d, %v", text, total, truncated)
	}
}

// Output that exactly fills the head and the tail is contiguous, so it must come back whole
// with no elision marker inserted into the middle of it.
func TestExactlyFullOutputIsNotTruncated(t *testing.T) {
	buffer := newCapped(8, 8)
	payload := bytes.Repeat([]byte("x"), 16)
	if _, err := buffer.Write(payload); err != nil {
		t.Fatalf("write: %v", err)
	}
	text, total, truncated := buffer.snapshot()
	if truncated || text != string(payload) || total != 16 {
		t.Fatalf("snapshot = %q, %d, %v", text, total, truncated)
	}
}

// The head and the tail are both kept, because a build or a test run puts the failure at the
// end and head-only truncation discards exactly the part worth reading.
func TestHeadAndTailAreBothKept(t *testing.T) {
	buffer := newCapped(4, 4)
	if _, err := buffer.Write([]byte("HEADmiddle-part-droppedTAIL")); err != nil {
		t.Fatalf("write: %v", err)
	}
	text, total, truncated := buffer.snapshot()
	if !truncated {
		t.Fatal("output over the cap must report truncation")
	}
	if total != 27 {
		t.Fatalf("total = %d, want every byte counted", total)
	}
	if !strings.HasPrefix(text, "HEAD") || !strings.HasSuffix(text, "TAIL") {
		t.Fatalf("snapshot = %q", text)
	}
	if !strings.Contains(text, "19 bytes dropped") {
		t.Fatalf("the marker does not name the dropped byte count: %q", text)
	}
}

// A cut that lands inside a multi-byte character must not emit half of it.
func TestTruncationCutsOnRuneBoundaries(t *testing.T) {
	buffer := newCapped(4, 4)
	// Four three-byte runes: the head cap falls one byte into the second, and the tail window
	// starts on the last byte of the third.
	if _, err := buffer.Write([]byte("界界界界")); err != nil {
		t.Fatalf("write: %v", err)
	}
	text, total, truncated := buffer.snapshot()
	if !truncated || total != 12 {
		t.Fatalf("snapshot = %q, %d, %v", text, total, truncated)
	}
	if !utf8.ValidString(text) {
		t.Fatalf("snapshot is not valid UTF-8: %q", text)
	}
	if strings.ContainsRune(text, utf8.RuneError) {
		t.Fatalf("snapshot carries a replacement character: %q", text)
	}
	want := "界" + fmt.Sprintf("\n[... %d bytes dropped ...]\n", 6) + "界"
	if text != want {
		t.Fatalf("snapshot = %q, want %q", text, want)
	}
}

// Binary output has no runes to respect; the seam trim must not eat into it beyond the three
// bytes a boundary cut can orphan.
func TestBinaryOutputKeepsItsBytes(t *testing.T) {
	buffer := newCapped(8, 8)
	payload := append(bytes.Repeat([]byte{0xff}, 8), bytes.Repeat([]byte{0xfe}, 24)...)
	if _, err := buffer.Write(payload); err != nil {
		t.Fatalf("write: %v", err)
	}
	text, _, truncated := buffer.snapshot()
	if !truncated {
		t.Fatal("output over the cap must report truncation")
	}
	head, _, found := strings.Cut(text, "\n[...")
	if !found {
		t.Fatalf("no marker in %q", text)
	}
	if len(head) < 5 {
		t.Fatalf("the seam trim ate %d of 8 head bytes", 8-len(head))
	}
}

// The two streams share one budget, so a command that floods both cannot push a frame over
// the relay's limit on its own.
func TestCombinedBudgetStaysUnderTheCap(t *testing.T) {
	if headCap+tailCap+markerReserve != perStreamCap {
		t.Fatalf("per-stream budget does not add up: %d + %d + %d != %d", headCap, tailCap, markerReserve, perStreamCap)
	}
	if perStreamCap*2 != protocol.ExecOutputMaxBytes {
		t.Fatalf("two streams of %d exceed the %d budget", perStreamCap, protocol.ExecOutputMaxBytes)
	}
	marker := fmt.Sprintf("\n[... %d bytes dropped ...]\n", int64(1)<<62)
	if len(marker) > markerReserve {
		t.Fatalf("the widest marker is %d bytes, over the %d reserved", len(marker), markerReserve)
	}
}
