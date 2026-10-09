package main

import (
	"bytes"
	"syscall"
	"unsafe"
)

// KERN_PROCARGS2 exposes only processes visible to the current user. Return
// only whether our private launch marker exists; never log process credentials.
// Ownership scans run on one supervisor goroutine. Reuse the buffer rather than
// allocating a megabyte for every user process on each scan.
var markerBuffer = make([]byte, 1024*1024)

func hasMarker(pid int, marker string) bool {
	mib := [3]int32{1, 49, int32(pid)} // CTL_KERN, KERN_PROCARGS2
	buf := markerBuffer
	size := uintptr(len(buf))
	_, _, errno := syscall.Syscall6(syscall.SYS___SYSCTL, uintptr(unsafe.Pointer(&mib[0])), 3,
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0, 0)
	if errno != 0 || size < 4 || size > uintptr(len(buf)) {
		return false
	}
	return bytes.Contains(buf[4:size], []byte("\x00CAMELLIA_DISCUSSION_JOB="+marker+"\x00"))
}
