# Development

[Back to Camellia](../README.md) · [Documentation index](README.md)

Camellia is an Electron application with plain JavaScript, HTML, and CSS renderers. It targets Windows x64 and macOS Apple Silicon (ARM64), with English as the default interface language.

## Local setup

Use Node.js 22.19+ within the 22.x series, or Node.js 24+, and Git. Windows requires Git for Windows with Bash; macOS uses its native shell. Use ARM64 Node.js on Apple Silicon, including when building the application.

```powershell
npm ci
npm run dev
```

The installation and startup hooks only check already installed engines and reapply maintained DSH patches. They do not download missing engines. Download your selections in the application or run `npm run setup:runtimes -- dsh kimi`; use `--all` explicitly to prepare every engine. Running the setup script with no selection lists the available choices.

## Code layout

| Directory | Responsibility |
| --- | --- |
| `src/main/` | Electron entry point, preload bridge, windows, IPC, backend processes, and runtime management |
| `src/api/` | Provider configuration, same-model routing, protocol conversion, usage, and account adapters |
| `src/engines/` | Claude sessions, Codex app-server, shared streaming/ACP transport, Antigravity SDK bridge, history, goals, workspaces, and native settings |
| `src/benchmark/` | Versioned tasks, independent file/code graders, isolated native harness profiles, trial scheduling and reports |
| `src/renderer/home/` | Home screen and engine selection |
| `src/renderer/benchmark/` | Model selection, run limits, five-engine scores, per-task evidence and report history |
| `src/renderer/chat/` | Shared Claude/Codex/Kimi/Antigravity conversation UI, sidebar, and goal controls |
| `src/renderer/settings/` | Provider, usage, account, and engine-settings interfaces |
| `src/renderer/shared/` | Theme tokens and shared desktop styles |
| `src/shared/` | File-persistence helpers |
| `integrations/dsh/` | DSH settings-shell and frontend resource patches |
| `runtimes/` | Per-engine manifests and lockfiles |
| `scripts/` | Runtime preparation, packaging hooks, and standalone utilities |
| `assets/` | SVG, PNG, and platform icons |
| `tests/` | Unit, integration, Electron/CLI, and browser checks |
| `docs/` | Guides, technical references, archives, and documentation images |

The entry point is `src/main/main.js`; `src/main/preload.js` exposes the renderer bridge. Development resources are located relative to the repository root, independently of the shell's working directory. Packaged runtimes are read from Electron's resources directory.

## Runtime integration

| Component | Pinned package | Interface |
| --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-code@2.1.273` | stream-json |
| Codex CLI | `@openai/codex@0.154.0` | app-server over stdin/stdout |
| DSH | `@deepseek-ai/dsh@0.1.5-rc.1` | Local web backend and embedded UI |
| Kimi Code | `@moonshot-ai/kimi-code@0.43.1` | ACP over stdin/stdout |
| Antigravity | CLI 1.2.3; `google-antigravity==0.1.17`, Python 3.13.14, uv 0.12.15 | CLI stream-json for Google subscriptions; Python SDK for API routing |
| DSH plugin package manager | `pnpm@11.7.0` | Runtime tooling |

The per-engine manifests and lockfiles are authoritative. The patched DSH settings and client-modules packages are pinned to `0.1.5-rc.2`, differing from the top-level runtime package. Review patch compatibility before changing upstream pins.

`scripts/prepare-runtimes.cjs` prepares explicitly selected development runtimes. `scripts/prepare-package.cjs` copies only Node.js, npm, and the Node license into generated `build/runtime-assets/`; it does not install any harness.

Desktop downloads prompt for a connection and pass it through `src/main/download-network.js` to npm, uv, and the Python installer download. Each installation uses its own HTTP dispatcher and child-process environment. Source setup uses the shell's proxy environment variables; it does not read another profile's desktop preferences.

Desktop distributions contain download manifests and lockfiles for all five engines, with no harness binaries or dependency trees. The runtime manager downloads the selected engine into application data and applies DSH patches after installation and when reusing an existing DSH runtime, so integration changes follow application upgrades. Antigravity downloads its dedicated relocatable Python together with the SDK. Development dependencies already present under `runtimes/` are excluded from packaging too.

`src/engines/codex-client.js` launches the pinned native Codex executable and handles app-server requests and lifecycle. `codex-session.js` maps thread/turn events and approval requests to the shared UI. `streaming-session.js` provides the display history and event replay shared with ACP engines. The manager in `codex.js` owns per-session connection selection and the account service. Editable TOML and instructions are copied into separate API/subscription homes; personal `CODEX_HOME`, API credentials, and global Codex settings are not used.

Codex API mode uses `src/api/responses-protocol.js` to bridge Responses into the existing same-model router. It preserves streamed text, reasoning, parallel function calls, raw custom tool inputs, and token usage. Partial stream failures emit `response.failed` and never rotate to another key after output begins. Protocol fixtures and `npm run test:codex` verify these contracts; the native smoke also checks file writes, resume, fork, cancellation, and an empty isolated account. A live ChatGPT login and quota require an eligible account and are not covered by offline tests. When updating the pin, generate schemas with the new CLI and review the [official app-server documentation](https://developers.openai.com/codex/app-server).

For third-party API models absent from the native catalog, `codex-models.js` supplies the pinned fallback metadata with Codex's native `apply_patch` handler enabled. The default instructions and reasoning settings stay the same. Known native models, explicit user catalogs and subscription connections retain their native configuration. The versioned metadata and upstream license are in `src/engines/codex-metadata/`; review them when upgrading the CLI. This avoids the Windows batch wrapper truncating multiline patches. Native smoke tests reproduce that failure and verify raw patch streaming, Unicode/quotes/spaces, multiple files, and a denied native patch approval. See [the timeout investigation](benchmark-codex-patch-2026-09-16.md).

Antigravity uses `LocalOpenAIAgentConfig` against Camellia's local router. `src/engines/antigravity/bridge.py` adapts SDK chunks, policies, tool hooks, and saved conversations to the ACP transport shared with Kimi. This Python file is unpacked from ASAR in desktop builds. Its package directory is selected through `PYTHONPATH`; no global Python or CLI settings are changed. Runtime downloads and dependencies are pinned with checksums in `runtimes/antigravity/`.

SDK 0.1.16's OpenAI strategy does not forward configuration policies or image parts. The bridge enforces permissions through the public `policy.enforce` tool hook and rejects image input explicitly. The native smoke test covers both behaviors, along with shell execution, MCP, cancellation, and independent session forks; retain those checks when updating the SDK.

Google subscription mode uses `src/engines/antigravity/cli-bridge.cjs` under bundled Node. It translates the official CLI's stream-json protocol into ACP, maps Camellia's `agy-` session IDs to native conversation IDs, and converts cumulative usage to per-turn counts. Authentication remains in the official CLI. The native CLI settings are managed alongside the other engines' settings. No OAuth token extraction or internal Google gateway emulation is used. Both adapters are unpacked from ASAR.

Run `npm run setup:antigravity:subscription` and `npm run test:antigravity:subscription` to verify the real CLI against a local Gemini fixture with an isolated home directory. This covers model parsing, multi-turn streaming, persisted resume, file tools, explicit review rules, and cancellation. It does not validate a live Google subscription. The bundled-runtime install smoke test also installs and checks this connection; base-package verification asserts that neither CLI nor Python is bundled.

See [DSH integration](../integrations/dsh/README.md) and [Kimi runtime](../runtimes/kimi/README.md) for implementation details.

## Testing

Run the default suite after routing, session, settings, or process-lifecycle changes:

```powershell
npm test
```

Real Electron and engine checks use temporary profiles, hidden windows, and local mock APIs. They do not require paid model calls.

Prepare the engines needed for these integration checks explicitly with `npm run setup:runtimes -- --all`.

```powershell
node tests/electron-smoke.cjs
node tests/native-settings-electron.cjs
npm run test:codex
npm run test:kimi
npm run test:antigravity
npm run test:benchmark
npm run test:tools
node tests/tools-native-audit.cjs --permissions
node tests/tools-native-audit.cjs --permissions --allow
node tests/tools-native-audit.cjs --upstream-error
node tests/kimi-desktop-smoke.cjs
node tests/claude-cli-resume.cjs ./runtimes/claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe
node tests/api-router-cli-smoke.cjs ./runtimes/claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe
```

`test:tools` runs nine native read/search/write/edit/error probes through each of the five API engines plus DSH's separate ACP chat entry. It verifies fragmented and interleaved tool arguments, Unicode, exact result IDs and benchmark error evidence. The permission variants exercise real Claude and DSH approvals and denials. See the [tool integration audit](harness-tools-audit-2026-09-16.md) for findings and coverage limits. Antigravity's SDK uses a dedicated local compatibility path to receive complete tool argument deltas; its profile version is recorded in benchmark reports. Claude print mode explicitly connects its permission prompt to the stdio host.

The upstream-error variant deliberately returns HTTP 400 after native reads. Kimi 0.43.0's ACP can report a normal end despite that error; benchmark checks the last tool-enabled API outcome before grading. Successful title requests cannot override a terminal agent API failure.

Browser checks require Python, Playwright, and Chromium:

```powershell
python -m pip install playwright
python -m playwright install chromium
python tests/desktop-ui.py
python tests/benchmark-ui.py
python tests/api-settings-ui.py
python tests/engine-settings-ui.py
python tests/claude-workspaces-ui.py
```

Browser checks write screenshots under `dist/`. README screenshots live in `docs/images/`; local reference captures belong in the ignored `docs/images/local/` directory.

`test:benchmark` drives all five real API runtimes concurrently against one local model fixture: overlapping API requests, native file writes, independent grading, model/provider pinning, isolated per-trial usage, and cancellation. Its fake responses validate integration only and must never be reported as model benchmark scores. `benchmark.test.js` covers grading, Unicode mismatch diagnostics, exceptions and file checks, report persistence, fresh directories, repeats, independent engine queues, concurrent cancellation and accounting, shared budget stops, per-task limit isolation, worker cleanup after persistence errors, and interrupted-run recovery; router tests cover scoped traffic and cancellation. When changing task content or scoring rules, bump the suite version before publishing; reports also record a hash of the full task definition. The independent checker lives in `src/benchmark/verifier.js` and records its own version. Expected values stay in the parent process; the restricted child receives only inputs. Diagnostic previews are bounded and displayed as text.

The additional `checkScore` metric is defined by `checkScoreMethod` (`mean-trial-check-fraction-v1`). It averages unrounded per-attempt fractions, while the existing `score` field remains the full-task pass rate. Tests distinguish partial credit, equal task weighting, repeated attempts, unexecuted checks, API/runtime failures, incomplete runs, and historical reports with missing counts. Changing this metric's formula requires a new method identifier; UI and exports name both metrics explicitly.

External question libraries live in `src/benchmark/libraries.js`: fixed source revisions and checksums, on-demand downloads, pinned Python environments, stable sampling, and public/private task separation. `python-verifier.js` starts one cancellable process per DS-1000 execution loop or SciCode subproblem. `python/check.py` preserves the official case order, shared variables and random state, reporting each case over a bounded JSON-lines protocol. A later timeout retains completed checks. The checker uses isolated Python imports; agents' scratch tests use `-E -s -X utf8` so `import solution` works. Scientific subprocesses use one numerical-library thread to avoid oversubscription when five engines run together. Unlike the built-in Node permission checker, these local Python processes are not a security sandbox. Keep answers and checker programs out of agent files and prompts. `tests/benchmark-libraries.test.js` covers download integrity, task selection, provenance, private-answer exclusion, report compatibility and the runner's external-verifier routing.

After preparing both libraries in the app, run `npm run test:benchmark:science` (or pass an explicit library directory to `tests/benchmark-science-smoke.cjs`). It checks an official reference solution from each of DS-1000's seven libraries, three SciCode validation problems against the real HDF5 targets, deliberately wrong candidates, partial credit, UTF-8/BOM files, timeouts and cancellation. It uses no model API. `node tests/benchmark-native-smoke.cjs --science` also exercises all five real harnesses concurrently with a loopback API fixture, writing a DS-1000 solution through native tools and grading it with the prepared Python environment. The small SciCode fixtures retain their upstream provenance and Apache-2.0 license; they are not packaged into the application.

Dependency inputs and generated hash locks are in `src/benchmark/requirements/`. Regenerate with `uv pip compile <input> --python-version 3.10 --universal --generate-hashes --output-file <lock>`, then verify both supported platform resolutions and run native smoke tests. Windows requires the `tensorflow-intel` package explicitly and the last Windows `tensorflow-io-gcs-filesystem` wheel; macOS ARM64 uses its separate filesystem-wheel version. Environment/adapter cache changes require a new `ADAPTER_VERSION`; grading fixes bump `PYTHON_GRADER_VERSION` without redownloading data. Scientific Python files must be unpacked from ASAR so the managed interpreter can execute them; official datasets and installed scientific packages remain outside the application bundle.

`diagnostics.js` records independently reproduced question limitations and shared failed cases across engines. Notices never alter upstream answers or historical scores. Known problematic questions sort last in SciCode's versioned sample policy; the full split retains them. Complete `solution.py` snapshots (up to the grader's 1 MiB limit) and SHA-256 hashes take priority over scratch-file diffs; binary caches are omitted. `scripts/regrade-benchmark.cjs` resolves saved IDs against the full catalog, so changed sample order cannot prevent offline regrading.

For an explicitly authorized paid diagnostic, `node scripts/benchmark-live-audit.cjs --use-configured-api` uses the configured Ollama `deepseek-v4.1-flash` model on SciCode #74 and DS-1000 #354/#160 across all five native runtimes. Optional `--science-only` runs just the science control; `--timeout-seconds=300` changes the default 180-second limit equally for all engines. It uses separate temporary router credentials and report directories, with bounded calls/tokens, and does not modify the app's active run. This is an integration control, not a representative harness leaderboard.

`--preview --codex-only --model=kimi-k3` runs the three preview tasks through just Codex with the same shared 270-second deadline, 250K tokens per task and 40-request limit. It records `single-engine-audit` and must not be imported or presented as a five-engine comparison. New reports also retain bounded tool errors and their timestamps, so a failed editing loop can be distinguished from API waiting in the task details.

Choose checks for the changed behavior. Layout and resource-path changes should cover affected browser pages and the Electron entry point. Runtime or packaging changes should also verify a built application.

## Packaging

Build on the operating system and architecture you are targeting. The bundle includes the build host's Node.js; the packaging hook rejects mismatched targets. Optional engines download the correct native packages on the user's machine.

On Windows x64:

```powershell
npm run pack
node tests/verify-package.cjs ./dist/win-unpacked
npm run dist:win
node tests/portable-smoke.cjs
```

On an Apple Silicon Mac:

```sh
npm run pack:mac
node tests/verify-package.cjs ./dist/mac-arm64/Camellia.app
npm run dist:mac
```

| Platform | Output | Location |
| --- | --- | --- |
| Windows x64 | Directory build | `dist/win-unpacked/Camellia.exe` |
| Windows x64 | NSIS installer | `dist/Camellia-Setup-<version>-win-x64.exe` |
| Windows x64 | Portable ZIP | `dist/Camellia-<version>-win-x64-portable.zip` |
| macOS ARM64 | Application bundle | `dist/mac-arm64/Camellia.app` |
| macOS ARM64 | Disk image / archive | `dist/Camellia-<version>-macOS-arm64.dmg` / `.zip` |

Extract the portable ZIP once and launch `Camellia.exe`. Keep the full extracted folder together, including its `resources/` directory. Subsequent launches run directly from that folder.

Windows artifacts use ZIP payloads to remain compatible with the installer extractor. The portable smoke test extracts the ZIP, verifies its sources and runtimes, and runs the bundled Electron executable. Pass an archive path when testing a custom output directory.

The [desktop workflow](../.github/workflows/desktop.yml) runs unit tests, Electron smoke tests, native DSH settings checks, packaging, and bundle verification on Windows x64 and macOS ARM64. Builds require a successful native job before they can be treated as validated for that platform. macOS builds use ad-hoc signing for development; no distribution certificates or notarization credentials are configured. For public distribution, override the signing identity, enable hardened runtime, and configure Apple notarization. See the [Electron Builder signing guide](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/).

To select another output directory:

```powershell
npm run pack -- --config.directories.output=dist/camellia
node tests/verify-package.cjs ./dist/camellia/win-unpacked
```

Package verification compares bundled sources and download manifests with the checkout, verifies shared Node.js/npm and licenses, and asserts that no harness runtime is bundled. On macOS it also checks Node.js Mach-O architecture. CI runs `tests/runtime-install-smoke.cjs <resources-directory> --all` with an empty application-data directory and no global Node or Python on PATH. This installs each engine separately, verifies that unselected engines remain missing, checks the DSH patches, and runs real Codex/Kimi/Antigravity tool and routing tests using the downloaded runtimes.

The pinned official Claude installer uses the filename `bin/claude.exe` on every platform, including macOS. The contents are the platform's native executable; keep that filename in CLI test commands.

## Standalone utilities

Run the API pool without the desktop interface:

```powershell
node scripts/ollama-proxy-cli.js --help
node scripts/ollama-proxy-cli.js --port 8788
```

The historical filename is retained, but this utility uses the shared multi-provider router. It reads the same pool configuration at `~/.dsh/ollama-proxy.json`, or under `DSH_HOME` when set. The `--port` option updates the saved router port.

`scripts/ollama-switch-account.ps1` is a separate legacy utility for local Ollama application accounts, not the API key-pool mechanism.

## Contributing

Keep changes in the relevant source area and add regression coverage when behavior changes. Provider adapters belong in `src/api/`; engine-specific protocol behavior belongs in `src/engines/`. Preserve the same-model routing contract when adding providers or models.

Run applicable checks and include their results in the pull request. Update both README languages when changing setup instructions or user-facing capabilities. Keep generated builds, runtime dependencies, credentials, and local screenshots out of commits.
