package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"tailscale.com/ipn"
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
