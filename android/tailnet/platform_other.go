//go:build !android && !ios

package tailnet

// nodeHostname keeps the shared module compiling and testable on desktop Go
// toolchains; only the mobile builds ship.
func nodeHostname() string { return "camellia-mobile" }

// prepareStateDirectory does nothing off the mobile platforms, so that
// `go test` never rewrites the developer's `HOME`.
func prepareStateDirectory(string) {}
