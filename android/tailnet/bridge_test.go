package tailnet

import (
	"errors"
	"testing"

	"tailscale.com/ipn"
)

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
