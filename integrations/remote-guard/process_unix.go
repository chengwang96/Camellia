//go:build darwin || linux

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func prepareCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func killProcessTree(pid int) error {
	if pid <= 1 {
		return errors.New("invalid process")
	}
	if err := syscall.Kill(-pid, syscall.SIGKILL); err == nil {
		return nil
	}
	return syscall.Kill(pid, syscall.SIGKILL)
}

func processMatches(pid int, executable string) bool {
	expected := strings.ToLower(filepath.Base(executable))
	if link, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(pid), "exe")); err == nil {
		return strings.ToLower(filepath.Base(strings.TrimSuffix(link, " (deleted)"))) == expected
	}
	command := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "comm=")
	output, err := command.Output()
	if err != nil {
		return false
	}
	return strings.ToLower(filepath.Base(strings.TrimSpace(string(output)))) == expected
}
