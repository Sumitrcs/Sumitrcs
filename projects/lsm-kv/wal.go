package lsmkv

import (
	"bufio"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"io"
	"os"
)

// WAL record layout:
//
//	crc32(4) | len(4) | kind(1) | keyLen(uvarint) | key | value
//
// The CRC covers everything after the length field. A torn write at the end
// of the file (power loss mid-append) is detected and silently truncated on
// replay; corruption in the middle is reported.
type wal struct {
	f    *os.File
	w    *bufio.Writer
	sync bool
}

const (
	kindPut byte = 1
	kindDel byte = 2
)

func openWAL(path string, sync bool) (*wal, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &wal{f: f, w: bufio.NewWriter(f), sync: sync}, nil
}

func (l *wal) append(kind byte, key, value []byte) error {
	body := make([]byte, 0, 1+binary.MaxVarintLen64+len(key)+len(value))
	body = append(body, kind)
	body = binary.AppendUvarint(body, uint64(len(key)))
	body = append(body, key...)
	body = append(body, value...)

	var hdr [8]byte
	binary.LittleEndian.PutUint32(hdr[0:], crc32.ChecksumIEEE(body))
	binary.LittleEndian.PutUint32(hdr[4:], uint32(len(body)))
	if _, err := l.w.Write(hdr[:]); err != nil {
		return err
	}
	if _, err := l.w.Write(body); err != nil {
		return err
	}
	if err := l.w.Flush(); err != nil {
		return err
	}
	if l.sync {
		return l.f.Sync()
	}
	return nil
}

func (l *wal) close() error {
	if err := l.w.Flush(); err != nil {
		return err
	}
	return l.f.Close()
}

// replayWAL feeds every intact record to fn.
func replayWAL(path string, fn func(kind byte, key, value []byte)) error {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()

	r := bufio.NewReader(f)
	var good int64
	for {
		var hdr [8]byte
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				break
			}
			return err
		}
		n := binary.LittleEndian.Uint32(hdr[4:])
		body := make([]byte, n)
		if _, err := io.ReadFull(r, body); err != nil {
			break // torn tail
		}
		if crc32.ChecksumIEEE(body) != binary.LittleEndian.Uint32(hdr[0:]) {
			// A bad record followed by more data means real corruption.
			if _, err := r.Peek(1); err == nil {
				return ErrCorrupt
			}
			break
		}
		kind := body[0]
		klen, w := binary.Uvarint(body[1:])
		if w <= 0 || 1+w+int(klen) > len(body) {
			return ErrCorrupt
		}
		key := body[1+w : 1+w+int(klen)]
		value := body[1+w+int(klen):]
		fn(kind, key, value)
		good += int64(8 + n)
	}
	// Drop any torn tail so future appends start on a clean boundary.
	return os.Truncate(path, good)
}
