# Development

[Back to Camellia](../README.md) · [Documentation index](README.md)

Camellia is an Electron application with plain JavaScript, HTML, and CSS renderers. It targets Windows x64 and macOS Apple Silicon (ARM64), with English as the default interface language.

## Local setup

Use Node.js 22.19+ within the 22.x series, or Node.js 24+, and Git. Windows requires Git for Windows with Bash; macOS uses its native shell. Use ARM64 Node.js on Apple Silicon, including when building the application.

```powershell
npm ci
npm run dev
```

The installation hook prepares pinned engine packages under `runtimes/`. Startup checks available runtimes and reapplies the maintained DSH patches. Missing engines can be prepared in the application or with `npm run setup:runtimes`.

## Code layout

| Directory | Responsibility |
| --- | --- |
| `src/main/` | Electron entry point, preload bridge, windows, IPC, backend processes, and runtime management |
| `src/api/` | Provider configuration, same-model routing, protocol conversion, usage, and account adapters |
| `src/engines/` | Claude/Kimi sessions, history, goals, workspaces, DSH configuration, and native settings |
| `src/renderer/home/` | Home screen and engine selection |
| `src/renderer/chat/` | Shared Claude/Kimi conversation UI, sidebar, and goal controls |
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
| DSH | `@deepseek-ai/dsh@0.1.5-rc.1` | Local web backend and embedded UI |
| Claude Code | `@anthropic-ai/claude-code@2.1.270` | stream-json |
| Kimi Code | `@moonshot-ai/kimi-code@0.43.0` | ACP over stdin/stdout |
| DSH plugin package manager | `pnpm@11.7.0` | Runtime tooling |

The per-engine manifests and lockfiles are authoritative. The patched DSH settings and client-modules packages are pinned to `0.1.5-rc.2`, differing from the top-level runtime package. Review patch compatibility before changing upstream pins.

`scripts/prepare-runtimes.cjs` prepares development runtimes. `scripts/prepare-package.cjs` ensures DSH/Kimi are ready and copies Node.js, npm, and the Node license into generated `build/runtime-assets/`.

Desktop distributions contain DSH and Kimi. Claude is installed from the official package into application data on first use rather than redistributed in the bundle.

See [DSH integration](../integrations/dsh/README.md) and [Kimi runtime](../runtimes/kimi/README.md) for implementation details.

## Testing

Run the default suite after routing, session, settings, or process-lifecycle changes:

```powershell
npm test
```

Real Electron and engine checks use temporary profiles, hidden windows, and local mock APIs. They do not require paid model calls.

```powershell
node tests/electron-smoke.cjs
node tests/native-settings-electron.cjs
npm run test:kimi
node tests/kimi-desktop-smoke.cjs
node tests/claude-cli-resume.cjs ./runtimes/claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe
node tests/api-router-cli-smoke.cjs ./runtimes/claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe
```

Browser checks require Python, Playwright, and Chromium:

```powershell
python -m pip install playwright
python -m playwright install chromium
python tests/desktop-ui.py
python tests/api-settings-ui.py
python tests/engine-settings-ui.py
python tests/claude-workspaces-ui.py
```

Browser checks write screenshots under `dist/`. README screenshots live in `docs/images/`; local reference captures belong in the ignored `docs/images/local/` directory.

Choose checks for the changed behavior. Layout and resource-path changes should cover affected browser pages and the Electron entry point. Runtime or packaging changes should also verify a built application.

## Packaging

Build on the operating system and architecture you are targeting. The bundle includes the build host's Node.js and engine native dependencies; the packaging hook rejects mismatched targets.

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

Package verification compares bundled source files with the checkout and checks the entry point, executable name, runtime dependencies, DSH patches, and required license resources. On macOS it also checks the bundled Node.js Mach-O architecture and Kimi's Darwin native resources.

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
