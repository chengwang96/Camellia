package main

import (
	"bytes"
	"os"
	"strconv"
)

// Linux supports the same supervisor protocol for native process tests. The
// desktop feature is admitted separately on Windows and macOS.
func hasMarker(pid int, marker string) bool {
	buf, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/environ")
	if err != nil {
		return false
	}
	for _, value := range bytes.Split(buf, []byte{0}) {
		if string(value) == "CAMELLIA_DISCUSSION_JOB="+marker {
			return true
		}
	}
	return false
}
