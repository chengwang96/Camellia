# Linux server acceptance record

Date: 2026-09-26. Environment: Windows development host, Ubuntu on WSL, Linux x64, Node 24.16.0, Go 1.26.3.

## Delivered

- Linux-only CLI host without Electron, private local control socket, single-writer data lock, independent workspaces and conversations.
- Embedded tsnet networking, server-local login link, approval-based pairing, revocation, optional trusted-device restoration, encrypted network state.
- Electron CLI-device workbench with device isolation, workspace create/rename/remove, independent/workspace conversations, send/stop/approval, rename/pin/archive/restore/delete, batch deletion, model/permission/thinking selection, older-history pagination, bounded attachment upload and cancellable artifact download.
- Explicit desktop-to-server API import; provider allowlist, encrypted paired transport, no subscription migration, keep-server conflict policy, revision checks, durable receipts and rollback.
- Live bilingual terminal settings with the Camellia name and character cat, explicit confirmations, runtime management and server-local account entry points.
- All five engine adapters: DSH, Claude Code, Codex CLI, Kimi Code and Antigravity SDK. Subscription login uses isolated server-side homes, never desktop credentials.
- systemd user unit generation without automatic installation or privilege escalation.
- Native Linux package builder: bundled Node/npm, production dependencies, helper and licenses, no Electron executable or user credentials.
- Remote native-document editor for all five engines, fixed document allowlist, routing/account-field protection, revision and busy checks, explicit confirmation, and server-local terminal editor.
- Safe Markdown chat presentation with headings, lists, tables, quotes, inline/fenced code, copy/wrap controls and confirmed external links; no raw HTML execution or remote-image loading.

## Built artifact

`dist/server-linux-x64-settings/Camellia-0.1.0-linux-x64-server.tar.gz`

Matching SHA256: `dist/server-linux-x64-settings/Camellia-0.1.0-linux-x64-server.tar.gz.sha256`.

This is a development/acceptance build, not a claim of production readiness. Extract to a stable path and run `./camellia --help`. See [deployment guide](linux-server-preview.md).

## Checks actually executed

| Check | Result / boundary |
| --- | --- |
| Node regression suites | Latest focused server/network/UI-backend run: 110 passed, 2 Linux-only cases skipped on Windows; engine protocol suites also passed in a broader run |
| File/archive follow-up | 89 tests passed, 2 Linux-only cases skipped on Windows; 12 file/desktop-controller tests also passed on Linux, plus client/transport tests |
| Native settings and display follow-up | 126 tests passed, 3 Linux-only skips in the focused Windows regression run; 18 host/native-settings tests passed on Linux; additional damaged-file validation passed separately |
| Linux host/settings/service tests | 27 passed on WSL/Linux; subsequent real-engine checks below cover the added runtime paths |
| GUI automation | Playwright passed pairing, device isolation, API import confirmation, native editor target/confirmation/save, Markdown structure/XSS rejection/code copy/wrap, attachment selection/send, artifact list/download/cancel, batch deletion, archive restore, history pagination, thinking selection, offline guards, and narrow layout using a mocked IPC bridge |
| Native package | Built on Linux x64; checksum verified; extracted in a temporary directory; bundled launcher/helper executed; server created a conversation and stopped cleanly without Electron |
| Terminal | Actual Linux PTY menu confirmed cancel behavior, native editor save confirmation, menu exit without stopping service, and graceful service shutdown |
| systemd | Generated unit statically verified; actual user service manager unavailable in this WSL environment |
| Tailscale helper | Linux helper returned an official login URL, persisted encrypted state and restarted retaining the key; no account authorization was performed |
| Go | Tailnet unit tests passed, including outbound target/path restrictions, stream cancellation and redirect rejection |
| Runtime installation | Real Linux installation/version or module import checked: DSH 0.1.5-rc.2, Kimi 2.0.0, Codex 0.154.0, Claude 2.1.273, Antigravity CLI 1.2.11, Python SDK 0.1.17 |
| Complete headless native path | All five engines passed `server-native-smoke.cjs`: native settings saved over the paired gateway, first attached-file turn, another native edit, process refresh and successful second turn in the same conversation; all model responses came from a local fixture |
| Kimi native protocol | Existing CLI smoke passed streaming, tools, approval/denial, cancellation, native resume/fork and same-model failover |
| Codex native protocol | Existing native smoke passed patch/shell, permissions, resume/fork, cancellation, usage and isolated account configuration |
| Claude native protocol | Actual CLI completed a Read tool round through the API router and local OpenAI-format fixtures after same-model failover |
| Antigravity SDK | Existing smoke passed file/shell/MCP tools, permissions, plan mode, resume/fork and cancellation using a local model fixture |
| Antigravity CLI | Existing official CLI smoke passed model listing, streaming, native resume, review denial and cancellation using a local Gemini fixture |

No paid model API was called in these tests, no production key was read for a test, and no user's subscription or tailnet account was authorized.

## User-assisted acceptance still required

1. Sign into the server and desktop embedded Tailscale identities in the intended tailnet, approve pairing on the server, and verify real cross-device ACL, reconnect and revocation behavior.
2. Sign into the desired subscriptions on the Linux server using the native terminal/device-code flow. Verify the actual account's models and quota; this requires account-owner interaction and cannot be replaced with fake success.
3. Select a real API route/account model and authorize a billable smoke request if desired. Loopback fixtures do not prove provider availability, quota or account eligibility.
4. Install the reviewed systemd user unit on the target server and verify logout/linger and reboot policy under its actual administrator configuration.
5. Build and run on Linux ARM64 hardware before advertising that artifact as verified; only x64 was built here. The SDK installer targets glibc, not Alpine/musl.

## Deliberate preview limits

The remote workbench is an ordinary settings page (prefixed ids, scoped styles, no overlay or embedded browser view) rather than a full replacement of the local chat UI. Attachments, artifact download, batch deletion, archive restoration, allowlisted native-document editing and safe Markdown presentation are implemented. Arbitrary server filesystem editing, credential-file editing, full Markdown extensions and exact pixel parity with the local chat UI are intentionally not provided. API import adds new providers and skips entire conflicting providers rather than overwriting them. Full-screen terminal design remains a separate preview; the live menu is an SSH-friendly numbered interface.

These limits should stay visible in release notes. They do not authorize silently broadening permissions, deleting server files, moving subscription tokens between devices, or treating unperformed real-network tests as passed.
