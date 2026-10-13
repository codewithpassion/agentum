package files_test

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"agentum.dev/computer/internal/files"
	"agentum.dev/computer/internal/protocol"
)

func chunkRequest(transferID string, path string, seq int, data []byte, final bool, digest *string) protocol.FilePutRequest {
	return protocol.FilePutRequest{
		TransferID: transferID,
		Path:       path,
		Seq:        seq,
		DataB64:    base64.StdEncoding.EncodeToString(data),
		Final:      final,
		SHA256:     digest,
	}
}

func hexDigest(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// A whole file goes up in chunk-sized frames and comes back down the same way, and the
// digests agree at both ends.
func TestChunkedRoundTrip(t *testing.T) {
	payload := make([]byte, protocol.ChunkBytes*2+1234)
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("make payload: %v", err)
	}
	digest := hexDigest(payload)
	target := filepath.Join(t.TempDir(), "nested", "payload.bin")

	transfers := files.NewTransfers(files.Options{})
	for seq, offset := 0, 0; offset < len(payload); seq, offset = seq+1, offset+protocol.ChunkBytes {
		end := min(offset+protocol.ChunkBytes, len(payload))
		final := end == len(payload)
		var expected *string
		if final {
			expected = &digest
		}
		result, err := transfers.Put(chunkRequest("x", target, seq, payload[offset:end], final, expected))
		if err != nil {
			t.Fatalf("put chunk %d: %v", seq, err)
		}
		if final {
			if result.SHA256 == nil || *result.SHA256 != digest {
				t.Fatalf("final chunk digest = %v", result.SHA256)
			}
			if result.BytesWritten != int64(len(payload)) {
				t.Fatalf("bytes_written = %d, want %d", result.BytesWritten, len(payload))
			}
		}
	}
	if transfers.Open() != 0 {
		t.Fatal("the transfer was not closed")
	}

	var downloaded bytes.Buffer
	var offset int64
	for {
		result, err := files.Get(protocol.FileGetRequest{Path: target, Offset: offset, MaxBytes: protocol.ChunkBytes}, target, 0)
		if err != nil {
			t.Fatalf("get at %d: %v", offset, err)
		}
		if offset == 0 {
			if result.SHA256 == nil || *result.SHA256 != digest {
				t.Fatalf("the first window carried %v, want the whole-file digest", result.SHA256)
			}
		} else if result.SHA256 != nil {
			t.Fatal("only the first window carries the digest")
		}
		decoded, err := base64.StdEncoding.DecodeString(result.DataB64)
		if err != nil {
			t.Fatalf("decode window: %v", err)
		}
		downloaded.Write(decoded)
		offset += int64(len(decoded))
		if result.EOF {
			break
		}
	}
	if hexDigest(downloaded.Bytes()) != digest {
		t.Fatal("the downloaded bytes do not match what was uploaded")
	}
}

func TestDigestMismatchIsRejectedAndTheFileRemoved(t *testing.T) {
	target := filepath.Join(t.TempDir(), "f.bin")
	transfers := files.NewTransfers(files.Options{})
	wrong := hexDigest([]byte("something else"))
	_, err := transfers.Put(chunkRequest("x", target, 0, []byte("payload"), true, &wrong))
	if !errors.Is(err, files.ErrBadRequest) {
		t.Fatalf("error = %v, want ErrBadRequest", err)
	}
	if _, statErr := os.Stat(target); statErr == nil {
		t.Fatal("a file that failed its digest was left on disk")
	}
}

func TestOversizedChunkIsRefused(t *testing.T) {
	target := filepath.Join(t.TempDir(), "f.bin")
	transfers := files.NewTransfers(files.Options{})
	oversized := make([]byte, protocol.ChunkBytes+1)
	_, err := transfers.Put(chunkRequest("x", target, 0, oversized, false, nil))
	if !errors.Is(err, files.ErrBadRequest) {
		t.Fatalf("error = %v, want ErrBadRequest", err)
	}
}

// The relay pipelines a window of chunks and each one is handled on its own goroutine, so
// arrival order says nothing about sequence order. A chunk ahead of its turn waits.
func TestPipelinedChunksArriveInAnyOrder(t *testing.T) {
	const chunks = 8
	payload := make([]byte, 0, chunks*64)
	pieces := make([][]byte, chunks)
	for index := range chunks {
		piece := bytes.Repeat([]byte{byte('a' + index)}, 64)
		pieces[index] = piece
		payload = append(payload, piece...)
	}
	digest := hexDigest(payload)
	target := filepath.Join(t.TempDir(), "pipelined.bin")
	transfers := files.NewTransfers(files.Options{WaitTimeout: 10 * time.Second})

	// Deliberately shuffled, with the final chunk dispatched first.
	order := []int{7, 3, 0, 6, 1, 5, 2, 4}
	results := make([]error, chunks)
	var group sync.WaitGroup
	for _, seq := range order {
		group.Add(1)
		go func() {
			defer group.Done()
			final := seq == chunks-1
			var expected *string
			if final {
				expected = &digest
			}
			_, err := transfers.Put(chunkRequest("x", target, seq, pieces[seq], final, expected))
			results[seq] = err
		}()
		// A short stagger makes the out-of-order arrival deterministic rather than lucky.
		time.Sleep(5 * time.Millisecond)
	}
	group.Wait()

	for seq, err := range results {
		if err != nil {
			t.Fatalf("chunk %d: %v", seq, err)
		}
	}
	written, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if hexDigest(written) != digest {
		t.Fatalf("the file was assembled out of order: %q", written)
	}
	if transfers.Open() != 0 {
		t.Fatal("the transfer was not closed")
	}
}

// A redelivered chunk must not rewrite the file or fail; the relay may reissue a request it
// did not see answered.
func TestARedeliveredChunkIsIdempotent(t *testing.T) {
	target := filepath.Join(t.TempDir(), "f.bin")
	transfers := files.NewTransfers(files.Options{})
	if _, err := transfers.Put(chunkRequest("x", target, 0, []byte("aa"), false, nil)); err != nil {
		t.Fatalf("first chunk: %v", err)
	}
	if _, err := transfers.Put(chunkRequest("x", target, 1, []byte("bb"), false, nil)); err != nil {
		t.Fatalf("second chunk: %v", err)
	}
	result, err := transfers.Put(chunkRequest("x", target, 0, []byte("aa"), false, nil))
	if err != nil {
		t.Fatalf("redelivered chunk: %v", err)
	}
	if result.BytesWritten != 2 {
		t.Fatalf("bytes_written = %d", result.BytesWritten)
	}
	payload := []byte("aabbcc")
	digest := hexDigest(payload)
	if _, err := transfers.Put(chunkRequest("x", target, 2, []byte("cc"), true, &digest)); err != nil {
		t.Fatalf("final chunk: %v", err)
	}
	written, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(written) != string(payload) {
		t.Fatalf("the redelivery corrupted the file: %q", written)
	}
}

// A chunk whose predecessor never arrives gives the transfer up rather than pinning a
// goroutine for as long as the connection lasts.
func TestAChunkWhosePredecessorNeverArrivesGivesUp(t *testing.T) {
	target := filepath.Join(t.TempDir(), "f.bin")
	transfers := files.NewTransfers(files.Options{WaitTimeout: 100 * time.Millisecond})
	if _, err := transfers.Put(chunkRequest("x", target, 0, []byte("a"), false, nil)); err != nil {
		t.Fatalf("first chunk: %v", err)
	}
	_, err := transfers.Put(chunkRequest("x", target, 2, []byte("c"), false, nil))
	if !errors.Is(err, files.ErrBadRequest) {
		t.Fatalf("error = %v, want ErrBadRequest", err)
	}
	if transfers.Open() != 0 {
		t.Fatal("the abandoned transfer is still open")
	}
	if _, statErr := os.Stat(target); statErr == nil {
		t.Fatal("the partial file was left on disk")
	}
}

// Abandoning on a dropped socket has to wake whatever was waiting for a chunk that will now
// never come, rather than leave it there for the whole timeout.
func TestAbandonWakesAWaitingChunk(t *testing.T) {
	target := filepath.Join(t.TempDir(), "f.bin")
	transfers := files.NewTransfers(files.Options{WaitTimeout: time.Hour})
	if _, err := transfers.Put(chunkRequest("x", target, 0, []byte("a"), false, nil)); err != nil {
		t.Fatalf("first chunk: %v", err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := transfers.Put(chunkRequest("x", target, 2, []byte("c"), false, nil))
		done <- err
	}()
	time.Sleep(200 * time.Millisecond)
	transfers.Abandon()

	select {
	case err := <-done:
		if !errors.Is(err, files.ErrBadRequest) {
			t.Fatalf("error = %v, want ErrBadRequest", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Abandon left a chunk waiting")
	}
}

// A transfer that opens far beyond the window is not a pipelined chunk; it is a stale frame
// from before a reconnect, and the server is expected to restart from chunk zero.
func TestATransferCannotOpenBeyondTheWindow(t *testing.T) {
	target := filepath.Join(t.TempDir(), "f.bin")
	transfers := files.NewTransfers(files.Options{Window: 4})
	_, err := transfers.Put(chunkRequest("x", target, 9, []byte("a"), false, nil))
	if !errors.Is(err, files.ErrBadRequest) {
		t.Fatalf("error = %v, want ErrBadRequest", err)
	}
	if transfers.Open() != 0 {
		t.Fatal("a refused chunk opened a transfer")
	}
}

func TestAbandonClosesOpenTransfers(t *testing.T) {
	target := filepath.Join(t.TempDir(), "f.bin")
	transfers := files.NewTransfers(files.Options{})
	if _, err := transfers.Put(chunkRequest("x", target, 0, []byte("a"), false, nil)); err != nil {
		t.Fatalf("first chunk: %v", err)
	}
	transfers.Abandon()
	if transfers.Open() != 0 {
		t.Fatal("Abandon left a transfer open")
	}
	if _, statErr := os.Stat(target); statErr == nil {
		t.Fatal("Abandon left the partial file on disk")
	}
}

// A request for a window larger than the chunk size must be clamped, not honoured: an
// oversized frame closes the socket for every other request on the computer.
func TestGetWindowIsClampedToTheChunkSize(t *testing.T) {
	target := filepath.Join(t.TempDir(), "big.bin")
	payload := make([]byte, protocol.ChunkBytes*2)
	if err := os.WriteFile(target, payload, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	result, err := files.Get(protocol.FileGetRequest{Path: target, Offset: 0, MaxBytes: 16 << 20}, target, 0)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(result.DataB64)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(decoded) != protocol.ChunkBytes {
		t.Fatalf("window = %d bytes, want it clamped to %d", len(decoded), protocol.ChunkBytes)
	}
	if result.EOF {
		t.Fatal("a clamped first window of a two-chunk file is not the end")
	}
}

// An upload that fails must not have destroyed what was already there. Writing the
// destination directly would truncate it on chunk zero and delete it on a digest mismatch.
func TestAFailedUploadLeavesTheOriginalIntact(t *testing.T) {
	target := filepath.Join(t.TempDir(), "important.txt")
	original := []byte("the file that was already here")
	if err := os.WriteFile(target, original, 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	transfers := files.NewTransfers(files.Options{})
	wrong := hexDigest([]byte("something else"))
	if _, err := transfers.Put(chunkRequest("x", target, 0, []byte("replacement"), true, &wrong)); !errors.Is(err, files.ErrBadRequest) {
		t.Fatalf("error = %v, want ErrBadRequest", err)
	}
	survived, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(survived) != string(original) {
		t.Fatalf("a failed upload changed the file: %q", survived)
	}
	if leftovers := tempFilesIn(t, filepath.Dir(target)); len(leftovers) != 0 {
		t.Fatalf("temporary files were left behind: %v", leftovers)
	}
}

// An abandoned transfer is the same story: nothing was renamed, so nothing is lost.
func TestAnAbandonedUploadLeavesTheOriginalIntact(t *testing.T) {
	target := filepath.Join(t.TempDir(), "important.txt")
	if err := os.WriteFile(target, []byte("original"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	transfers := files.NewTransfers(files.Options{})
	if _, err := transfers.Put(chunkRequest("x", target, 0, []byte("partial"), false, nil)); err != nil {
		t.Fatalf("first chunk: %v", err)
	}
	transfers.Abandon()
	survived, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(survived) != "original" {
		t.Fatalf("an abandoned upload changed the file: %q", survived)
	}
	if leftovers := tempFilesIn(t, filepath.Dir(target)); len(leftovers) != 0 {
		t.Fatalf("temporary files were left behind: %v", leftovers)
	}
}

// A command running on this machine can plant a symlink between the policy check and the
// write. The upload must not follow it back out of the working directory.
func TestASymlinkAtTheDestinationIsRefused(t *testing.T) {
	root := t.TempDir()
	secret := filepath.Join(t.TempDir(), "authorized_keys")
	if err := os.WriteFile(secret, []byte("original key"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	target := filepath.Join(root, "innocent.txt")
	if err := os.Symlink(secret, target); err != nil {
		t.Skipf("symlinks are not available here: %v", err)
	}
	transfers := files.NewTransfers(files.Options{})
	digest := hexDigest([]byte("attacker key"))
	_, err := transfers.Put(chunkRequest("x", target, 0, []byte("attacker key"), true, &digest))
	if !errors.Is(err, files.ErrNotRegular) {
		t.Fatalf("error = %v, want ErrNotRegular", err)
	}
	survived, err := os.ReadFile(secret)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(survived) != "original key" {
		t.Fatalf("the upload was written through the symlink: %q", survived)
	}
}

// A symlink swapped in after the transfer opened is caught by the re-check at commit time.
func TestASymlinkSwappedInMidTransferIsRefused(t *testing.T) {
	root := t.TempDir()
	secret := filepath.Join(t.TempDir(), "authorized_keys")
	if err := os.WriteFile(secret, []byte("original key"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	target := filepath.Join(root, "upload.txt")

	transfers := files.NewTransfers(files.Options{})
	if _, err := transfers.Put(chunkRequest("x", target, 0, []byte("attacker "), false, nil)); err != nil {
		t.Fatalf("first chunk: %v", err)
	}
	// The window the check-then-open race lives in.
	if err := os.Symlink(secret, target); err != nil {
		t.Skipf("symlinks are not available here: %v", err)
	}
	digest := hexDigest([]byte("attacker key"))
	if _, err := transfers.Put(chunkRequest("x", target, 1, []byte("key"), true, &digest)); !errors.Is(err, files.ErrNotRegular) {
		t.Fatalf("error = %v, want ErrNotRegular", err)
	}
	survived, err := os.ReadFile(secret)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(survived) != "original key" {
		t.Fatalf("the upload reached the symlink's target: %q", survived)
	}
}

// A device or a FIFO has no end; digesting one never returns and opening one can block.
func TestNonRegularFilesAreRefusedForDownload(t *testing.T) {
	if _, err := os.Stat("/dev/zero"); err != nil {
		t.Skip("/dev/zero is not available here")
	}
	_, err := files.Get(protocol.FileGetRequest{Path: "/dev/zero"}, "/dev/zero", 0)
	if !errors.Is(err, files.ErrNotRegular) {
		t.Fatalf("error = %v, want ErrNotRegular", err)
	}
	if _, _, err := files.Digest("/dev/zero"); !errors.Is(err, files.ErrNotRegular) {
		t.Fatalf("Digest error = %v, want ErrNotRegular", err)
	}
}

func TestUploadingOntoANonRegularFileIsRefused(t *testing.T) {
	if _, err := os.Stat("/dev/null"); err != nil {
		t.Skip("/dev/null is not available here")
	}
	transfers := files.NewTransfers(files.Options{})
	_, err := transfers.Put(chunkRequest("x", "/dev/null", 0, []byte("x"), false, nil))
	if !errors.Is(err, files.ErrNotRegular) {
		t.Fatalf("error = %v, want ErrNotRegular", err)
	}
}

func TestSizeCapsApplyBothWays(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "big.bin")
	transfers := files.NewTransfers(files.Options{MaxFileBytes: 8})
	_, err := transfers.Put(chunkRequest("x", target, 0, []byte("more than eight bytes"), false, nil))
	if !errors.Is(err, files.ErrTooLarge) {
		t.Fatalf("upload error = %v, want ErrTooLarge", err)
	}

	existing := filepath.Join(directory, "existing.bin")
	if err := os.WriteFile(existing, make([]byte, 64), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := files.Get(protocol.FileGetRequest{Path: existing}, existing, 8); !errors.Is(err, files.ErrTooLarge) {
		t.Fatalf("download error = %v, want ErrTooLarge", err)
	}
}

// Each open transfer can park a window of decoded chunks, so the number of them is bounded.
func TestOpenTransfersAreCapped(t *testing.T) {
	directory := t.TempDir()
	transfers := files.NewTransfers(files.Options{MaxOpen: 2})
	for index := range 2 {
		target := filepath.Join(directory, "f"+string(rune('a'+index)))
		if _, err := transfers.Put(chunkRequest("t"+string(rune('a'+index)), target, 0, []byte("x"), false, nil)); err != nil {
			t.Fatalf("transfer %d: %v", index, err)
		}
	}
	_, err := transfers.Put(chunkRequest("overflow", filepath.Join(directory, "fz"), 0, []byte("x"), false, nil))
	if !errors.Is(err, files.ErrTooManyTransfers) {
		t.Fatalf("error = %v, want ErrTooManyTransfers", err)
	}
}

// The policy owns the path decision; the transfer asks it, and asks again before the rename.
func TestTheResolverCanRefuseAPath(t *testing.T) {
	refusal := errors.New("nope")
	transfers := files.NewTransfers(files.Options{
		ResolveWrite: func(string) (string, error) { return "", refusal },
	})
	if _, err := transfers.Put(chunkRequest("x", "/anywhere", 0, []byte("x"), false, nil)); !errors.Is(err, refusal) {
		t.Fatalf("error = %v, want the resolver's refusal", err)
	}
}

func tempFilesIn(t *testing.T, directory string) []string {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read %s: %v", directory, err)
	}
	var leftovers []string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".agentum-upload-") {
			leftovers = append(leftovers, entry.Name())
		}
	}
	return leftovers
}

// The two are distinguishable on purpose: the server maps each to its own sandbox error.
func TestGetRefusesADirectoryAndAMissingFileDistinguishably(t *testing.T) {
	dir := t.TempDir()
	if _, err := files.Get(protocol.FileGetRequest{Path: dir}, dir, 0); !errors.Is(err, files.ErrIsDirectory) {
		t.Fatalf("directory error = %v, want ErrIsDirectory", err)
	}
	missing := filepath.Join(dir, "nope")
	if _, err := files.Get(protocol.FileGetRequest{Path: missing}, missing, 0); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing-file error = %v, want os.ErrNotExist", err)
	}
}

func TestUploadedFileIsOwnerOnly(t *testing.T) {
	target := filepath.Join(t.TempDir(), "f.bin")
	transfers := files.NewTransfers(files.Options{})
	digest := hexDigest([]byte("x"))
	if _, err := transfers.Put(chunkRequest("x", target, 0, []byte("x"), true, &digest)); err != nil {
		t.Fatalf("put: %v", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("uploaded file mode is %v", info.Mode().Perm())
	}
}
