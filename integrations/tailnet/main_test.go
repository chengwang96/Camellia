package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strings"
	"testing"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
)

func TestEncryptedState(t *testing.T) {
	directory := t.TempDir()
	key := bytes.Repeat([]byte{7}, 32)
	store, err := newStore(directory, key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReadState("missing"); err != ipn.ErrStateNotExist {
		t.Fatal(err)
	}
	secret := []byte("private-node-identity")
	if err := store.WriteState("node", secret); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteState("node", secret); err != nil {
		t.Fatal("replace", err)
	}
	data, err := os.ReadFile(store.filename("node"))
	if err != nil || bytes.Contains(data, secret) {
		t.Fatal("plaintext state", err)
	}
	reopened, _ := newStore(directory, key)
	value, err := reopened.ReadState("node")
	if err != nil || !bytes.Equal(value, secret) {
		t.Fatal("state did not survive restart", err)
	}
	wrong, _ := newStore(directory, bytes.Repeat([]byte{8}, 32))
	if _, err := wrong.ReadState("node"); err == nil {
		t.Fatal("accepted wrong key")
	}
	data[len(data)-1] ^= 1
	if err := os.WriteFile(store.filename("node"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReadState("node"); err == nil {
		t.Fatal("accepted tampering")
	}
	if _, err := newStore(directory, nil); err == nil {
		t.Fatal("accepted missing key")
	}
}

func TestStatusResultIncludesHealth(t *testing.T) {
	result := statusResult(&ipnstate.Status{
		BackendState: "Running",
		AuthURL:      "https://login.tailscale.com/a/test",
		TailscaleIPs: []netip.Addr{netip.MustParseAddr("192.168.1.2"), netip.MustParseAddr("100.80.1.2")},
		Self:         &ipnstate.PeerStatus{HostName: "work-pc", Online: true},
		Health:       []string{"Control plane is reconnecting"},
	})
	if result["state"] != "Running" || result["address"] != "100.80.1.2" || result["hostName"] != "work-pc" || result["online"] != true {
		t.Fatal("status identity or health was lost", result)
	}
	health := result["health"].([]string)
	if len(health) != 1 || health[0] != "Control plane is reconnecting" {
		t.Fatal("health details were lost", result)
	}
	empty := statusResult(&ipnstate.Status{})
	if health, ok := empty["health"].([]string); !ok || len(health) != 0 {
		t.Fatal("missing health must be an empty list", empty)
	}
}

func TestStatusResultIncludesOwnerIdentity(t *testing.T) {
	result := statusResult(&ipnstate.Status{
		BackendState: "Running",
		Self:         &ipnstate.PeerStatus{HostName: "work-pc", Online: true, UserID: 42},
		User: map[tailcfg.UserID]tailcfg.UserProfile{42: {
			ID: 42, LoginName: "me@example.com", DisplayName: "Me",
		}},
	})
	if result["selfUserId"] != "42" || result["selfLoginName"] != "me@example.com" || result["selfDisplayName"] != "Me" {
		t.Fatal("owner identity was lost", result)
	}
}

func TestNodeHostname(t *testing.T) {
	for input, expected := range map[string]string{"": "camellia-desktop", "camellia-server": "camellia-server", "gpu-lab-01": "gpu-lab-01", "a": "a"} {
		actual, err := nodeHostname(input)
		if err != nil || actual != expected {
			t.Fatal(input, actual, err)
		}
	}
	for _, input := range []string{"-server", "server-", "Server", "server.local", "host\nname", strings.Repeat("a", 64)} {
		if _, err := nodeHostname(input); err == nil {
			t.Fatal("accepted invalid hostname", input)
		}
	}
}

func TestProxyPreservesHostAndReplacesTransportIdentity(t *testing.T) {
	token := strings.Repeat("a", 64)
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Host != "100.80.1.2:43127" {
			t.Error("lost public host", request.Host)
		}
		if request.Header.Get("X-Camellia-Transport") != token {
			t.Error("lost private token")
		}
		if request.Header.Get("X-Camellia-Peer") != "100.90.1.2" {
			t.Error("spoofed peer")
		}
		if request.Header.Get("Authorization") != "Bearer device-token" {
			t.Error("lost device authorization")
		}
		if request.Header.Get("Origin") != "https://untrusted.example" {
			t.Error("lost origin guard")
		}
		if request.Header.Get("X-Forwarded-For") != "" {
			t.Error("forwarded spoofed headers")
		}
		response.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(response, "data: snapshot\n\n")
	}))
	defer backend.Close()
	handler, err := proxyHandler(backend.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", "http://100.80.1.2:43127/v1/conversations/events", nil)
	request.RemoteAddr = "100.90.1.2:2345"
	request.Header.Set("X-Camellia-Transport", "spoof")
	request.Header.Set("X-Camellia-Peer", "spoof")
	request.Header.Set("X-Forwarded-For", "spoof")
	request.Header.Set("Authorization", "Bearer device-token")
	request.Header.Set("Origin", "https://untrusted.example")
	request.Header.Set("Connection", "Origin, Sec-Fetch-Site")
	request.Header.Set("Sec-Fetch-Site", "cross-site")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 200 || response.Body.String() != "data: snapshot\n\n" {
		t.Fatal(response)
	}
}

func TestProxyAddsVerifiedTailnetIdentityAndStripsSpoofedHeaders(t *testing.T) {
	token := strings.Repeat("a", 64)
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Camellia-Tailnet-Node") != "stable-phone" {
			t.Error("missing verified node", request.Header)
		}
		if request.Header.Get("X-Camellia-Tailnet-User") != "42" {
			t.Error("missing verified user", request.Header)
		}
		if request.Header.Get("X-Camellia-Tailnet-Login") != "me@example.com" {
			t.Error("missing verified login", request.Header)
		}
		if request.Header.Get("X-Camellia-Tailnet-Tags") != "tag:phone,tag:trusted" {
			t.Error("missing verified tags", request.Header)
		}
		if request.Header.Get("X-Camellia-Peer") != "100.90.1.2" {
			t.Error("lost peer address", request.Header)
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()
	handler, err := proxyHandlerWithIdentity(backend.URL, token, func(context.Context, string) (tailnetIdentity, bool) {
		return tailnetIdentity{NodeID: "stable-phone", UserID: "42", Login: "me@example.com",
			Name: "phone.tailnet.ts.net", Tags: []string{"tag:phone", "tag:trusted"}}, true
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("GET", "http://100.80.1.2:43127/v1/hello", nil)
	request.RemoteAddr = "100.90.1.2:2345"
	request.Header.Set("X-Camellia-Tailnet-Node", "spoof")
	request.Header.Set("X-Camellia-Tailnet-User", "spoof")
	request.Header.Set("X-Camellia-Tailnet-Login", "spoof")
	request.Header.Set("X-Camellia-Tailnet-Tags", "spoof")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatal(response)
	}
}

func TestProxyRejectsNonLoopbackTargets(t *testing.T) {
	for _, target := range []string{"http://localhost:1234", "http://0.0.0.0:1234", "http://100.80.1.2:1234", "https://127.0.0.1:1234", "http://user@127.0.0.1:1234", "http://127.0.0.1:1234/path", "http://127.0.0.1:0"} {
		if _, err := proxyHandler(target, strings.Repeat("a", 64)); err == nil {
			t.Fatal("accepted", target)
		}
	}
	if _, err := proxyHandler("http://127.0.0.1:1234", ""); err == nil {
		t.Fatal("accepted missing token")
	}
}
