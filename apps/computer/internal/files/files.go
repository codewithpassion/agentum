// Package files serves the chunked upload and download halves of the protocol. Every chunk is
// bounded and the whole file is verified, because an oversized frame closes the socket for
// every other request on the computer, not just this one.
package files

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"agentum.dev/computer/internal/protocol"
)

var (
	// ErrBadRequest covers a chunk the client refuses to act on at all.
	ErrBadRequest = errors.New("bad file request")
	// ErrIsDirectory and ErrNotRegular are separate so the server can map each one.
	ErrIsDirectory = errors.New("path is a directory")
	ErrNotRegular  = errors.New("path is not a regular file")
	// ErrTooLarge is the local size cap, in either direction.
	ErrTooLarge = errors.New("file is larger than this computer allows")
	// ErrTooManyTransfers is backpressure, not a fault in the request.
	ErrTooManyTransfers = errors.New("too many uploads are already open")
)

const (
	// defaultWindow is how many chunks of one transfer may be in flight at once. The relay is
	// expected to pipeline a small window, and each chunk arrives on its own goroutine, so
	// arrival order says nothing about sequence order.
	defaultWindow = 32
	// defaultWaitTimeout bounds how long a chunk waits for its predecessor before the whole
	// transfer is given up, so a server that never sends chunk zero cannot pin a goroutine.
	defaultWaitTimeout = 60 * time.Second
	// defaultMaxOpen bounds how much a hostile or broken server can park in memory: each open
	// transfer can hold up to defaultWindow chunks waiting their turn.
	defaultMaxOpen = 8
	// defaultMaxFileBytes matches the server's own download cap.
	defaultMaxFileBytes = 256 << 20
)

type transfer struct {
	cond *sync.Cond
	// Uploads land in a temporary file beside the destination and are renamed into place only
	// after the digest agrees. Writing the destination directly would truncate an existing
	// file on chunk zero and delete it on a mismatch, and would follow a symlink planted
	// between the policy check and the open.
	temp     *os.File
	tempPath string
	dest     string
	nextSeq  int
	written  int64
	waiting  int
	closed   bool
}

type Options struct {
	// ResolveWrite applies the local policy to a destination path. It is called when the
	// transfer opens and again immediately before the rename, because the two are up to a
	// minute apart and a command can plant a symlink in between.
	ResolveWrite func(path string) (string, error)
	// Window caps the chunks of one transfer that may wait for their turn.
	Window int
	// WaitTimeout bounds one chunk's wait for its predecessor.
	WaitTimeout time.Duration
	// MaxOpen caps how many uploads may be in progress at once.
	MaxOpen int
	// MaxFileBytes caps a single file in either direction.
	MaxFileBytes int64
}

// Transfers tracks the uploads that are still in progress, keyed by transfer id.
type Transfers struct {
	options Options

	mu   sync.Mutex
	open map[string]*transfer
}

func NewTransfers(options Options) *Transfers {
	if options.Window <= 0 {
		options.Window = defaultWindow
	}
	if options.WaitTimeout <= 0 {
		options.WaitTimeout = defaultWaitTimeout
	}
	if options.MaxOpen <= 0 {
		options.MaxOpen = defaultMaxOpen
	}
	if options.MaxFileBytes <= 0 {
		options.MaxFileBytes = defaultMaxFileBytes
	}
	if options.ResolveWrite == nil {
		options.ResolveWrite = func(path string) (string, error) { return filepath.Abs(path) }
	}
	return &Transfers{options: options, open: map[string]*transfer{}}
}

// MaxFileBytes is the configured cap, for status output and for the download check.
func (t *Transfers) MaxFileBytes() int64 {
	return t.options.MaxFileBytes
}

// Abandon discards every open upload, waking anything waiting on one. Only the temporary
// files go; a destination that was already there is untouched, because nothing has been
// renamed over it.
func (t *Transfers) Abandon() {
	t.mu.Lock()
	open := t.open
	t.open = map[string]*transfer{}
	t.mu.Unlock()
	for _, entry := range open {
		closeAndRemove(entry)
	}
}

// Open reports how many uploads are in progress, for status output.
func (t *Transfers) Open() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.open)
}

// Put appends one chunk. Chunks may arrive out of order because the relay pipelines them and
// each is handled on its own goroutine, so a chunk ahead of its turn waits rather than
// failing the transfer.
func (t *Transfers) Put(request protocol.FilePutRequest) (protocol.FilePutResult, error) {
	if request.TransferID == "" {
		return protocol.FilePutResult{}, fmt.Errorf("%w: no transfer id", ErrBadRequest)
	}
	if request.Seq < 0 {
		return protocol.FilePutResult{}, fmt.Errorf("%w: negative chunk sequence", ErrBadRequest)
	}
	data, err := base64.StdEncoding.DecodeString(request.DataB64)
	if err != nil {
		return protocol.FilePutResult{}, fmt.Errorf("%w: decode chunk %d: %s", ErrBadRequest, request.Seq, err)
	}
	if len(data) > protocol.ChunkBytes {
		return protocol.FilePutResult{}, fmt.Errorf("%w: chunk %d is %d bytes, over the %d limit",
			ErrBadRequest, request.Seq, len(data), protocol.ChunkBytes)
	}

	entry, err := t.entryFor(request)
	if err != nil {
		return protocol.FilePutResult{}, err
	}

	written, err := t.writeInOrder(entry, request, data)
	if err != nil {
		t.discard(request.TransferID)
		return protocol.FilePutResult{}, err
	}
	if !request.Final {
		return protocol.FilePutResult{BytesWritten: written}, nil
	}
	result, err := t.commit(request, entry)
	if err != nil {
		t.discard(request.TransferID)
		return protocol.FilePutResult{}, err
	}
	return result, nil
}

// entryFor finds or creates the transfer. A brand new transfer may be opened by any chunk
// inside the window, because the first frame off the wire is not necessarily chunk zero.
func (t *Transfers) entryFor(request protocol.FilePutRequest) (*transfer, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if entry, open := t.open[request.TransferID]; open {
		return entry, nil
	}
	if request.Seq >= t.options.Window {
		return nil, fmt.Errorf("%w: transfer %s opens at chunk %d, beyond the %d chunk window",
			ErrBadRequest, request.TransferID, request.Seq, t.options.Window)
	}
	if len(t.open) >= t.options.MaxOpen {
		return nil, fmt.Errorf("%w: %d are already open", ErrTooManyTransfers, len(t.open))
	}
	entry := &transfer{cond: sync.NewCond(&sync.Mutex{})}
	t.open[request.TransferID] = entry
	return entry, nil
}

// writeInOrder waits for this chunk's turn, then appends it. A chunk the transfer has already
// taken is answered without rewriting, which is what makes a redelivered frame harmless.
func (t *Transfers) writeInOrder(entry *transfer, request protocol.FilePutRequest, data []byte) (int64, error) {
	entry.cond.L.Lock()
	defer entry.cond.L.Unlock()

	if entry.closed {
		return 0, fmt.Errorf("%w: transfer %s is no longer open", ErrBadRequest, request.TransferID)
	}
	if request.Seq < entry.nextSeq {
		// Already written. Answering with the byte count keeps a redelivery idempotent.
		return int64(len(data)), nil
	}
	if entry.waiting >= t.options.Window {
		return 0, fmt.Errorf("%w: %d chunks of transfer %s are already waiting",
			ErrBadRequest, entry.waiting, request.TransferID)
	}

	if request.Seq > entry.nextSeq {
		entry.waiting++
		timer := time.AfterFunc(t.options.WaitTimeout, func() {
			entry.cond.L.Lock()
			defer entry.cond.L.Unlock()
			entry.cond.Broadcast()
		})
		deadline := time.Now().Add(t.options.WaitTimeout)
		for request.Seq > entry.nextSeq && !entry.closed && time.Now().Before(deadline) {
			entry.cond.Wait()
		}
		entry.waiting--
		timer.Stop()
	}

	if entry.closed {
		return 0, fmt.Errorf("%w: transfer %s was abandoned while chunk %d waited",
			ErrBadRequest, request.TransferID, request.Seq)
	}
	if request.Seq < entry.nextSeq {
		return int64(len(data)), nil
	}
	if request.Seq > entry.nextSeq {
		return 0, fmt.Errorf("%w: chunk %d of transfer %s waited for chunk %d and it never arrived",
			ErrBadRequest, request.Seq, request.TransferID, entry.nextSeq)
	}

	if entry.temp == nil {
		if err := t.openTemp(entry, request.Path); err != nil {
			return 0, err
		}
	}
	if entry.written+int64(len(data)) > t.options.MaxFileBytes {
		return 0, fmt.Errorf("%w: %s would exceed the %d byte limit",
			ErrTooLarge, entry.dest, t.options.MaxFileBytes)
	}
	if _, err := entry.temp.Write(data); err != nil {
		return 0, fmt.Errorf("write %s: %w", entry.tempPath, err)
	}
	entry.written += int64(len(data))
	entry.nextSeq++
	entry.cond.Broadcast()
	return int64(len(data)), nil
}

// openTemp resolves the destination through the policy and opens a fresh file beside it.
// CreateTemp opens with O_CREATE|O_EXCL, so it cannot be redirected through a symlink that
// someone planted at the name it picked.
func (t *Transfers) openTemp(entry *transfer, requestedPath string) error {
	dest, err := t.options.ResolveWrite(requestedPath)
	if err != nil {
		return err
	}
	if err := checkDestination(dest); err != nil {
		return err
	}
	directory := filepath.Dir(dest)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create the directory for %s: %w", dest, err)
	}
	temp, err := os.CreateTemp(directory, ".agentum-upload-*")
	if err != nil {
		return fmt.Errorf("open a temporary file beside %s: %w", dest, err)
	}
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		_ = os.Remove(temp.Name())
		return fmt.Errorf("restrict %s: %w", temp.Name(), err)
	}
	entry.temp = temp
	entry.tempPath = temp.Name()
	entry.dest = dest
	return nil
}

// checkDestination refuses to aim an upload at anything but a regular file. Renaming over a
// device or a FIFO is not something the server ever means to ask for.
func checkDestination(dest string) error {
	info, err := os.Lstat(dest)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("stat %s: %w", dest, err)
	}
	switch {
	case info.IsDir():
		return fmt.Errorf("%w: %s", ErrIsDirectory, dest)
	case info.Mode()&os.ModeSymlink != 0:
		// The rename replaces the link rather than writing through it, but refusing is
		// clearer than silently turning someone's symlink into a file.
		return fmt.Errorf("%w: %s is a symbolic link", ErrNotRegular, dest)
	case !info.Mode().IsRegular():
		return fmt.Errorf("%w: %s", ErrNotRegular, dest)
	}
	return nil
}

// commit flushes the upload, verifies it, and only then puts it where it was asked for. The
// destination is re-checked first: the policy passed it up to a minute ago, and a command
// running on this machine could have changed what the path means since.
func (t *Transfers) commit(request protocol.FilePutRequest, entry *transfer) (protocol.FilePutResult, error) {
	t.mu.Lock()
	delete(t.open, request.TransferID)
	t.mu.Unlock()

	entry.cond.L.Lock()
	entry.closed = true
	temp := entry.temp
	entry.temp = nil
	tempPath := entry.tempPath
	dest := entry.dest
	entry.cond.Broadcast()
	entry.cond.L.Unlock()

	if temp == nil {
		return protocol.FilePutResult{}, fmt.Errorf("%w: transfer %s wrote nothing", ErrBadRequest, request.TransferID)
	}
	defer func() { _ = os.Remove(tempPath) }()

	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return protocol.FilePutResult{}, fmt.Errorf("flush %s: %w", tempPath, err)
	}
	if err := temp.Close(); err != nil {
		return protocol.FilePutResult{}, fmt.Errorf("close %s: %w", tempPath, err)
	}

	digest, size, err := Digest(tempPath)
	if err != nil {
		return protocol.FilePutResult{}, err
	}
	if request.SHA256 != nil && *request.SHA256 != digest {
		return protocol.FilePutResult{}, fmt.Errorf("%w: digest mismatch for %s: expected %s, wrote %s",
			ErrBadRequest, dest, *request.SHA256, digest)
	}

	recheck, err := t.options.ResolveWrite(request.Path)
	if err != nil {
		return protocol.FilePutResult{}, err
	}
	if recheck != dest {
		return protocol.FilePutResult{}, fmt.Errorf("%w: %s no longer resolves to %s", ErrBadRequest, request.Path, dest)
	}
	if err := checkDestination(dest); err != nil {
		return protocol.FilePutResult{}, err
	}
	// Replacing a file should not silently change what can run or read it. A rename gives
	// the destination the temporary file's 0600, so an existing file's bits are carried over
	// first; a new file keeps 0600.
	if existing, statErr := os.Stat(dest); statErr == nil {
		if err := os.Chmod(tempPath, existing.Mode().Perm()); err != nil {
			return protocol.FilePutResult{}, fmt.Errorf("carry over the mode of %s: %w", dest, err)
		}
	}
	if err := os.Rename(tempPath, dest); err != nil {
		return protocol.FilePutResult{}, fmt.Errorf("move the upload into place at %s: %w", dest, err)
	}
	return protocol.FilePutResult{BytesWritten: size, SHA256: &digest}, nil
}

func (t *Transfers) discard(transferID string) {
	t.mu.Lock()
	entry, open := t.open[transferID]
	delete(t.open, transferID)
	t.mu.Unlock()
	if open {
		closeAndRemove(entry)
	}
}

// closeAndRemove throws away the temporary file and nothing else: a destination that already
// existed is never touched by a transfer that did not finish.
func closeAndRemove(entry *transfer) {
	entry.cond.L.Lock()
	entry.closed = true
	temp := entry.temp
	entry.temp = nil
	tempPath := entry.tempPath
	entry.cond.Broadcast()
	entry.cond.L.Unlock()

	if temp != nil {
		_ = temp.Close()
	}
	if tempPath != "" {
		_ = os.Remove(tempPath)
	}
}

// Get reads one window of a file. The window is clamped to the chunk size whatever the
// request asks for, so no reply can grow into a frame that would close the socket.
func Get(request protocol.FileGetRequest, resolvedPath string, maxFileBytes int64) (protocol.FileGetResult, error) {
	if request.Offset < 0 {
		return protocol.FileGetResult{}, fmt.Errorf("%w: negative offset", ErrBadRequest)
	}
	if maxFileBytes <= 0 {
		maxFileBytes = defaultMaxFileBytes
	}

	// O_NONBLOCK so opening a FIFO nobody is writing to returns instead of blocking here, and
	// the mode is checked from the open file rather than from a separate stat.
	handle, err := os.OpenFile(resolvedPath, os.O_RDONLY|syscallNonblock, 0)
	if err != nil {
		return protocol.FileGetResult{}, fmt.Errorf("open %s: %w", resolvedPath, err)
	}
	defer func() { _ = handle.Close() }()

	info, err := handle.Stat()
	if err != nil {
		return protocol.FileGetResult{}, fmt.Errorf("stat %s: %w", resolvedPath, err)
	}
	if info.IsDir() {
		return protocol.FileGetResult{}, fmt.Errorf("%w: %s", ErrIsDirectory, resolvedPath)
	}
	if !info.Mode().IsRegular() {
		// A device or a FIFO has no size and no end; digesting one never returns.
		return protocol.FileGetResult{}, fmt.Errorf("%w: %s", ErrNotRegular, resolvedPath)
	}
	if info.Size() > maxFileBytes {
		return protocol.FileGetResult{}, fmt.Errorf("%w: %s is %d bytes, over the %d byte limit",
			ErrTooLarge, resolvedPath, info.Size(), maxFileBytes)
	}

	maxBytes := request.MaxBytes
	if maxBytes <= 0 || maxBytes > protocol.ChunkBytes {
		maxBytes = protocol.ChunkBytes
	}
	buffer := make([]byte, maxBytes)
	read, err := handle.ReadAt(buffer, request.Offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return protocol.FileGetResult{}, fmt.Errorf("read %s: %w", resolvedPath, err)
	}
	result := protocol.FileGetResult{
		DataB64: base64.StdEncoding.EncodeToString(buffer[:read]),
		EOF:     request.Offset+int64(read) >= info.Size(),
		Size:    info.Size(),
	}
	// The whole-file digest rides on the first window so the caller can verify the download
	// without asking for a second pass over the file.
	if request.Offset == 0 {
		digest, _, digestErr := Digest(resolvedPath)
		if digestErr != nil {
			return protocol.FileGetResult{}, digestErr
		}
		result.SHA256 = &digest
	}
	return result, nil
}

// Digest returns the hex sha256 of a regular file and its size.
func Digest(path string) (string, int64, error) {
	handle, err := os.OpenFile(path, os.O_RDONLY|syscallNonblock, 0)
	if err != nil {
		return "", 0, fmt.Errorf("open %s for hashing: %w", path, err)
	}
	defer func() { _ = handle.Close() }()
	info, err := handle.Stat()
	if err != nil {
		return "", 0, fmt.Errorf("stat %s: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return "", 0, fmt.Errorf("%w: %s", ErrNotRegular, path)
	}
	hasher := sha256.New()
	size, err := io.Copy(hasher, handle)
	if err != nil {
		return "", 0, fmt.Errorf("hash %s: %w", path, err)
	}
	return hex.EncodeToString(hasher.Sum(nil)), size, nil
}
