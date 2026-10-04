# Linux server development preview

Camellia's headless Linux entry point runs as a foreground Node process without Electron or a display server. It keeps workspaces and conversations in a separate server data directory, exposes a local Unix socket for administration, and can pair with a desktop GUI through the embedded Tailscale helper. This is a development preview; see the [Linux acceptance record](linux-server-acceptance.md) for tested builds and remaining live checks.

## What is available

- A single writer for each server data directory; local JSON commands and a live settings menu use the Unix socket.
- Embedded Tailnet login, explicit invitations and server-side approval, revocation, and the existing `/v1` device protocol. The helper does not call a system `tailscale` executable or expose a public listener.
- Server workspaces, standalone and workspace conversations, and on-demand runtimes for DSH, Claude, Codex, Kimi, Antigravity, and Pi. An absent runtime fails explicitly rather than downloading during a request.
- Desktop workbench windows bound to one paired server, with conversations, files, model/permission settings, usage, runtime management, archive, and confirmed cleanup. Local and server histories remain separate.
- An API-route import from the desktop after preview and confirmation. It copies transferable provider routes and keys, not subscription logins or local-only endpoints. The server does not receive a desktop device token through its renderer.

New conversations default to `ask` permission. Starting a server does not start a model request, restore a Goal, run a scheduled check, or install an engine. Real Tailnet and provider acceptance remain separate from the fixture tests below.

## One-terminal pairing

In an extracted Linux package, run:

```sh
./camellia
```

An interactive terminal opens the `launch` wizard; from source use `node scripts/camellia-server.cjs launch`. It reuses a running service with the same data directory, or starts one in the current foreground process. Follow the official Tailscale login link, then enter the displayed address and one-time code in desktop **Settings → CLI devices**. Return to the Linux terminal, refresh the pending requests, select the desktop, and type `YES` to approve it. The desktop then checks authorization. Approval is never inferred from a device name.

If the wizard started the service, keep its terminal open; `q`, Ctrl+C, or terminal EOF stops it. If it attached to an existing service, quitting the wizard leaves that service running. A noninteractive invocation with no subcommand prints help. Use `./camellia --data-dir /absolute/path` to select a directory, consistently across all commands. The desktop and its Mobile access page share one embedded Tailnet identity, so signing out or stopping that node disconnects CLI devices too.

The desktop home screen lists paired servers. Each opens a separate server workbench; closing its window stops its subscriptions and transfers but preserves pairing and server conversations. Disconnected windows disable writes until refreshed. Delete confirmations include the target server; removing a workspace record does not delete its project files.

## Run from source

Use a supported Node.js version and installed production dependencies on Linux. Build the pinned helper before enabling remote networking:

```sh
npm run build:tailnet
node scripts/camellia-server.cjs --help
node scripts/camellia-server.cjs serve
```

The default data directory is `$XDG_DATA_HOME/camellia-server`, or `~/.local/share/camellia-server` if `XDG_DATA_HOME` is unset. An absolute `--data-dir` overrides it. Use a **new directory owned by the current user**, separate from the Electron desktop data directory. The server rejects unsafe permissions and symlink data directories; it does not change permissions on an existing user directory. The Unix socket path must fit within 100 bytes.

In another SSH terminal, with the same data directory:

```sh
node scripts/camellia-server.cjs state
node scripts/camellia-server.cjs menu
node scripts/camellia-server.cjs workspaces
node scripts/camellia-server.cjs conversations
node scripts/camellia-server.cjs create-workspace --payload '{"name":"Project","path":"/srv/project"}'
node scripts/camellia-server.cjs create-conversation --payload '{"engine":"dsh"}'
```

The menu is a live text interface, not demo data. `menu --lang en --ascii` works in a plain SSH terminal. It covers network and devices, provider counts and API routing, runtime installation, native account entry points, workspaces, conversations, and diagnostics. High-impact actions ask for an explicit `YES`; JSON CLI writes are explicit commands and do not add an interactive confirmation. `q` or Ctrl+C closes only the menu. The server also accepts commands such as `settings`, `set-language`, and `set-api-enabled` for automation.

`delete-conversation --payload '{"id":"CONVERSATION_ID"}'` permanently removes that conversation's records and dedicated files, not workspace files; it refuses busy, pending-approval, or armed-Goal conversations. `delete-workspace` removes the workspace record while leaving project files and conversations' working directories intact. Check IDs before using either command.

## systemd user service

Install source and Node at stable paths first. `service-unit` only prints a unit; it does not write, enable, start, elevate, or change linger:

```sh
node scripts/camellia-server.cjs service-unit \
  --data-dir "$HOME/.local/share/camellia-server" \
  --hostname gpu-lab-01
```

Review the generated unit, then save and enable it as your own user if desired:

```sh
mkdir -p "$HOME/.config/systemd/user"
node scripts/camellia-server.cjs service-unit \
  --data-dir "$HOME/.local/share/camellia-server" \
  --hostname gpu-lab-01 > "$HOME/.config/systemd/user/camellia-server.service"
systemctl --user daemon-reload
systemctl --user enable --now camellia-server.service
systemctl --user status camellia-server.service
journalctl --user -u camellia-server.service -n 100 --no-pager
```

Stop any foreground `serve` using that directory before starting the unit. The unit uses a private umask and `Restart=no`. Normal SIGTERM releases its lock; after a crash, inspect the journal and remaining processes before manually handling `server.lock`. Do not blindly delete the lock and restart. A user service's behavior after SSH disconnect depends on the host's user-session and linger policy, which Camellia does not change.

The optional `--restore-network` on `serve` or `service-unit` restores networking only when valid paired devices are already recorded. It never creates an invitation or grants a new device; an expired login still requires a user action. An embedded helper can also be provided with `--helper /absolute/path/camellia-tailnet`.

## Native accounts and models

Native subscription login takes place in a trusted SSH terminal on the server, never through a desktop renderer. Examples:

```sh
node scripts/camellia-server.cjs native-login --payload '{"engine":"claude"}'
node scripts/camellia-server.cjs native-login --payload '{"engine":"codex"}'
node scripts/camellia-server.cjs native-login --payload '{"engine":"antigravity"}'
node scripts/camellia-server.cjs account --payload '{"engine":"kimi","action":"login"}'
node scripts/camellia-server.cjs account --payload '{"engine":"kimi","action":"state"}'
```

Claude, Codex, Google CLI, and Kimi credentials use isolated server locations. The Kimi `state` response includes a temporary device code, not a token. Refresh an account's model catalog after login, then choose an engine connection and model with `engine-settings` or the server workbench. API-route imports stay separate from subscription credentials. A login holds the corresponding native engine reservation until it exits; after a forcibly killed login, confirm the process is gone before restarting the server.

## Package and checks

On a Linux x64 or arm64 host with Node/npm, Go, and tar, `npm run pack:server` produces `dist/Camellia-VERSION-linux-ARCH-server.tar.gz` and a `.sha256` file. It bundles Node, the helper, production dependencies, notices, and source, but no Electron binary, account keys, user data, or preinstalled model runtimes. Verify the checksum before extracting, then run `./camellia` or `./camellia serve`. Build on the target architecture rather than copying native dependencies between architectures.

Useful fixture checks include:

```sh
node --test tests/headless-server.test.js tests/device-transport.test.js tests/device-client.test.js
node --test tests/server-engines.test.js tests/server-package.test.js tests/service-unit.test.js
node --test tests/native-server-settings.test.js tests/api-import.test.js
go -C integrations/tailnet test ./...
```

These tests use temporary directories and fake transport/model drivers. `tests/server-native-smoke.cjs` additionally exercises installed native engines against a local model fixture. Real Tailscale sign-in, Linux DSH execution with a provider, systemd lifecycle, ARM64 packaging, and desktop-to-server operation still require their own acceptance checks. Never infer a live network result from a loopback fixture.
