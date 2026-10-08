package tailnet

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
)

const uploadChunkBytes = 32 * 1024

// UploadSource is pulled by HTTP, one bounded chunk at a time. Empty means EOF.
// Close must interrupt a pending read and is also called on request cancellation.
type UploadSource interface {
	ReadChunk() ([]byte, error)
	Close()
}

// PrepareStream keeps the wire JSON and Content-Length without a whole JNI string.
func (node *Node) PrepareStream(method, target, token string, length int64, source UploadSource) (*Response, error) {
	if source == nil || length < 0 || method != "POST" {
		if source != nil {
			source.Close()
		}
		return nil, errors.New("invalid embedded upload")
	}
	reader := &uploadReader{source: source, remaining: length}
	if length == 0 {
		reader.Close()
	}
	response, err := node.prepare(method, target, token, reader, length)
	if err != nil {
		reader.Close()
		return nil, err
	}
	if length != 0 {
		context.AfterFunc(response.request.Context(), func() { reader.Close() })
	}
	return response, nil
}

type uploadReader struct {
	source    UploadSource
	remaining int64
	chunk     []byte
	closed    atomic.Bool
	closeOnce sync.Once
}

func (reader *uploadReader) Read(target []byte) (int, error) {
	if len(target) == 0 {
		return 0, nil
	}
	if reader.closed.Load() {
		return 0, io.ErrClosedPipe
	}
	if len(reader.chunk) == 0 {
		chunk, err := reader.source.ReadChunk()
		if err != nil {
			reader.Close()
			return 0, err
		}
		if reader.closed.Load() {
			return 0, io.ErrClosedPipe
		}
		if len(chunk) == 0 {
			if reader.remaining != 0 {
				return 0, io.ErrUnexpectedEOF
			}
			return 0, io.EOF
		}
		if len(chunk) > uploadChunkBytes || int64(len(chunk)) > reader.remaining {
			reader.Close()
			return 0, errors.New("embedded upload chunk or length exceeded")
		}
		reader.chunk = chunk
	}
	count := copy(target, reader.chunk)
	reader.chunk = reader.chunk[count:]
	reader.remaining -= int64(count)
	return count, nil
}

func (reader *uploadReader) Close() error {
	reader.closeOnce.Do(func() {
		reader.closed.Store(true)
		reader.source.Close()
	})
	return nil
}
