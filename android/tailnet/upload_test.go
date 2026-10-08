package tailnet

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fixtureUpload struct {
	reader        io.Reader
	calls, closes atomic.Int32
}

func (source *fixtureUpload) ReadChunk() ([]byte, error) {
	source.calls.Add(1)
	buffer := make([]byte, uploadChunkBytes)
	count, err := source.reader.Read(buffer)
	if err == io.EOF {
		err = nil
	}
	return buffer[:count], err
}
func (source *fixtureUpload) Close() { source.closes.Add(1) }

func TestStreamUploadHeadersLengthAndExactBody(t *testing.T) {
	payload := "{\"text\":\"中文😀\",\"data\":\"" + strings.Repeat("ABCD", 24579) + "\"}"
	source := &fixtureUpload{reader: strings.NewReader(payload)}
	node := testNode(func(request *http.Request) (*http.Response, error) {
		if request.ContentLength != int64(len(payload)) || request.GetBody != nil {
			t.Fatal("body was buffered or lost its fixed length")
		}
		if request.Header.Get("Authorization") != "Bearer fixture" || request.Header.Get("Content-Type") != "application/json; charset=utf-8" {
			t.Fatal("upload headers changed")
		}
		var wire bytes.Buffer
		if err := request.Write(&wire); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(wire.String(), "Content-Length: ") || strings.Contains(wire.String(), "Transfer-Encoding: chunked") || !strings.HasSuffix(wire.String(), payload) {
			t.Fatal("wire body or length changed")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})
	response, err := node.PrepareStream("POST", "http://100.80.1.2:43127/v1/commands", "fixture", int64(len(payload)), source)
	if err != nil {
		t.Fatal(err)
	}
	if source.calls.Load() != 0 {
		t.Fatal("prepare read the payload")
	}
	if err := response.Execute(); err != nil {
		t.Fatal(err)
	}
	response.Close()
	response.Close()
	if source.closes.Load() != 1 || source.calls.Load() < 3 || len(node.requests) != 0 {
		t.Fatal("stream lifecycle failed")
	}
}

func TestUploadRejectsTruncatedOversizedAndFailedChunks(t *testing.T) {
	for _, test := range []struct {
		name     string
		reader   io.Reader
		declared int64
	}{
		{"short", strings.NewReader("abc"), 5},
		{"long", strings.NewReader("abcdef"), 5},
		{"failure", failingUploadReader{}, 5},
	} {
		t.Run(test.name, func(t *testing.T) {
			source := &fixtureUpload{reader: test.reader}
			node := testNode(func(request *http.Request) (*http.Response, error) {
				_, err := io.Copy(io.Discard, request.Body)
				return nil, err
			})
			response, err := node.PrepareStream("POST", "http://100.80.1.2:43127/v1/commands", "", test.declared, source)
			if err != nil {
				t.Fatal(err)
			}
			if err := response.Execute(); err == nil {
				t.Fatal("invalid upload succeeded")
			}
			if source.closes.Load() != 1 || len(node.requests) != 0 {
				t.Fatal("failed upload leaked")
			}
		})
	}
	reader := &uploadReader{source: &fixtureUpload{reader: strings.NewReader("")}, remaining: 5}
	if _, err := reader.Read(make([]byte, 8)); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatal(err)
	}
	reader.Close()
	oversized := &uploadReader{source: oversizedUpload{}, remaining: uploadChunkBytes + 1}
	if _, err := oversized.Read(make([]byte, 8)); err == nil {
		t.Fatal("unbounded source chunk accepted")
	}
}

type failingUploadReader struct{}

func (failingUploadReader) Read([]byte) (int, error) { return 0, errors.New("fixture read failed") }

type oversizedUpload struct{}

func (oversizedUpload) ReadChunk() ([]byte, error) { return make([]byte, uploadChunkBytes+1), nil }
func (oversizedUpload) Close()                     {}

type blockingUpload struct {
	started, released chan struct{}
	once              sync.Once
	closes            atomic.Int32
}

func (source *blockingUpload) ReadChunk() ([]byte, error) {
	close(source.started)
	<-source.released
	return nil, io.ErrClosedPipe
}
func (source *blockingUpload) Close() {
	source.closes.Add(1)
	source.once.Do(func() { close(source.released) })
}

func TestCancellationAndNodeCloseInterruptUploadReads(t *testing.T) {
	for _, wholeNode := range []bool{false, true} {
		source := &blockingUpload{started: make(chan struct{}), released: make(chan struct{})}
		node := testNode(func(request *http.Request) (*http.Response, error) {
			_, err := io.Copy(io.Discard, request.Body)
			return nil, err
		})
		response, err := node.PrepareStream("POST", "http://100.80.1.2:43127/v1/commands", "", 100, source)
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- response.Execute() }()
		select {
		case <-source.started:
		case <-time.After(time.Second):
			t.Fatal("upload did not start")
		}
		if wholeNode {
			node.Close()
		} else {
			response.Close()
		}
		select {
		case err := <-done:
			if err == nil {
				t.Fatal("cancelled upload succeeded")
			}
		case <-time.After(time.Second):
			t.Fatal("read remained blocked")
		}
		if source.closes.Load() != 1 || len(node.requests) != 0 {
			t.Fatal("cancelled source leaked or closed twice")
		}
	}
}

func TestHeaderDeadlineClosesUploadSource(t *testing.T) {
	source := &blockingUpload{started: make(chan struct{}), released: make(chan struct{})}
	node := testNode(func(request *http.Request) (*http.Response, error) {
		_, err := io.Copy(io.Discard, request.Body)
		return nil, err
	})
	response, err := node.PrepareStream("POST", "http://100.80.1.2:43127/v1/commands", "", 100, source)
	if err != nil {
		t.Fatal(err)
	}
	if err := response.execute(20 * time.Millisecond); err == nil {
		t.Fatal("deadline was ignored")
	}
	if source.closes.Load() != 1 {
		t.Fatal("deadline did not close source")
	}
}

func TestEarlyResponsePreparedCancelAndRetryUseFreshSources(t *testing.T) {
	node := testNode(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 409, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})
	for _, execute := range []bool{false, true, true} {
		source := &fixtureUpload{reader: strings.NewReader("{}")}
		response, err := node.PrepareStream("POST", "http://100.80.1.2:43127/v1/commands", "", 2, source)
		if err != nil {
			t.Fatal(err)
		}
		if execute {
			if err := response.Execute(); err != nil {
				t.Fatal(err)
			}
		}
		response.Close()
		if source.calls.Load() != 0 || source.closes.Load() != 1 {
			t.Fatal("early response read or leaked an upload")
		}
	}
	if len(node.requests) != 0 {
		t.Fatal("retry leaked requests")
	}
}

func TestPrepareStreamInvalidTargetAndClosedNodeReleaseSource(t *testing.T) {
	node := testNode(nil)
	for _, target := range []string{"http://127.0.0.1:43127/v1/commands", "http://100.80.1.2:43127/v1/commands"} {
		source := &fixtureUpload{reader: strings.NewReader("{}")}
		if strings.Contains(target, "100.80") {
			node.Close()
		}
		if _, err := node.PrepareStream("POST", target, "", 2, source); err == nil {
			t.Fatal("invalid request accepted")
		}
		if source.closes.Load() != 1 {
			t.Fatal("failed preparation leaked source")
		}
	}
}

func TestPrepareStreamAndNodeCloseCanOverlap(t *testing.T) {
	for index := 0; index < 100; index++ {
		node := testNode(nil)
		var done sync.WaitGroup
		for _, length := range []int64{0, 2} {
			source := &fixtureUpload{reader: strings.NewReader("{}")}
			done.Add(1)
			go func() {
				defer done.Done()
				response, err := node.PrepareStream("POST", "http://100.80.1.2:43127/v1/commands", "", length, source)
				if err == nil {
					response.Close()
				}
				if source.closes.Load() != 1 {
					t.Error("overlapping close leaked source")
				}
			}()
		}
		node.Close()
		done.Wait()
	}
}

type memoryUpload struct {
	remaining int64
	peak      uint64
	calls     int
}

func (source *memoryUpload) ReadChunk() ([]byte, error) {
	if source.remaining == 0 {
		return nil, nil
	}
	count := min(source.remaining, uploadChunkBytes)
	source.remaining -= count
	source.calls++
	chunk := bytes.Repeat([]byte{'x'}, int(count))
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	source.peak = max(source.peak, stats.HeapAlloc)
	return chunk, nil
}
func (*memoryUpload) Close() {}

func TestStreamingUploadMemoryAtExpanded32MiBTransfer(t *testing.T) {
	const encoded = 4 * ((32*1024*1024 + 2) / 3)
	runtime.GC()
	var initial runtime.MemStats
	runtime.ReadMemStats(&initial)
	source := &memoryUpload{remaining: encoded, peak: initial.HeapAlloc}
	node := testNode(func(request *http.Request) (*http.Response, error) {
		count, err := io.Copy(io.Discard, request.Body)
		if count != encoded || err != nil {
			t.Fatalf("upload count %d: %v", count, err)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})
	response, err := node.PrepareStream("POST", "http://100.80.1.2:43127/v1/commands", "", encoded, source)
	if err != nil {
		t.Fatal(err)
	}
	if source.calls != 0 {
		t.Fatal("source eagerly buffered")
	}
	if err := response.Execute(); err != nil {
		t.Fatal(err)
	}
	response.Close()
	if source.remaining != 0 {
		t.Fatal("incomplete upload")
	}
	t.Logf("CAMELLIA_GO_UPLOAD_MEMORY encoded_bytes=%d chunk_bytes=%d heap_peak_delta=%d source_calls=%d", encoded, uploadChunkBytes, source.peak-initial.HeapAlloc, source.calls)
}
