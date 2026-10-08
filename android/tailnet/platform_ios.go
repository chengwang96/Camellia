//go:build ios

package tailnet

// nodeHostname is the device name the embedded node registers with the control
// plane. iOS builds share this module with Android, so the name is selected by
// build constraint instead of by a runtime check.
func nodeHostname() string { return "camellia-ios" }

// prepareStateDirectory deliberately does nothing on iOS.
//
// Unlike Android, the node runs inside the app's own process rather than in a
// child, so `os.Setenv` is a process-wide side effect rather than a private
// setup step. `HOME` in particular is what Foundation uses to resolve the app
// container, and overwriting it during start-up would change how unrelated file
// access behaves for the life of the app.
//
// It is also unnecessary. tsnet consults `os.UserConfigDir()` — the one reader
// of `HOME` on its start-up path — only when `Server.Dir` is empty, and the
// bridge always sets `Dir` to the state directory. `TMPDIR` needs no redirect
// either: the app's own temporary directory is already private to the app and
// is the right place for the node's scratch files.
func prepareStateDirectory(string) {}
