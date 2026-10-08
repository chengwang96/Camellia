//go:build android

package tailnet

import "os"

// nodeHostname is the device name the embedded node registers with the control
// plane. It is platform-specific so a phone and a tablet never collide in the
// same tailnet when the account owns several installations.
func nodeHostname() string { return "camellia-android" }

// prepareStateDirectory points the node's own paths at the app's private state
// directory.
//
// Android needs this: the process is given no writable home, and the libraries
// under tsnet resolve several paths from the environment rather than from
// `Server.Dir`. These are the four they read.
func prepareStateDirectory(directory string) {
	os.Setenv("TS_NO_LOGS_NO_SUPPORT", "true")
	os.Setenv("TS_LOGS_DIR", directory)
	os.Setenv("HOME", directory)
	os.Setenv("TMPDIR", directory)
}
