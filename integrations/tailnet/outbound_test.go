package main

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestOutboundTargets(t *testing.T) {
	for _, target := range []string{"http://100.64.0.1:43127", "http://100.127.255.255:43127"} {
		if _, err := outboundTarget(target); err != nil {
			t.Fatal(err)
		}
	}
	for _, target := range []string{"http://127.0.0.1:43127", "http://100.128.0.1:43127", "http://100.064.0.1:43127", "http://100.64.0.1:80", "https://100.64.0.1:43127", "http://user@100.64.0.1:43127", "http://example.com:43127", "http://100.64.0.1:43127/", "http://100.64.0.1:43127?", "http://100.64.0.1:43127#fragment"} {
		if _, err := outboundTarget(target); err == nil {
			t.Fatal("accepted", target)
		}
	}
}

func TestOutboundEndpoints(t *testing.T) {
	id := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	for _, endpoint := range []string{"/v1/status", "/v1/native-settings/codex", "/v1/archived?offset=0", "/v1/api-import", "/v1/conversations?offset=100", "/v1/conversations/events", "/v1/conversations/" + id + "?before=10", "/v1/conversations/" + id + "/artifacts?offset=1"} {
		if !allowedDeviceRequest(httptest.NewRequest("GET", endpoint, nil)) {
			t.Fatal("rejected", endpoint)
		}
	}
	for _, endpoint := range []string{"/v1/pair/request", "/v1/pair/claim", "/v1/native-settings/dsh", "/v1/api-import", "/v1/commands", "/v1/conversations/" + id + "/commands", "/v1/conversations/" + id + "/read"} {
		if !allowedDeviceRequest(httptest.NewRequest("POST", endpoint, nil)) {
			t.Fatal("rejected", endpoint)
		}
	}
	for _, endpoint := range []string{"/admin", "/v1/status?offset=1", "/v1/conversations?offset=1&offset=2", "/v1/conversations?offset=-1", "/v1/conversations?redirect=http://evil", "/v1/%73tatus", "http://100.64.0.1:43127/v1/status"} {
		if allowedDeviceRequest(httptest.NewRequest("GET", endpoint, nil)) {
			t.Fatal("accepted", endpoint)
		}
	}
}

func TestOutboundUsesTailnetDialAndStripsLocalSecrets(t *testing.T) {
	token := strings.Repeat("a", 64)
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Host != "100.80.1.2:43127" || request.Header.Get("Authorization") != "Bearer device-token" {
			t.Error("lost target or device credential")
		}
		for _, header := range []string{"X-Camellia-Outbound", "X-Camellia-Transport", "X-Camellia-Peer", "Cookie", "X-Forwarded-For"} {
			if request.Header.Get(header) != "" {
				t.Error("leaked local header", header)
			}
		}
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("Set-Cookie", "secret=value")
		io.WriteString(response, `{"ok":true}`)
	}))
	defer backend.Close()
	dialed := false
	handler, transport, err := outboundHandler("http://100.80.1.2:43127", token, func(ctx context.Context, network, address string) (net.Conn, error) {
		dialed = true
		if address != "100.80.1.2:43127" {
			t.Error("unexpected dial target", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(backend.URL, "http://"))
	})
	if err != nil {
		t.Fatal(err)
	}
	defer transport.CloseIdleConnections()
	request := httptest.NewRequest("GET", "/v1/status", nil)
	request.RemoteAddr = "127.0.0.1:1234"
	request.Header.Set("X-Camellia-Outbound", token)
	request.Header.Set("Authorization", "Bearer device-token")
	request.Header.Set("Cookie", "do-not-forward")
	request.Header.Set("X-Camellia-Transport", "do-not-forward")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if !dialed || response.Code != 200 || response.Header().Get("Set-Cookie") != "" || response.Body.String() != `{"ok":true}` {
		t.Fatal("invalid proxy response", response)
	}
	for _, change := range []func(*http.Request){
		func(request *http.Request) { request.Header.Del("X-Camellia-Outbound") },
		func(request *http.Request) { request.Header.Set("Origin", "http://evil") },
		func(request *http.Request) { request.Header.Set("Sec-Fetch-Site", "same-origin") },
		func(request *http.Request) { request.RemoteAddr = "100.90.1.2:1234" },
	} {
		copy := request.Clone(context.Background())
		change(copy)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, copy)
		if response.Code != 403 {
			t.Fatal("missing local boundary", response.Code)
		}
	}
}

func TestOutboundStreamsAndCancelsWithoutBuffering(t *testing.T) {
	cancelled := make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(response, "data: {\"cursor\":1}\n\n")
		response.(http.Flusher).Flush()
		<-request.Context().Done()
		close(cancelled)
	}))
	defer backend.Close()
	token := strings.Repeat("b", 64)
	handler, transport, err := outboundHandler("http://100.80.1.2:43127", token, func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(backend.URL, "http://"))
	})
	if err != nil {
		t.Fatal(err)
	}
	defer transport.CloseIdleConnections()
	local := httptest.NewServer(handler)
	defer local.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, "GET", local.URL+"/v1/conversations/events", nil)
	request.Header.Set("X-Camellia-Outbound", token)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(response.Body).ReadString('\n')
	if err != nil || line != "data: {\"cursor\":1}\n" {
		t.Fatal("stream was buffered", line, err)
	}
	response.Body.Close()
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream stream was not cancelled")
	}
}

func TestOutboundRejectsRedirects(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Location", "http://127.0.0.1:9999/private")
		response.WriteHeader(302)
	}))
	defer backend.Close()
	token := strings.Repeat("c", 64)
	handler, transport, _ := outboundHandler("http://100.80.1.2:43127", token, func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, strings.TrimPrefix(backend.URL, "http://"))
	})
	defer transport.CloseIdleConnections()
	request := httptest.NewRequest("GET", "/v1/status", nil)
	request.RemoteAddr = "127.0.0.1:1234"
	request.Header.Set("X-Camellia-Outbound", token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 502 || response.Header().Get("Location") != "" {
		t.Fatal("redirect escaped", response)
	}
}
