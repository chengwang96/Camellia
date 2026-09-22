package tailnet

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/net/netmon"
	"tailscale.com/tsnet"
)

type Storage interface {
	Read(key string) (string, error)
	Write(key, value string) error
}

type Interfaces interface{ Snapshot() (string, error) }

var interfaceOnce sync.Once

func SetInterfaces(provider Interfaces) {
	interfaceOnce.Do(func() {
		netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
			value, err := provider.Snapshot()
			if err != nil {
				return nil, err
			}
			var entries []struct {
				Name         string
				Index, MTU   int
				Up, Loopback bool
				Addresses    []string
			}
			if err := json.Unmarshal([]byte(value), &entries); err != nil {
				return nil, err
			}
			result := make([]netmon.Interface, 0, len(entries))
			for _, entry := range entries {
				flags := net.FlagBroadcast | net.FlagMulticast
				if entry.Up {
					flags |= net.FlagUp | net.FlagRunning
				}
				if entry.Loopback {
					flags |= net.FlagLoopback
				}
				addresses := make([]net.Addr, 0, len(entry.Addresses))
				for _, value := range entry.Addresses {
					address, subnet, err := net.ParseCIDR(value)
					if err == nil {
						subnet.IP = address
						addresses = append(addresses, subnet)
					}
				}
				result = append(result, netmon.Interface{Interface: &net.Interface{Name: entry.Name, Index: entry.Index, MTU: entry.MTU, Flags: flags}, AltAddrs: addresses})
			}
			return result, nil
		})
	})
}

type stateStore struct{ storage Storage }

func (store *stateStore) ReadState(key ipn.StateKey) ([]byte, error) {
	value, err := store.storage.Read(string(key))
	if err != nil {
		return nil, err
	}
	if value == "" {
		return nil, ipn.ErrStateNotExist
	}
	return base64.StdEncoding.DecodeString(value)
}

func (store *stateStore) WriteState(key ipn.StateKey, value []byte) error {
	return store.storage.Write(string(key), base64.StdEncoding.EncodeToString(value))
}

type Node struct {
	server    *tsnet.Server
	client    *http.Client
	transport *http.Transport
	mu        sync.Mutex
	closed    bool
	requests  map[*Response]context.CancelFunc
}

func NewNode(directory string, storage Storage) (*Node, error) {
	if storage == nil || directory == "" {
		return nil, errors.New("private state directory and encrypted storage are required")
	}
	os.Setenv("TS_NO_LOGS_NO_SUPPORT", "true")
	os.Setenv("TS_LOGS_DIR", directory)
	os.Setenv("HOME", directory)
	os.Setenv("TMPDIR", directory)
	quiet := func(string, ...any) {}
	server := &tsnet.Server{Dir: directory, Hostname: "camellia-android", Store: &stateStore{storage: storage}, Logf: quiet, UserLogf: quiet}
	if err := server.Start(); err != nil {
		server.Close()
		return nil, fmt.Errorf("embedded network could not start: %w", err)
	}
	transport := &http.Transport{DialContext: server.Dial, ForceAttemptHTTP2: false, ResponseHeaderTimeout: 25 * time.Second,
		MaxResponseHeaderBytes: 16 * 1024, MaxIdleConns: 4, IdleConnTimeout: 30 * time.Second}
	return &Node{server: server, transport: transport, requests: make(map[*Response]context.CancelFunc),
		client: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (node *Node) Status() (string, error) {
	client, err := node.server.LocalClient()
	if err != nil {
		return "", errors.New("embedded network unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	status, err := client.StatusWithoutPeers(ctx)
	if err != nil {
		return "", errors.New("cannot read embedded network status")
	}
	result, err := json.Marshal(map[string]any{"state": status.BackendState, "loginUrl": status.AuthURL})
	return string(result), err
}

func (node *Node) Login() error {
	client, err := node.server.LocalClient()
	if err != nil {
		return errors.New("embedded network unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return client.StartLoginInteractive(ctx)
}

func validateTarget(method, target string) error {
	parsed, err := url.Parse(target)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.Fragment != "" {
		return errors.New("invalid tailnet target")
	}
	address, err := netip.ParseAddr(parsed.Hostname())
	if err != nil || !netip.MustParsePrefix("100.64.0.0/10").Contains(address) {
		return errors.New("target is not a tailnet IPv4 address")
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 || !strings.HasPrefix(parsed.Path, "/v1/") {
		return errors.New("invalid remote endpoint")
	}
	if method != "GET" && method != "POST" {
		return errors.New("unsupported method")
	}
	return nil
}

type Response struct {
	mu          sync.Mutex
	body        io.ReadCloser
	status      int
	contentType string
	cancel      context.CancelFunc
	node        *Node
	closed      bool
}

func (node *Node) Open(method, target, token, payload string) (*Response, error) {
	if err := validateTarget(method, target); err != nil {
		return nil, err
	}
	status, err := node.Status()
	if err != nil {
		return nil, err
	}
	var state struct{ State string }
	if json.Unmarshal([]byte(status), &state) != nil || state.State != "Running" {
		return nil, errors.New("sign in to the embedded network before connecting")
	}
	ctx, cancel := context.WithCancel(context.Background())
	response := &Response{cancel: cancel, node: node}
	node.mu.Lock()
	if node.closed {
		node.mu.Unlock()
		cancel()
		return nil, errors.New("embedded network closed")
	}
	node.requests[response] = cancel
	node.mu.Unlock()
	request, err := http.NewRequestWithContext(ctx, method, target, strings.NewReader(payload))
	if err != nil {
		response.Close()
		return nil, err
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if method == "POST" {
		request.Header.Set("Content-Type", "application/json; charset=utf-8")
	}
	result, err := node.client.Do(request)
	if err != nil {
		response.Close()
		return nil, errors.New("embedded connection failed; check login, desktop and tailnet access")
	}
	response.mu.Lock()
	response.body = result.Body
	response.status = result.StatusCode
	response.contentType = result.Header.Get("Content-Type")
	response.mu.Unlock()
	return response, nil
}

func (response *Response) StatusCode() int     { return response.status }
func (response *Response) ContentType() string { return response.contentType }

func (response *Response) ReadChunk() ([]byte, error) {
	response.mu.Lock()
	body, closed := response.body, response.closed
	response.mu.Unlock()
	if closed || body == nil {
		return nil, nil
	}
	buffer := make([]byte, 16*1024)
	timeout := time.AfterFunc(25*time.Second, response.cancel)
	defer timeout.Stop()
	count, err := body.Read(buffer)
	if count > 0 {
		return buffer[:count], nil
	}
	if err == io.EOF {
		return nil, nil
	}
	return nil, err
}

func (response *Response) Close() {
	response.mu.Lock()
	if response.closed {
		response.mu.Unlock()
		return
	}
	response.closed = true
	response.cancel()
	if response.body != nil {
		response.body.Close()
	}
	response.mu.Unlock()
	response.node.mu.Lock()
	delete(response.node.requests, response)
	response.node.mu.Unlock()
}

func (node *Node) Close() {
	node.mu.Lock()
	if node.closed {
		node.mu.Unlock()
		return
	}
	node.closed = true
	for _, cancel := range node.requests {
		cancel()
	}
	node.mu.Unlock()
	node.transport.CloseIdleConnections()
	node.server.Close()
}
