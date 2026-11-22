package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testSpec(directory string) launchSpec {
	return launchSpec{
		Version:       protocolVersion,
		App:           filepath.Join(directory, "Camellia"),
		Cwd:           directory,
		Heartbeat:     filepath.Join(directory, "heartbeat.json"),
		Stop:          filepath.Join(directory, "stop"),
		Status:        filepath.Join(directory, "status.json"),
		Lock:          filepath.Join(directory, "guard.lock"),
		Log:           filepath.Join(directory, "guard.log"),
		StaleMS:       30000,
		LaunchGraceMS: 60000,
	}
}

func TestValidateSpecRejectsRelativePaths(t *testing.T) {
	spec := testSpec(t.TempDir())
	if err := validateSpec(spec); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*launchSpec){
		"app":       func(value *launchSpec) { value.App = "Camellia" },
		"cwd":       func(value *launchSpec) { value.Cwd = "." },
		"heartbeat": func(value *launchSpec) { value.Heartbeat = "heartbeat.json" },
		"deadline":  func(value *launchSpec) { value.StaleMS = 1000 },
		"grace":     func(value *launchSpec) { value.LaunchGraceMS = 1000 },
	} {
		changed := spec
		mutate(&changed)
		if err := validateSpec(changed); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
}

func TestHeartbeatAgeUsesTimestampAndFileMtime(t *testing.T) {
	directory := t.TempDir()
	spec := testSpec(directory)
	now := time.Now()
	value := heartbeat{Version: protocolVersion, PID: 123, At: now.Add(-2 * time.Second).UnixMilli()}
	data, _ := json.Marshal(value)
	if err := os.WriteFile(spec.Heartbeat, data, 0600); err != nil {
		t.Fatal(err)
	}
	read, age, err := heartbeatAge(spec.Heartbeat, now)
	if err != nil || read.PID != 123 || age < time.Second || age > 4*time.Second {
		t.Fatalf("unexpected heartbeat: %#v %s %v", read, age, err)
	}
	if err := os.WriteFile(spec.Heartbeat, []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(spec.Heartbeat, now.Add(-45*time.Second), now.Add(-45*time.Second)); err != nil {
		t.Fatal(err)
	}
	_, age, err = heartbeatAge(spec.Heartbeat, now)
	if err != nil || age < 44*time.Second {
		t.Fatalf("file timestamp fallback failed: %s %v", age, err)
	}
}

func TestRetryDelayIsBounded(t *testing.T) {
	for launches, want := range map[int]time.Duration{1: 5 * time.Second, 2: 10 * time.Second, 3: 20 * time.Second, 4: 30 * time.Second, 20: 30 * time.Second} {
		if got := retryDelay(launches); got != want {
			t.Fatalf("retryDelay(%d) = %s, want %s", launches, got, want)
		}
	}
}

func TestLockIsExclusive(t *testing.T) {
	directory := t.TempDir()
	lock := filepath.Join(directory, "guard.lock")
	owned, err := acquireLock(lock)
	if err != nil || !owned {
		t.Fatalf("first lock failed: %v %v", owned, err)
	}
	owned, err = acquireLock(lock)
	if err != nil || owned {
		t.Fatalf("second lock should be refused: %v %v", owned, err)
	}
}
