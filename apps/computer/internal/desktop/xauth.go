package desktop

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
)

const (
	cookieBytes = 16
	cookieName  = "MIT-MAGIC-COOKIE-1"
	// familyWild matches any host, so the entry keeps working when a container or a laptop
	// changes its hostname; libXau and the in-process client both honour it.
	familyWild = 0xffff
)

// WriteXauthority writes a one-entry Xauthority file at 0600, without depending on xauth being
// installed. The format is big-endian: family, then length-prefixed address, display number,
// auth name and auth data.
func WriteXauthority(path string, display string, cookie []byte) error {
	var entry bytes.Buffer
	_ = binary.Write(&entry, binary.BigEndian, uint16(familyWild))
	for _, field := range [][]byte{nil, []byte(display), []byte(cookieName), cookie} {
		_ = binary.Write(&entry, binary.BigEndian, uint16(len(field)))
		entry.Write(field)
	}

	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	// A file left from an earlier run may have been created with a wider mode.
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return fmt.Errorf("restrict %s: %w", path, err)
	}
	if _, err := file.Write(entry.Bytes()); err != nil {
		_ = file.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close %s: %w", path, err)
	}
	return nil
}
