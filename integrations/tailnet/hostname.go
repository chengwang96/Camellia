package main

import (
	"errors"
	"regexp"
)

var hostnamePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

func nodeHostname(value string) (string, error) {
	if value == "" {
		return "camellia-desktop", nil
	}
	if !hostnamePattern.MatchString(value) {
		return "", errors.New("invalid Tailscale hostname")
	}
	return value, nil
}
