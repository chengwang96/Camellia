# Desktop remote access and Android control

Camellia's desktop gateway lets an approved Android device read and control desktop conversations over the embedded Tailscale network. The device can send text and supported attachments, stop a run, answer questions, approve or deny one tool request, and download files already referenced by an authorized conversation. It cannot browse arbitrary desktop files, run a terminal command through the gateway, or edit global desktop settings. See the [Android guide](../android/README.md) for the client.

## Pair a device

1. On the desktop, open **Settings → Mobile access** and enable the embedded network. Sign in through the official Tailscale browser flow. The desktop shows its own Tailnet address, usually `100.x.x.x:43127`.
2. Sign the Android client into the same Tailnet. The embedded phone and desktop nodes are distinct devices; Tailnet policy and device approval must allow their connection.
3. Generate a pairing code on the desktop. Scan its QR code on Android or enter the displayed address and one-time code manually. The code expires after five minutes.
4. Review the device name on the desktop and explicitly approve the request. New approvals cover current and future workspaces and standalone conversations; archived conversations remain unavailable.

The QR code contains a versioned JSON object with `v`, `type`, `address`, and `code`. It does not carry the computer name or a device token. Existing restricted devices keep their scope until explicitly upgraded or paired again. Revoke a device in Mobile access to close its streams and reject future requests. Closing the settings panel does not close the gateway; fully quitting Camellia or sleeping the computer interrupts access. If trusted devices remain, the desktop may restore the gateway at startup with its saved login, without opening a browser or creating a new approval.

Mobile access and **CLI devices** share the desktop embedded node. Signing out or stopping that network also disconnects CLI devices. Neither side installs a system VPN or changes Tailscale ACLs, firewall rules, MagicDNS, or sleep settings. If a page reports `Local remote-access window required` after a source update, fully quit the old desktop process, including the tray instance, and restart it.

## Security and data boundaries

- The packaged Go helper uses pinned `tsnet` 1.98.6. The Node gateway listens only on a random `127.0.0.1` port; the helper authenticates to it with a fresh 256-bit transport secret. There is no LAN or public HTTP listener.
- Node identity is encrypted with AES-256-GCM and a key protected by Electron `safeStorage`. The gateway refuses to start if secure storage is unavailable. Device tokens are 256-bit random values, stored as SHA-256 digests on the desktop and encrypted with Android Keystore on the phone.
- Application HTTP travels inside the Tailscale tunnel. The Android client accepts only an explicit Tailnet IPv4 address and port, does not follow redirects, and does not send its token through a system HTTP proxy. Host and Origin checks block cross-origin browser use.
- Authorized devices can read conversation text and referenced artifact bytes. Secrets written in a message body are part of that body; Camellia does not redact them. API keys are absent from ordinary status and history responses.
- An all-access control device can request a `camellia-api-routes` v2 export through `GET /v1/api-keys`; it contains plaintext provider keys. Android asks for confirmation before replacing its own encrypted provider configuration. The desktop configuration is not changed.
- Access is checked again for every request and event stream. Archiving or moving a conversation out of an older restricted scope removes access; revocation closes streams. Pairing is rate limited, and at most 16 event streams (four per device) are allowed.

## Protocol v1

The desktop displays the root address, for example `http://100.80.1.2:43127`. JSON writes require `Content-Type: application/json`. All requests except the two pairing endpoints require `Authorization: Bearer <token>`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/pair/request` | Submit `{ "code": "one-time code", "name": "My Android" }`; receive an application ID and claim credential. |
| POST | `/v1/pair/claim` | Poll with `{ "id": "application ID", "claim": "claim credential" }` at least five seconds apart; receive a token only after desktop approval. |
| GET | `/v1/status` | Protocol, capabilities, permission, gateway `instanceId`, cursor, and supported settings. |
| GET | `/v1/conversations?offset=0` | Up to 100 authorized conversations per page, plus `nextOffset`. |
| GET | `/v1/conversations/{id}` | Recent history, live state, approvals, queue state, and pagination cursor. |
| GET | `/v1/conversations/{id}?before={seq}` | Older history page. |
| GET | `/v1/conversations/{id}/events` | Server-sent snapshot when the conversation changes. |
| GET | `/v1/conversations/events` | Server-sent list snapshots with `listVersion`, `instanceId`, and cursor. |
| GET | `/v1/api-keys` | Plaintext API-route export; requires all-access control permission and the `api-keys` capability. |

`POST /v1/conversations/{id}/commands` accepts an idempotent `requestId`, the current `instanceId`, and an `action`. Supported actions include `send`, `find`, `stop`, `approve`, `configure`, `compact`, queue control, Goal control, and scheduled-task control when advertised in `capabilities`. `send` accepts `prompt`, `expectedSeq`, and optional `queue: true`; a queue holds at most 50 messages per conversation and 200 overall. `/find …` text is answered on the desktop without starting an engine; a newer client can use the dedicated `find` action. An approval is bound to `runId`, `approvalId`, and a content fingerprint, and only grants or denies one request. `stop` must match the current `runId`.

The `next-turn-settings` capability allows a model, thinking-level, or supported Codex Fast change during a run for the next turn. Connection and permission changes still require an idle conversation. Models are distinguished by both model ID and connection, since a subscription and an API route may expose the same ID. The snapshot may carry context and compaction progress; Android displays compaction in the message stream rather than a permanent token counter.

Command results are persisted by request ID. A retry must use the **same** ID and parameters; `pending` means the action is still being prepared, while `unknown` or `interrupted` after a crash must be reconciled before the user chooses another action. HTTP 200 alone does not mean an engine turn completed. A reconnect replaces the current snapshot instead of appending it. `instanceId` changes when the gateway restarts, so old cursors and unconfirmed controls must not be treated as current. The client does not automatically resend a timed-out send, stop, or approval.

### Agent discussions (beta)

A Windows desktop that advertises `discussions` and `discussion-rich` exposes discussion groups to an all-access control device. The ordinary conversation list may include `discussionGroups`, `discussionsNextOffset`, and `discussionVersion`; older capable gateways provide `/v1/discussions`. Restricted devices and Linux servers do not gain discussion access from this capability.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/discussions?offset=N` | Up to 100 groups per page. |
| GET | `/v1/discussions/catalog` | Opaque member binding IDs for configured harnesses and models; no keys or native paths. |
| GET | `/v1/discussions/{id}?before=SEQ` | Message page (at most 80 messages) and member state. |
| GET | `/v1/discussions/{id}/events` | Group snapshot stream. |
| POST | `/v1/discussions/commands` | Create, rename, pin, delete, add or edit members, verify, send, stop, retry, and respond to approvals. |
| GET | `/v1/discussions/commands/{requestId}` | Persistent receipt for the same device and request. |
| GET | `/v1/discussions/{id}/artifacts` | Referenced uploads and generated files; artifact IDs are opaque. |

Groups have at most four members. Discussion sends can target selected participants in parallel or serial order. The richer attachment capability accepts up to 16 files: JPEG images up to 4 MiB each, documents up to 10 MiB each, 32 MiB decoded total, and a 48 MiB JSON request limit. The client sends Base64 bytes, never a phone or desktop filesystem path. Approval responses match the original delivery, run, approval ID, and fingerprint; secret answers are not persisted in the receipt log. Older clients and hosts ignore unsupported capabilities.

## Build and verify

Building the desktop Tailnet helper from source requires Go 1.26.3 or a Go installation able to fetch that toolchain:

```sh
npm run build:tailnet
```

Packaged Windows x64 and macOS arm64 builds include the helper and notices; end users do not need Go. Local checks:

```sh
node --test tests/embedded-network.test.js tests/remote-desktop.test.js tests/remote-access.test.js
node tests/embedded-network-electron.cjs
node tests/electron-smoke.cjs
```

`go test ./...` runs from `integrations/tailnet`. The Android pairing, gateway, and discussion smoke scripts require a built APK and an explicitly selected disposable rooted emulator (`ADB` and `ANDROID_SERIAL`). Those loopback fixtures check protocol and UI behavior, but physical-device Tailnet connectivity, Wi-Fi/cellular handoff, sleep recovery, and iOS behavior still require separate acceptance.
