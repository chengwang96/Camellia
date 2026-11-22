package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const protocolVersion = 1

const (
	defaultStaleMS       = 30000
	defaultLaunchGraceMS = 60000
	pollInterval         = 2 * time.Second
	statusInterval       = 5 * time.Second
	wakeGap              = 10 * time.Second
	resumeGrace          = 20 * time.Second
	stableReset          = 60 * time.Second
)

type launchSpec struct {
	Version       int      `json:"version"`
	App           string   `json:"app"`
	Args          []string `json:"args"`
	Cwd           string   `json:"cwd"`
	Heartbeat     string   `json:"heartbeat"`
	Stop          string   `json:"stop"`
	Status        string   `json:"status"`
	Lock          string   `json:"lock"`
	Log           string   `json:"log"`
	StaleMS       int64    `json:"staleMs"`
	LaunchGraceMS int64    `json:"launchGraceMs"`
}

type heartbeat struct {
	Version int   `json:"version"`
	PID     int   `json:"pid"`
	At      int64 `json:"at"`
}

type guardStatus struct {
	Product  string `json:"product"`
	Version  int    `json:"version"`
	PID      int    `json:"pid"`
	At       int64  `json:"at"`
	State    string `json:"state"`
	Launches int    `json:"launches"`
	Error    string `json:"error,omitempty"`
}

type lockRecord struct {
	Product string `json:"product"`
	Version int    `json:"version"`
	PID     int    `json:"pid"`
	At      int64  `json:"at"`
}

type fileLogger struct {
	file *os.File
}

func newFileLogger(file string) (*fileLogger, error) {
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return nil, err
	}
	handle, err := os.OpenFile(file, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	return &fileLogger{file: handle}, nil
}

func (logger *fileLogger) close() {
	if logger != nil && logger.file != nil {
		_ = logger.file.Close()
	}
}

func (logger *fileLogger) printf(format string, values ...any) {
	if logger == nil || logger.file == nil {
		return
	}
	_, _ = fmt.Fprintf(logger.file, "%s %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(format, values...))
}

func absoluteFile(value string) bool {
	return value != "" && filepath.IsAbs(value) && filepath.Clean(value) == value
}

func validateSpec(spec launchSpec) error {
	if spec.Version != protocolVersion {
		return errors.New("unsupported guard protocol")
	}
	if !absoluteFile(spec.App) || !absoluteFile(spec.Cwd) {
		return errors.New("invalid application launch path")
	}
	for _, value := range []string{spec.Heartbeat, spec.Stop, spec.Status, spec.Lock, spec.Log} {
		if !absoluteFile(value) {
			return errors.New("invalid guard state path")
		}
	}
	if spec.StaleMS < 5000 || spec.StaleMS > 300000 {
		return errors.New("invalid heartbeat deadline")
	}
	if spec.LaunchGraceMS < 10000 || spec.LaunchGraceMS > 300000 {
		return errors.New("invalid launch grace period")
	}
	return nil
}

func readSpec(file string) (launchSpec, error) {
	var spec launchSpec
	data, err := os.ReadFile(file)
	if err != nil {
		return spec, err
	}
	if err := json.Unmarshal(data, &spec); err != nil {
		return spec, errors.New("invalid guard specification")
	}
	return spec, validateSpec(spec)
}

func writeJSON(file string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	temporary := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
	if err := os.WriteFile(temporary, append(data, '\n'), 0600); err != nil {
		return err
	}
	if err := os.Rename(temporary, file); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

func removeIfPresent(file string) {
	if err := os.Remove(file); err != nil && !os.IsNotExist(err) {
		return
	}
}

func acquireLock(file string) (bool, error) {
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return false, err
	}
	handle, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if errors.Is(err, os.ErrExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	record := lockRecord{Product: "camellia-remote-guard", Version: protocolVersion, PID: os.Getpid(), At: time.Now().UnixMilli()}
	data, _ := json.Marshal(record)
	_, writeErr := handle.Write(append(data, '\n'))
	closeErr := handle.Close()
	if writeErr != nil {
		_ = os.Remove(file)
		return false, writeErr
	}
	if closeErr != nil {
		_ = os.Remove(file)
		return false, closeErr
	}
	return true, nil
}

func heartbeatAge(file string, now time.Time) (heartbeat, time.Duration, error) {
	var value heartbeat
	data, err := os.ReadFile(file)
	if err != nil {
		if os.IsNotExist(err) {
			return value, time.Duration(1<<63 - 1), err
		}
		return value, 0, err
	}
	if err := json.Unmarshal(data, &value); err != nil {
		info, statErr := os.Stat(file)
		if statErr != nil {
			return value, 0, err
		}
		return value, now.Sub(info.ModTime()), nil
	}
	if value.Version != protocolVersion || value.PID <= 0 || value.At <= 0 {
		return heartbeat{}, 0, errors.New("invalid heartbeat")
	}
	return value, now.Sub(time.UnixMilli(value.At)), nil
}

func launchApplication(spec launchSpec, logger *fileLogger) error {
	info, err := os.Stat(spec.App)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return errors.New("application path is a directory")
	}
	command := exec.Command(spec.App, spec.Args...)
	command.Dir = spec.Cwd
	prepareCommand(command)
	if err := command.Start(); err != nil {
		return err
	}
	pid := command.Process.Pid
	logger.printf("launched Camellia pid=%d", pid)
	go func() {
		if err := command.Wait(); err != nil {
			logger.printf("Camellia pid=%d exited: %v", pid, err)
		}
	}()
	return nil
}

func retryDelay(launches int) time.Duration {
	switch {
	case launches <= 1:
		return 5 * time.Second
	case launches == 2:
		return 10 * time.Second
	case launches == 3:
		return 20 * time.Second
	default:
		return 30 * time.Second
	}
}

func run(specFile string) error {
	spec, err := readSpec(specFile)
	if err != nil {
		return err
	}
	logger, err := newFileLogger(spec.Log)
	if err != nil {
		return err
	}
	defer logger.close()
	if _, err := os.Stat(spec.Stop); err == nil {
		return nil
	}
	owned, err := acquireLock(spec.Lock)
	if err != nil {
		return err
	}
	if !owned {
		return nil
	}
	defer func() {
		removeIfPresent(spec.Lock)
		removeIfPresent(spec.Status)
	}()

	status := guardStatus{Product: "camellia-remote-guard", Version: protocolVersion, PID: os.Getpid(), At: time.Now().UnixMilli(), State: "monitoring"}
	if err := writeJSON(spec.Status, status); err != nil {
		return err
	}
	logger.printf("guard started pid=%d", os.Getpid())

	deadline := time.Duration(spec.StaleMS) * time.Millisecond
	grace := time.Duration(spec.LaunchGraceMS) * time.Millisecond
	lastTick := time.Now()
	var graceUntil time.Time
	var nextLaunch time.Time
	lastStatus := time.Now()
	lastError := ""
	launches := 0
	var healthySince time.Time

	for {
		time.Sleep(pollInterval)
		now := time.Now()
		if _, err := os.Stat(spec.Stop); err == nil {
			logger.printf("guard stopped by the desktop")
			return nil
		}
		gap := now.Sub(lastTick)
		lastTick = now
		if gap > wakeGap {
			graceUntil = now.Add(resumeGrace)
			logger.printf("system resumed after %s; delaying recovery checks", gap.Round(time.Second))
		}

		value, age, readErr := heartbeatAge(spec.Heartbeat, now)
		if age <= deadline && readErr == nil {
			if healthySince.IsZero() {
				healthySince = now
			} else if launches != 0 && now.Sub(healthySince) >= stableReset {
				launches = 0
				logger.printf("desktop stayed healthy; resetting launch backoff")
			}
			if lastError != "" {
				logger.printf("desktop heartbeat recovered")
				lastError = ""
			}
			if now.Sub(lastStatus) >= statusInterval {
				status.At = now.UnixMilli()
				status.Launches = launches
				status.Error = ""
				if err := writeJSON(spec.Status, status); err != nil {
					logger.printf("status write failed: %v", err)
				}
				lastStatus = now
			}
			continue
		}
		healthySince = time.Time{}
		if now.Before(graceUntil) || now.Before(nextLaunch) {
			continue
		}

		if value.PID > 0 {
			if !processMatches(value.PID, spec.App) {
				logger.printf("heartbeat pid=%d no longer belongs to Camellia; leaving it alone", value.PID)
			} else if err := killProcessTree(value.PID); err != nil {
				logger.printf("stop unreachable desktop pid=%d: %v", value.PID, err)
			} else {
				logger.printf("stopped unreachable desktop pid=%d", value.PID)
			}
			time.Sleep(500 * time.Millisecond)
		}
		if _, err := os.Stat(spec.Stop); err == nil {
			return nil
		}
		if err := launchApplication(spec, logger); err != nil {
			launches++
			lastError = err.Error()
			nextLaunch = now.Add(retryDelay(launches))
			status.At = now.UnixMilli()
			status.Launches = launches
			status.State = "retrying"
			status.Error = lastError
			_ = writeJSON(spec.Status, status)
			logger.printf("launch failed: %v", err)
			continue
		}
		launches++
		graceUntil = now.Add(grace)
		nextLaunch = now.Add(retryDelay(launches))
		status.At = now.UnixMilli()
		status.Launches = launches
		status.State = "monitoring"
		status.Error = ""
		if err := writeJSON(spec.Status, status); err != nil {
			logger.printf("status write failed: %v", err)
		}
		lastStatus = now
	}
}

func main() {
	if len(os.Args) != 2 {
		os.Exit(2)
	}
	if err := run(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, "Remote guard:", err)
		os.Exit(1)
	}
}
