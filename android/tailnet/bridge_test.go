package tailnet

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptrace"
	"strings"
	"syscall"
	"testing"
	"time"

	"tailscale.com/ipn"
)

func TestConnectionFailureCodesAreSafeAndSpecific(t *testing.T) {
	for _, check := range []struct {
		err                           error
		cancelled, timeout, connected bool
		state, want                   string
	}{
		{context.Canceled, false, true, false, "Running", "CONNECT_TIMEOUT"},
		{context.Canceled, false, true, true, "Running", "RESPONSE_TIMEOUT"},
		{context.Canceled, true, false, false, "NeedsLogin", "CANCELLED"},
		{context.Canceled, false, true, false, "NeedsLogin", "LOGIN_REQUIRED"},
		{context.Canceled, false, false, false, "NeedsMachineAuth", "DEVICE_APPROVAL_REQUIRED"},
		{context.Canceled, false, false, false, "Starting", "NETWORK_STARTING"},
		{context.Canceled, false, false, false, "Stopped", "NETWORK_STOPPED"},
		{syscall.ECONNREFUSED, false, false, false, "Running", "CONNECTION_REFUSED"},
		{syscall.ENETUNREACH, false, false, false, "Running", "NETWORK_UNREACHABLE"},
		{errors.New("Bearer SECRET http://100.80.1.2:43127"), false, false, false, "", "CONNECTION_FAILED"},
	} {
		if got := connectionError(check.err, check.cancelled, check.timeout, check.connected, check.state).Error(); got != "CAMELLIA_"+check.want {
			t.Fatalf("expected %s, got %s", check.want, got)
		}
	}
}

func TestNativeTimeoutRetainsConnectionStage(t *testing.T) {
	for _, connected := range []bool{false, true} {
		node := testNode(func(request *http.Request) (*http.Response, error) {
			if connected {
				httptrace.ContextClientTrace(request.Context()).GotConn(httptrace.GotConnInfo{})
			}
			<-request.Context().Done()
			return nil, request.Context().Err()
		})
		response, err := node.Prepare("GET", "http://100.80.1.2:43127/v1/status", "secret", "")
		if err != nil {
			t.Fatal(err)
		}
		want := "CAMELLIA_CONNECT_TIMEOUT"
		if connected {
			want = "CAMELLIA_RESPONSE_TIMEOUT"
		}
		if err := response.execute(20 * time.Millisecond); err == nil || err.Error() != want {
			t.Fatalf("wanted %s, got %v", want, err)
		}
	}
}

type testTransport func(*http.Request) (*http.Response, error)

func (transport testTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func testNode(transport testTransport) *Node {
	return &Node{client: &http.Client{Transport: transport}, requests: make(map[*Response]context.CancelFunc)}
}

func TestCancelRequestBeforeHeaders(t *testing.T) {
	started := make(chan struct{})
	node := testNode(func(request *http.Request) (*http.Response, error) {
		close(started)
		<-request.Context().Done()
		return nil, request.Context().Err()
	})
	response, err := node.Prepare("GET", "http://100.80.1.2:43127/v1/status", "", "")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- response.Execute() }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("request did not start")
	}
	response.Close()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled request succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not interrupt connection")
	}
	if len(node.requests) != 0 {
		t.Fatal("cancelled request leaked")
	}
}

func TestConnectionDeadlineAndStreamLifetime(t *testing.T) {
	node := testNode(func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, request.Context().Err()
	})
	response, err := node.Prepare("GET", "http://100.80.1.2:43127/v1/status", "", "")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- response.execute(20 * time.Millisecond) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("deadline did not fail request")
		}
	case <-time.After(time.Second):
		t.Fatal("connection deadline not enforced")
	}
	if len(node.requests) != 0 {
		t.Fatal("timed out request leaked")
	}
	node = testNode(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: io.NopCloser(strings.NewReader("event: snapshot\n\n"))}, nil
	})
	response, err = node.Prepare("GET", "http://100.80.1.2:43127/v1/conversations/events", "", "")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Close()
	if err := response.execute(100 * time.Millisecond); err != nil {
		t.Fatal(err)
	}
	select {
	case <-response.request.Context().Done():
		t.Fatal("header deadline cancelled established stream")
	case <-time.After(150 * time.Millisecond):
	}
	if data, err := response.ReadChunk(); err != nil || len(data) == 0 {
		t.Fatalf("stream unreadable: %v", err)
	}
}

func TestCancelPreparedRequestIsIsolated(t *testing.T) {
	calls := 0
	node := testNode(func(request *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("{}"))}, nil
	})
	first, err := node.Prepare("GET", "http://100.80.1.2:43127/v1/status", "", "")
	if err != nil {
		t.Fatal(err)
	}
	first.Close()
	if err := first.Execute(); err == nil {
		t.Fatal("closed request executed")
	}
	second, err := node.Open("GET", "http://100.80.1.2:43127/v1/status", "", "")
	if err != nil {
		t.Fatal(err)
	}
	second.Close()
	if calls != 1 || len(node.requests) != 0 {
		t.Fatal("cancellation affected unrelated request or leaked state")
	}
}

type memoryStorage struct {
	values map[string]string
	broken bool
}

func (storage *memoryStorage) Read(key string) (string, error) {
	if storage.broken {
		return "", errors.New("keystore unavailable")
	}
	return storage.values[key], nil
}
func (storage *memoryStorage) Write(key, value string) error {
	if storage.broken {
		return errors.New("keystore unavailable")
	}
	storage.values[key] = value
	return nil
}

func TestStateRoundTrip(t *testing.T) {
	storage := &memoryStorage{values: map[string]string{}}
	store := &stateStore{storage: storage}
	if _, err := store.ReadState("missing"); !errors.Is(err, ipn.ErrStateNotExist) {
		t.Fatal(err)
	}
	want := []byte{0, 255, 1, 88}
	if err := store.WriteState("node-key", want); err != nil {
		t.Fatal(err)
	}
	got, err := store.ReadState("node-key")
	if err != nil || string(got) != string(want) {
		t.Fatalf("state mismatch: %v", err)
	}
	storage.broken = true
	if _, err := store.ReadState("node-key"); err == nil {
		t.Fatal("storage errors must not become a new identity")
	}
	if err := store.WriteState("node-key", want); err == nil {
		t.Fatal("must not ignore persistence failure")
	}
}

func TestTargetsStayInsideTailnet(t *testing.T) {
	if err := validateTarget("GET", "http://100.80.1.2:43127/v1/status"); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"http://127.0.0.1:80/v1/status", "https://example.com/v1/status", "http://user@100.80.1.2:80/v1/status", "http://100.80.1.2:80/file", "http://100.80.1.2:0/v1/status"} {
		if err := validateTarget("GET", target); err == nil {
			t.Fatal("accepted unsafe target", target)
		}
	}
	if err := validateTarget("DELETE", "http://100.80.1.2:80/v1/status"); err == nil {
		t.Fatal("accepted unsupported method")
	}
}
