package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type identity struct {
	RuntimeID  string `json:"runtimeId"`
	DeliveryID string `json:"deliveryId"`
	Generation int    `json:"generation"`
}
type message struct {
	identity
	Type      string            `json:"type"`
	Nonce     string            `json:"nonce"`
	LockFile  string            `json:"lockFile"`
	SealFile  string            `json:"sealFile"`
	StateFile string            `json:"stateFile"`
	Exe       string            `json:"exe"`
	Args      []string          `json:"args"`
	Cwd       string            `json:"cwd"`
	Env       map[string]string `json:"env"`
}
type state struct {
	identity
	Version int    `json:"version"`
	Marker  string `json:"marker"`
	RootPID int    `json:"rootPid"`
}
type process struct {
	pid, parent, group, uid int
	birth, status           string
}
type supervisor struct {
	init        message
	state       state
	out         *json.Encoder
	mu          sync.Mutex
	cmd         *exec.Cmd
	finished    chan int
	known       map[int]string
	closed      bool
	exitSent    bool
	outputError error
}

func (s *supervisor) event(kind string, fields map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if fields == nil {
		fields = map[string]any{}
	}
	fields["type"] = kind
	fields["nonce"] = s.init.Nonce
	if err := s.out.Encode(fields); err != nil {
		s.outputError = err
	}
}
func safeFile(file string) error {
	if !filepath.IsAbs(file) {
		return errors.New("absolute journal path required")
	}
	info, err := os.Lstat(file)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("linked or invalid journal file")
	}
	canonical, err := filepath.EvalSymlinks(file)
	if err != nil || canonical != file {
		return errors.New("journal path changed")
	}
	return nil
}
func (s *supervisor) locked(fn func() error) error {
	if err := safeFile(s.init.LockFile); err != nil {
		return err
	}
	fd, err := syscall.Open(s.init.LockFile, syscall.O_RDWR|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	if err = syscall.Flock(fd, syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(fd, syscall.LOCK_UN)
	var record struct {
		identity
		Version int `json:"version"`
	}
	file := filepath.Join(filepath.Dir(s.init.LockFile), "record.json")
	if err = safeFile(file); err != nil {
		return err
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	if json.Unmarshal(data, &record) != nil || record.Version != 1 || record.identity != s.init.identity {
		return errors.New("journal does not match the delivery")
	}
	return fn()
}
func writeDurable(file string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(file), ".job-state-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(append(data, '\n'))
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(name, file); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(file))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func (s *supervisor) readState() error {
	if err := safeFile(s.init.StateFile); err != nil {
		return err
	}
	data, err := os.ReadFile(s.init.StateFile)
	if err != nil {
		return err
	}
	var value state
	if json.Unmarshal(data, &value) != nil || value.Version != 1 || value.identity != s.init.identity {
		return errors.New("invalid Unix launch state")
	}
	marker, err := hex.DecodeString(value.Marker)
	if err != nil || len(marker) != 32 || value.RootPID < 0 {
		return errors.New("invalid Unix launch identity")
	}
	s.state = value
	return nil
}
func processes() ([]process, error) {
	cmd := exec.Command("/bin/ps", "-axo", "pid=,ppid=,pgid=,uid=,stat=,lstart=")
	cmd.Env = []string{"PATH=/usr/bin:/bin", "LC_ALL=C"}
	data, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	var result []process
	for _, row := range strings.Split(string(data), "\n") {
		f := strings.Fields(row)
		if len(f) == 0 {
			continue
		}
		if len(f) != 10 {
			return nil, errors.New("process inventory was incomplete")
		}
		n := make([]int, 4)
		for i := range n {
			n[i], err = strconv.Atoi(f[i])
			if err != nil {
				return nil, err
			}
		}
		result = append(result, process{n[0], n[1], n[2], n[3], strings.Join(f[5:], " "), f[4]})
	}
	return result, nil
}
func (s *supervisor) owned() ([]process, error) {
	if s.state.Marker == "" {
		return nil, nil
	}
	rows, err := processes()
	if err != nil {
		return nil, err
	}
	owned := map[int]bool{}
	groupTrusted := s.cmd != nil // live launch came from our own Start call
	for _, p := range rows {
		if p.uid != os.Getuid() || p.pid == os.Getpid() {
			continue
		}
		if hasMarker(p.pid, s.state.Marker) || s.known[p.pid] == p.birth {
			owned[p.pid] = true
			if p.group == s.state.RootPID && s.state.RootPID > 0 {
				groupTrusted = true
			}
		}
	}
	// A reused group/PID without the private marker cannot target unrelated work.
	for _, p := range rows {
		if p.group == s.state.RootPID && s.state.RootPID > 0 && !strings.HasPrefix(p.status, "Z") && !groupTrusted {
			return nil, errors.New("process group identity could not be confirmed")
		}
	}
	for changed := true; changed; {
		changed = false
		for _, p := range rows {
			if owned[p.pid] || p.pid == os.Getpid() {
				continue
			}
			if owned[p.parent] || groupTrusted && s.state.RootPID > 0 && p.group == s.state.RootPID {
				owned[p.pid] = true
				changed = true
			}
		}
	}
	var result []process
	for _, p := range rows {
		if !owned[p.pid] {
			continue
		}
		s.known[p.pid] = p.birth
		if !strings.HasPrefix(p.status, "Z") {
			result = append(result, p)
		}
	}
	return result, nil
}
func (s *supervisor) seal() error {
	if _, err := os.Lstat(s.init.SealFile); err == nil {
		return safeFile(s.init.SealFile)
	} else if !os.IsNotExist(err) {
		return err
	}
	f, err := os.OpenFile(s.init.SealFile, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString("sealed\n")
	if err != nil {
		return err
	}
	return f.Sync()
}
func (s *supervisor) drain(recovery bool) error {
	return s.locked(func() error {
		if err := s.seal(); err != nil {
			return err
		}
		if err := s.readState(); err != nil {
			// An untouched reservation has never reached initialization. Sealing
			// it under the lock prevents any late helper from creating a process.
			if !os.IsNotExist(err) {
				return err
			}
			s.state = state{identity: s.init.identity, Version: 1}
		}
		deadline, empty := time.Now().Add(25*time.Second), 0
		for time.Now().Before(deadline) {
			rows, err := s.owned()
			if err != nil {
				return err
			}
			if len(rows) == 0 {
				empty++
			} else {
				empty = 0
			}
			if empty >= 3 {
				if s.cmd != nil && !s.exitSent {
					select {
					case code := <-s.finished:
						s.event("exit", map[string]any{"code": code})
						s.exitSent = true
					default:
						return errors.New("root exit was not acknowledged")
					}
				}
				kind := "stopped"
				if recovery {
					kind = "recovered"
				}
				total := len(s.known)
				if s.cmd != nil && s.known[s.state.RootPID] == "" {
					total++
				}
				s.event(kind, map[string]any{"sealed": true, "activeProcesses": 0, "totalProcesses": total, "rootPid": s.state.RootPID})
				return nil
			}
			// Freeze observed descendants before terminating them, preventing
			// routine shells from forking another background task during stop.
			for _, p := range rows {
				if err = syscall.Kill(p.pid, syscall.SIGSTOP); err != nil && err != syscall.ESRCH {
					return err
				}
			}
			for _, p := range rows {
				if err = syscall.Kill(p.pid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
					return err
				}
			}
			time.Sleep(40 * time.Millisecond)
		}
		return errors.New("Unix process stop could not be confirmed")
	})
}
func (s *supervisor) launch(m message) error {
	if s.cmd != nil || s.closed {
		return errors.New("launcher is stopped or already used")
	}
	if !filepath.IsAbs(m.Exe) || !filepath.IsAbs(m.Cwd) || m.Env == nil {
		return errors.New("invalid native launch")
	}
	return s.locked(func() error {
		if _, err := os.Lstat(s.init.SealFile); err == nil || !os.IsNotExist(err) {
			return errors.New("delivery is sealed")
		}
		if err := s.readState(); err != nil {
			return err
		}
		cmd := exec.Command(m.Exe, m.Args...)
		cmd.Dir = m.Cwd
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		for key, value := range m.Env {
			if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, 0) {
				return errors.New("invalid native environment")
			}
			if key != "CAMELLIA_DISCUSSION_JOB" {
				cmd.Env = append(cmd.Env, key+"="+value)
			}
		}
		cmd.Env = append(cmd.Env, "CAMELLIA_DISCUSSION_JOB="+s.state.Marker)
		if err := cmd.Start(); err != nil {
			return err
		}
		s.cmd = cmd
		s.state.RootPID = cmd.Process.Pid
		if err := writeDurable(s.init.StateFile, s.state); err != nil {
			cmd.Process.Kill()
			cmd.Wait()
			return err
		}
		s.event("spawned", map[string]any{"pid": cmd.Process.Pid})
		go func() {
			err := cmd.Wait()
			code := 0
			if err != nil {
				code = cmd.ProcessState.ExitCode()
				if code < 0 {
					code = 128 + int(cmd.ProcessState.Sys().(syscall.WaitStatus).Signal())
				}
			}
			s.finished <- code
		}()
		return nil
	})
}
func run() error {
	control, output := os.NewFile(3, "control"), os.NewFile(4, "events")
	if control == nil || output == nil {
		return errors.New("private control pipes required")
	}
	// Node passes these descriptors without FD_CLOEXEC. Keep engine processes
	// from inheriting the private protocol or holding it open after host loss.
	syscall.CloseOnExec(3)
	syscall.CloseOnExec(4)
	defer control.Close()
	defer output.Close()
	scanner := bufio.NewScanner(control)
	scanner.Buffer(make([]byte, 65536), 8*1024*1024)
	if !scanner.Scan() {
		return errors.New("initialization required")
	}
	var init message
	if err := json.Unmarshal(scanner.Bytes(), &init); err != nil {
		return err
	}
	if init.Nonce == "" || init.Generation < 1 || filepath.Dir(init.LockFile) != filepath.Dir(init.SealFile) || filepath.Dir(init.LockFile) != filepath.Dir(init.StateFile) {
		return errors.New("invalid initialization")
	}
	s := &supervisor{init: init, out: json.NewEncoder(output), finished: make(chan int, 1), known: map[int]string{}}
	if init.Type == "recover" {
		return s.drain(true)
	}
	if init.Type != "initialize" {
		return errors.New("invalid supervisor mode")
	}
	if err := s.locked(func() error {
		if _, err := os.Lstat(init.SealFile); err == nil || !os.IsNotExist(err) {
			return errors.New("delivery is sealed")
		}
		if _, err := os.Lstat(init.StateFile); err == nil || !os.IsNotExist(err) {
			return errors.New("delivery was already initialized")
		}
		var marker [32]byte
		if _, err := rand.Read(marker[:]); err != nil {
			return err
		}
		s.state = state{identity: init.identity, Version: 1, Marker: hex.EncodeToString(marker[:])}
		return writeDurable(init.StateFile, s.state)
	}); err != nil {
		return err
	}
	s.event("ready", nil)
	commands := make(chan message)
	failures := make(chan error, 1)
	go func() {
		for scanner.Scan() {
			var m message
			if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
				failures <- err
				return
			}
			commands <- m
		}
		failures <- scanner.Err()
	}()
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(interrupts)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if s.outputError != nil {
			s.drain(false)
			return s.outputError
		}
		select {
		case m := <-commands:
			if m.Nonce != init.Nonce {
				s.drain(false)
				return errors.New("invalid control nonce")
			}
			if m.Type == "stop" {
				s.closed = true
				return s.drain(false)
			}
			if m.Type != "spawn" {
				s.drain(false)
				return errors.New("unknown control command")
			}
			if err := s.launch(m); err != nil {
				s.event("failure", map[string]any{"message": err.Error()})
				return s.drain(false)
			}
		case code := <-s.finished:
			s.event("exit", map[string]any{"code": code})
			s.exitSent = true
			s.closed = true
			return s.drain(false)
		case err := <-failures:
			if stop := s.drain(false); stop != nil {
				return stop
			}
			return err
		case <-interrupts:
			return s.drain(false)
		case <-ticker.C:
			if s.cmd != nil {
				if _, err := s.owned(); err != nil {
					s.drain(false)
					return err
				}
			}
		}
	}
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Discussion supervisor:", err)
		os.Exit(1)
	}
}
