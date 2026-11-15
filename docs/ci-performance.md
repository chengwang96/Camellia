# CI execution and coverage

The six required check names remain `windows / x64`, `macos / arm64`,
`Acceptance / windows / x64`, `Acceptance / macos / arm64`, Android's `build`,
and `iOS / arm64`. Android also exposes its package job and three test workers;
all ten execution jobs must succeed on the same commit.

## Desktop

Each platform's acceptance job depends only on its own build. Shared YAML step
anchors keep the two platforms' build and acceptance procedures identical.
Cheap Electron/window regressions run before the full native thinking matrix.

`node tests/harness-thinking-smoke.cjs --jobs 4` executes the same 126 native
cases in four separate processes. Each worker owns its ports, router, profile,
sessions and report. The parent rejects failed workers, missing cases,
duplicates and failed case reports. Default invocation remains serial, and an
engine can still be selected, for example `grok --jobs 4`. Reports record turn
and teardown durations separately.

CI uses two workers on Windows and four on macOS. This bounds Windows native
CLI startup contention while retaining every case. Failure artifacts include
each worker's report, and timeouts identify the engine, model, level and recent
driver diagnostics.

Packaged engine installation still starts in an empty app profile, including
the symlink-path and reuse checks. CI uses the runner's temporary workspace
drive and prefers integrity-checked npm cache entries for the pinned lockfiles.
It does not restore already installed engines into the test profile. Logs split
installer, installation, reuse, verification and cleanup time.

## Android

One job builds the production/debug test APKs, runs unit/lint/protocol checks,
and publishes those APKs. Three independent runners test those exact APKs.
`scripts/android-ci-shards.cjs` assigns each explicitly selected class once,
balances approximately by test count, and reserves capacity for pairing,
gateway and discussion integration on the first runner. The selected class
list stays in the workflow; shard logs include the actual selection.

The required `build` check runs even after a failure or cancellation and fails
unless packaging and every worker succeeded. Skipped workers cannot pass it.
Gradle caching covers dependencies and the wrapper, not test results.

## iOS

The dock fixture atomically publishes its final assertion count and verdict in
its own app container. The runner deletes stale results before launching and
requires a successful launch plus a fresh PASS with at least all 140 baseline
assertions and no failures. Truncated console output alone cannot cause a
false failure; a crash, timeout, partial result or assertion failure still fails.
