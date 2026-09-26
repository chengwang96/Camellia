package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

var deviceTokenPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var conversationPath = regexp.MustCompile(`^/v1/conversations/[a-f0-9-]{36}(/events|/commands|/read|/artifacts(/[a-f0-9]{64})?)?$`)
var cursorPattern = regexp.MustCompile(`^[0-9]{1,12}$`)
var nativeSettingsPath = regexp.MustCompile(`^/v1/native-settings/(claude|codex|kimi|dsh|antigravity)$`)

func outboundTarget(value string) (*url.URL, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return nil, errors.New("invalid Camellia device address")
	}
	address, err := netip.ParseAddr(parsed.Hostname())
	if err != nil || !address.Is4() || !netip.MustParsePrefix("100.64.0.0/10").Contains(address) || parsed.Host != address.String()+":43127" {
		return nil, errors.New("device must use a Tailscale IPv4 address on port 43127")
	}
	return parsed, nil
}

func allowedDeviceRequest(request *http.Request) bool {
	if request.URL.IsAbs() || request.URL.RawPath != "" || request.URL.Fragment != "" {
		return false
	}
	endpoint := request.URL.Path
	pairing := endpoint == "/v1/pair/request" || endpoint == "/v1/pair/claim"
	conversation := conversationPath.MatchString(endpoint)
	native := nativeSettingsPath.MatchString(endpoint)
	if request.Method == http.MethodPost {
		return request.URL.RawQuery == "" && !request.URL.ForceQuery && (pairing || native || endpoint == "/v1/api-import" || endpoint == "/v1/commands" || conversation && (strings.HasSuffix(endpoint, "/commands") || strings.HasSuffix(endpoint, "/read")))
	}
	if request.Method != http.MethodGet || !(native || endpoint == "/v1/status" || endpoint == "/v1/archived" || endpoint == "/v1/conversations" || endpoint == "/v1/conversations/events" || endpoint == "/v1/api-keys" || endpoint == "/v1/api-import" || conversation && !strings.HasSuffix(endpoint, "/commands") && !strings.HasSuffix(endpoint, "/read")) {
		return false
	}
	query, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		return false
	}
	for key, values := range query {
		if len(values) != 1 || !cursorPattern.MatchString(values[0]) {
			return false
		}
		if key == "offset" && (endpoint == "/v1/conversations" || endpoint == "/v1/archived" || strings.HasSuffix(endpoint, "/artifacts")) {
			continue
		}
		if key == "before" && conversation && strings.Count(endpoint, "/") == 3 {
			continue
		}
		return false
	}
	return true
}

type tailnetDial func(context.Context, string, string) (net.Conn, error)

func outboundHandler(target, token string, dial tailnetDial) (http.Handler, *http.Transport, error) {
	parsed, err := outboundTarget(target)
	if err != nil || !deviceTokenPattern.MatchString(token) {
		return nil, nil, errors.New("invalid outbound connection configuration")
	}
	transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" || address != parsed.Host {
			return nil, errors.New("outbound target changed")
		}
		return dial(ctx, network, address)
	}, MaxConnsPerHost: 8, MaxIdleConns: 8, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 15 * time.Second, MaxResponseHeaderBytes: 32 * 1024, DisableCompression: true}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(parsed)
			request.Out.Host = parsed.Host
			request.Out.Header = make(http.Header)
			for _, name := range []string{"Authorization", "Content-Type", "Accept"} {
				if value := request.In.Header.Get(name); value != "" {
					request.Out.Header.Set(name, value)
				}
			}
		},
		Transport: transport, FlushInterval: -1,
		ModifyResponse: func(response *http.Response) error {
			if response.StatusCode >= 300 && response.StatusCode < 400 {
				return errors.New("device redirects are not permitted")
			}
			for name := range response.Header {
				if name != "Content-Type" && name != "Content-Length" && name != "Content-Disposition" {
					response.Header.Del(name)
				}
			}
			response.Header.Set("Cache-Control", "no-store")
			response.Header.Set("X-Content-Type-Options", "nosniff")
			return nil
		},
		ErrorHandler: func(response http.ResponseWriter, request *http.Request, err error) {
			http.Error(response, "Device connection failed; verify state before retrying writes", http.StatusBadGateway)
		},
	}
	handler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		peer, _, _ := net.SplitHostPort(request.RemoteAddr)
		if peer != "127.0.0.1" || subtle.ConstantTimeCompare([]byte(request.Header.Get("X-Camellia-Outbound")), []byte(token)) != 1 || request.Header.Get("Origin") != "" || request.Header.Get("Sec-Fetch-Site") != "" {
			http.Error(response, "Local app transport required", http.StatusForbidden)
			return
		}
		if !allowedDeviceRequest(request) {
			http.Error(response, "Unsupported device endpoint", http.StatusBadRequest)
			return
		}
		if request.ContentLength > 13_000_000 {
			http.Error(response, "Device request is too large", http.StatusRequestEntityTooLarge)
			return
		}
		request.Body = http.MaxBytesReader(response, request.Body, 13_000_000)
		proxy.ServeHTTP(response, request)
	})
	return handler, transport, nil
}

type outboundConnection struct {
	server    *http.Server
	transport *http.Transport
	mutex     sync.Mutex
	sockets   map[net.Conn]bool
}

func (connection *outboundConnection) close() {
	connection.server.Close()
	connection.transport.CloseIdleConnections()
}

func (service *helper) connect(target, token string) (any, error) {
	if len(service.outbound) >= 8 {
		return nil, errors.New("too many device connections")
	}
	if _, exists := service.outbound[token]; exists {
		return nil, errors.New("connection already exists")
	}
	handler, transport, err := outboundHandler(target, token, service.node.Dial)
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		transport.CloseIdleConnections()
		return nil, errors.New("cannot open local device connection")
	}
	connection := &outboundConnection{transport: transport, sockets: make(map[net.Conn]bool)}
	connection.server = &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192,
		ConnState: func(socket net.Conn, state http.ConnState) {
			connection.mutex.Lock()
			defer connection.mutex.Unlock()
			if state == http.StateNew {
				if len(connection.sockets) >= 16 {
					socket.Close()
				} else {
					connection.sockets[socket] = true
				}
			} else if state == http.StateClosed || state == http.StateHijacked {
				delete(connection.sockets, socket)
			}
		}}
	if service.outbound == nil {
		service.outbound = make(map[string]*outboundConnection)
	}
	service.outbound[token] = connection
	go connection.server.Serve(listener)
	return map[string]any{"url": "http://" + listener.Addr().String()}, nil
}

func (service *helper) disconnectAll() {
	for token, connection := range service.outbound {
		connection.close()
		delete(service.outbound, token)
	}
}
