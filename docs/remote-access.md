# Desktop remote access and Android control

Camellia's desktop gateway lets an approved Android device read and control desktop conversations over the embedded Tailscale network or a pinned TLS connection on the same private LAN. A phone can discover computers on its Tailnet automatically and request access without scanning a QR code; a pairing code remains available as a fallback. The device can send text and supported attachments, stop a run, answer questions, approve or deny one tool request, and download files already referenced by an authorized conversation. It cannot browse arbitrary desktop files, run a terminal command through the gateway, or edit global desktop settings. See the [Android guide](../android/README.md) for the client.

## Tailnet trust and discovery

Enable **Settings → Mobile access → Tailnet trust** to let phones on the same Tailnet discover this computer. The desktop reads its own Tailnet owner identity from the embedded node and allows that owner by default. **Automatically approve my devices** is off by default: a phone's first request appears under **Authorized devices** for explicit approval. Turning it on approves same-owner devices immediately. The optional `allowedUsers` and `allowedTags` fields in `tailnet-trust.json` can extend the policy, but the settings panel currently exposes only the owner allowlist and the automatic-approval switch.

The phone reads the embedded node's peer table, probes each online peer's `GET /v1/hello` over Tailscale with a short timeout, and shows only peers that answer as Camellia. The hello endpoint is unauthenticated at the application layer but is reachable only through the embedded helper transport secret. It returns only the protocol, computer ID and name, supported authentication and join flags, and transport descriptors. It does not return conversations, keys or device tokens.

The desktop helper authenticates the caller's Tailscale node and user with the local `WhoIs` API and forwards that identity to the loopback gateway in private headers. The gateway never accepts Tailscale identity headers from an untrusted transport. A first connection uses `POST /v1/tailnet/request` with the phone name and then `POST /v1/tailnet/claim` with the returned id and claim. The claim is bound to the same Tailscale node that made the request. The approved device receives its own 256-bit computer-specific token; tokens are never shared between phones or computers.

The phone stores the desktop computer ID, Tailscale node ID and login alongside the LAN route. Discovery refreshes the Tailscale address and can populate the pinned LAN descriptor, while the existing route selector still prefers a verified LAN path and falls back to Tailscale. The QR and one-time-code flow is retained for older clients, computers with Tailnet trust off, and recovery when the embedded helper has not been updated.

The Android client currently implements the discovery and first-request UI described here. The iOS client still uses the QR and pairing-code flow; its shared embedded-network bridge contains the same peer and hello primitives for a future macOS build.

The desktop main process and embedded helper must both come from an updated build. Fully quit Camellia, including the tray, and restart it after installing the update; a phone-only update cannot add the verified identity headers or the discovery endpoint.

## Device names

Each device owns the name it reports for itself. A desktop or phone can change its own **This computer name** or **Phone name** in settings; every paired peer updates that label on its next authenticated connection. A desktop may keep a private **remark** for a phone, and a phone may keep a private remark for a computer, but neither remark changes the other device's own name. No device can rename another device through the remote gateway.

The embedded Tailscale name follows the Camellia name when **Follow this computer name** is on. It is on for new embedded nodes and can be turned off to keep the name already registered. Existing nodes upgraded to this version keep their current Tailscale name until the user turns following on, so MagicDNS names, SSH configuration and bookmarks are not silently changed. The settings panel reports the Camellia name separately from the Tailscale control-plane result because the control plane may assign a `-1` suffix or an administrator may pin a different name.

The authenticated `POST /v1/device/name` call updates only the record belonging to the credential making the request. Offline changes remain local to the device and are retried when it next connects; the latest name wins after several edits. A name change does not alter the pairing, token, workspace scope or revoke state.

## Pair a device

If Tailnet trust is enabled and the phone is on the same Tailnet, skip to step 4: the phone should list this computer automatically, and the request appears here for approval. Use the following QR or one-time-code flow when trust is disabled, the phone is an older build, or the computer must be recovered.

1. On the desktop, open **Settings → Mobile access** and enable the embedded network. Sign in through the official Tailscale browser flow. The desktop shows its own Tailnet address, usually `100.x.x.x:43127`.
2. Sign the Android client into the same Tailnet. The embedded phone and desktop nodes are distinct devices; Tailnet policy and device approval must allow their connection. Each node uses the saved **device name** (desktop: **This computer name**), or a platform default such as `camellia-desktop`, `camellia-android` or `camellia-ios` when no name has been set.
3. If automatic discovery is unavailable, generate a pairing code on the desktop. Scan its QR code on Android or enter the displayed address and one-time code manually. The code expires after five minutes.
4. Review the device name on the desktop and explicitly approve the request. New approvals cover current and future workspaces and standalone conversations. Archived conversations stay out of the ordinary list but remain readable, and only restorable, when a phone is already viewing one.

The QR code contains a versioned JSON object with `v`, `type`, `address`, and `code`. It does not carry the computer name or a device token. Existing restricted devices keep their scope until explicitly upgraded or paired again. Revoke a device in Mobile access to close its streams and reject future requests. Closing the settings panel does not close the gateway; fully quitting Camellia or sleeping the computer interrupts access. If trusted devices remain, the desktop may restore the gateway at startup with its saved login, without opening a browser or creating a new approval.

## Local network mode

For a household that only needs the same Wi-Fi, enable **Local network** in the same desktop window. Camellia generates a self-signed TLS identity, listens only on one selected private IPv4 address and an available local port, and advertises that port through mDNS/DNS-SD. The desktop does not need a Tailscale login for this mode.

The Android client discovers `_camellia._tcp` services automatically. Enter the desktop's six-digit PIN once; the desktop verifies it, enrolls the phone and issues the same kind of 256-bit device token used by Tailscale pairing. The phone stores the TLS certificate fingerprint and reconnects automatically. The PIN is never advertised over mDNS, is stored as a scrypt verifier on the desktop, and is not used as a per-request credential.

Android also sends a fixed UDP broadcast and multicast probe on port 52638 and falls back to mDNS. This keeps discovery working when a VPN owns the system mDNS network. The desktop replies directly to the phone with its computer identity, current LAN endpoint, certificate fingerprint and whether new devices may join. The reply never contains the PIN or a device token.

On Windows, enable **Local network** and approve the system prompt if it appears. Camellia configures app-specific inbound rules for the local subnet. It uses TCP 42639 for HTTPS and UDP 52638 and 5353 for discovery. The fixed ports let the rules work across restarts. Disabling local access closes the listener and requests removal of Camellia's rules. If approval is cancelled, the settings panel offers a retry. Guest Wi-Fi, hotel networks and some office access points can still isolate clients or block multicast.

On macOS, enable **Local network** and allow access when macOS prompts. If the macOS firewall asks about incoming connections, allow Camellia. The **macOS connection permissions** section links to Firewall settings and, on macOS 15 or newer, to Local Network privacy settings. A **Listening** status means the local HTTPS server has started. The phone confirms reachability when it connects.

The desktop's **Allow new devices** switch controls enrollment. Turn it off after the household phones have joined. Revoking a device rejects its token; rotating the PIN prevents a removed device that still knows the old PIN from enrolling again. The same PIN can be configured on several household computers, but it is not synchronized by Camellia; device tokens and revocations remain per computer.

On Android, use **Add computer** and scan the local network to connect to a discovered computer. For an existing pairing, the app validates the LAN certificate against its saved fingerprint or a descriptor from the authenticated Tailscale connection, then checks the device credential over LAN. This works with **Allow new devices** off. If the identity cannot be verified or the credential was revoked, the scan offers PIN re-pairing when the desktop allows new devices. A successful re-pair updates the existing Android computer entry when its identity matches.

LAN and Tailscale endpoints belong to one computer identity. The phone prefers a discovered, certificate-matched LAN endpoint and falls back to Tailscale when available. A computer with no Tailscale enrollment remains visible as local-only and cannot be reached after the phone leaves the LAN. The phone does not silently substitute another computer. A network change invalidates the old LAN address; discovery updates it without re-pairing. The current iOS client still uses the Tailscale pairing flow only.

On Android, a paired computer with a Tailscale address has one **Automatic LAN direct** switch. It is available in the phone management menu and under **More actions → Connection settings** on tablets. When on, the app prefers a discovered LAN route with a matching computer identity and pinned certificate, falling back to Tailscale when discovery loses the LAN route. When off, it uses Tailscale. A LAN-only computer can add a Tailscale route from the same settings by entering its address or scanning its QR code, reusing the pairing. Adding the same computer through **Add computer** also merges the routes when the authenticated computer identity matches.

While mobile access is enabled, the desktop checks helper status every five seconds. A failed status check closes the gateway, and the next retry stops any surviving helper before restarting it. Pairing and the encrypted node identity are retained. The status snapshot also carries control-plane `online` and `health` diagnostics; neither is treated as proof that a peer data path is unavailable.

## Keep access recoverable

**Settings → Mobile access → Background guard** starts a small native helper on Windows and macOS. The helper is enabled only after mobile access has at least one trusted device. It uses roughly 5–15 MB of memory, receives a heartbeat from the desktop every five seconds, and restarts Camellia with a hidden window after a crash or hang. The restart uses a 5, 10, 20, then 30 second retry delay.

While the guard is active, Electron keeps the application and system from entering idle suspension. This is intended for a laptop that stays powered on while the user is away. Closing the lid, choosing Sleep, losing power or fully quitting Camellia still disconnects mobile devices. A deliberate quit writes a stop marker before Electron exits, so the guard does not fight the user's choice. Disabling mobile access pauses the guard, and enabling access again resumes it if trusted devices remain.

Installed Windows and macOS builds add Camellia to login items when the guard is enabled, so a reboot can restore mobile access without opening the main window. Portable Windows builds keep the in-session guard but do not create a login item.

## Update the embedded component

Open **Settings → Mobile access → Embedded Tailscale** on Windows x64 or Apple Silicon. Check for updates and select the offered version. After downloading and verifying the component, Camellia temporarily disconnects mobile access, stops only the old helper, starts the verified replacement, and restores mobile access. The desktop application and active conversation replies keep running. If the replacement fails to start, Camellia attempts to restore the previous helper and keeps the verified download available so the same button can retry activation without downloading again. The existing Tailscale identity and pairing data are retained. Android and iOS receive the embedded library when the mobile app is updated.

## Choose a network path

Tailscale chooses the path automatically for every phone-to-computer connection. It first tries a direct UDP connection, then a peer relay when the tailnet grants one, and finally Tailscale's DERP relays. It keeps retrying a direct path and upgrades the connection when possible. The phone labels each computer with the observed route: **Direct · peer-to-peer**, **VPS relay · Peer Relay**, or **Public relay · DERP**.

Direct UDP can cross the public internet using NAT traversal; it does not require the phone and computer to share a router, LAN or city. The phone classifies the target's discovery-ping response, rather than inferring the path from Wi-Fi, geographic distance or HTTP latency. Refreshing computer status or changing the phone network clears previous labels, and results from an older refresh cannot overwrite the current one. Failed probes remove the old label without marking a successful HTTP connection as failed.

Settings → Mobile access → **Network path** is a switch for this computer, not a tailnet-wide relay manager. It is off by default, so Tailscale chooses direct or DERP automatically. Turning it on lets the user choose one device that already has the `Peer Relay` marker in the Tailscale admin console. Saving writes a grant whose `src` is this computer's Tailnet IPv4 address and whose `dst` is the selected relay's Tailnet IPv4 address. It does not add or replace device tags or change another computer's relay access. Turning the switch off removes only that exact grant.

Camellia reads the whole policy file, validates the candidate, and writes it with the ETag from that read, so a concurrent ACL edit fails instead of being overwritten. Existing relay grants, including tag-based and broader grants, are recognized as usable and left unchanged. The switch controls authorization only; it does not start the relay service or select a route outside Tailscale's direct-then-peer-relay-then-DERP order.

The Tailscale REST API does not expose whether a device has enabled its relay UDP port. Camellia therefore treats a configured grant as the authoritative relay marker; the candidate picker asks the user to choose only servers that already run `tailscale set --relay-server-port`. It cannot discover an unconfigured relay service automatically.

An OAuth client is optional for this step. Create it from the Tailscale Trust credentials page with `policy_file:write` and `devices:core:write`; Camellia stores the client secret with Electron `safeStorage`. The grant takes effect only when the VPS also runs `tailscale set --relay-server-port=<port>` and its firewall or cloud security group allows that UDP port. Applying the grant does not start or configure the relay process.

## Security and data boundaries

A full-device control pairing can use **Remote control → computer menu → Restart desktop Camellia** on Android and iOS. Confirming saves desktop settings and relaunches the application through its normal shutdown. Running replies stop; Goals and scheduled checks pause. The connection briefly disconnects; pull to refresh after startup. Pairing and conversations remain saved. Update and restart the desktop once to enable this feature.

The desktop advertises `desktop-restart` only to full-device control devices. `POST /v1/desktop/restart` requires `confirmed: true`, a UUID `requestId`, and the current status `instanceId`. The receipt is persisted before acknowledgment, and restart starts after the acknowledgment is written. Repeating that same request after reconnecting returns its receipt without restarting again. The endpoint is unavailable to read-only and workspace-scoped pairings.

- The packaged Go helper uses pinned `tsnet` 1.104.7. The Tailscale gateway listens only on a random `127.0.0.1` port; the helper authenticates to it with a fresh 256-bit transport secret. The optional LAN gateway listens only on a private IPv4 address over TLS and is never exposed on a public interface.
- Tailnet discovery and access requests depend on the helper's local `WhoIs` result. The gateway accepts that identity only through the private loopback transport and strips any client-supplied Tailnet identity headers. `tailnet-trust.json` stores policy and owner identity, not device tokens. Same-tailnet membership is not sufficient on its own: an out-of-policy device receives no claimable token, and nodes shared into the tailnet by another owner are not auto-trusted.
- Node identity is encrypted with AES-256-GCM and a key protected by Electron `safeStorage`. The gateway refuses to start if secure storage is unavailable. Device tokens are 256-bit random values, stored as SHA-256 digests on the desktop and encrypted with Android Keystore on the phone.
- Tailscale application HTTP travels inside the tunnel. LAN application HTTP uses TLS pinned to the certificate fingerprint learned from the desktop or its authenticated status response. The Android client accepts only an explicit Tailnet IPv4 address or a private LAN IPv4 address, does not follow redirects, and does not send its token through a system HTTP proxy. Host and Origin checks block cross-origin browser use.
- Authorized devices can read conversation text and referenced artifact bytes. Secrets written in a message body are part of that body; Camellia does not redact them. API keys are absent from ordinary status and history responses.
- Official DeepSeek and Kimi web surfaces are desktop-only. Gateway responses do not include their sessions, pages, cookies or layout-profile commands, and paired devices cannot open or navigate them.
- An all-access control device can request a `camellia-api-routes` v2 export through `GET /v1/api-keys`; it contains plaintext provider keys. Android asks for confirmation before replacing its own encrypted provider configuration. The desktop configuration is not changed.
  Android and iOS local chat also import each model's `thinking.values` and `thinking.default`. Their menus use the reported values, including boolean switches and explicit empty lists; only missing or invalid metadata falls back to Low/Medium/High. Default omits thinking parameters. A selected level that is no longer supported falls back to Default after importing or switching models.
- Access is checked again for every request and event stream. Archiving leaves an already-open transcript readable with `permission: "read"` and an `archived` marker, so the phone shows a read-only archived state instead of treating it as deleted; every write command is still refused until it is restored. Moving a conversation out of an older restricted scope removes access, and revocation closes streams. Pairing is rate limited, and at most 16 event streams (four per device) are allowed.

## Diagnose a phone connection

On the desktop, open **Settings → Mobile access** and choose **Connection diagnostics** beside an authorized device. Keep the phone connected to this computer, with Camellia in the foreground, on the network you want to test. No Android update is required for desktop diagnostics.

The desktop embedded Tailscale node sends ten discovery probes, one second apart after each response (each probe has a three-second timeout). The table and copyable report show the actual probe path: direct UDP and its endpoint, the DERP region, a peer relay, an unknown path, or a timeout. The sequence preserves relay-to-direct transitions. These are computer-to-phone discovery timings, not mobile application request timings, throughput measurements or proof of long-term reliability. Probing can also help Tailscale establish a direct path.

The target is learned from an authenticated phone request through the embedded helper; the diagnostic command accepts an authorized device ID, not a caller-supplied address. If no phone connection has been observed since the gateway started, open this computer on the phone first. Closing the dialog or stopping the test prevents subsequent probes. The current in-flight probe may take up to three seconds to finish. Device revocation or a changed connection invalidates an in-flight result.

Clash `DIRECT` means a connection bypasses the upstream proxy; it does not establish UDP peer-to-peer connectivity. System `tailscale status` or `tailscale ping` also describes a separate node, not Camellia's embedded node. Updating from a helper without diagnostics activates the replacement in place and briefly reconnects mobile access; the desktop application does not restart.

## Protocol v1

The desktop displays the Tailscale root address, for example `http://100.80.1.2:43127`, or the LAN address, for example `https://192.168.1.8:49231`. JSON writes require `Content-Type: application/json`. All requests except the two one-time Tailscale pairing endpoints and `POST /v1/lan/join` require `Authorization: Bearer <token>`. The LAN join endpoint is reachable only on the private listener, requires the six-digit PIN, is rate limited, and returns the same device credential and scope as an approved Tailscale pairing.

Live subscriptions are tracked internally by authenticated device ID and peer IP, independently for each phone or tablet. The gateway pushes authorized conversation changes over the existing event streams. List notifications include the current first page so Home and the chat sidebar can update without another request; clients with a longer visible range or a search still fetch that range. Closing the last subscription removes the device from the live registry. Socket errors and stalled writes also remove subscriptions, and reconnecting starts with the current snapshot. Pairing credentials remain saved while offline. This bookkeeping has no additional settings or user-facing notifications.

Every event subscription begins with a current snapshot, so clients can use it directly instead of downloading the same history with a separate GET. Android reuses capability metadata only for the same computer address and token, and still takes permission from the fresh conversation snapshot. Long-lived chat/list streams have their own executor, leaving the read workers available for history and other requests. A cold connection still discovers capabilities; a rejected cached incremental format falls back once to the legacy stream.

A host advertising `live-deltas` accepts `?incremental=1&delta=live-v1` on conversation event streams. Every connection starts with a complete snapshot. Later frames can omit unchanged top-level fields and carry `textDelta`, `textBaseLength` and `baseEventSeq` for an append to the current run. Clients retain the last complete snapshot and its unchanged process and metadata. A replacement, new run, instance change or mismatched base requires a complete live value or a fresh connection, never a blind concatenation. Clients that do not negotiate this option retain the original complete snapshot format.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/hello` | Minimal unauthenticated descriptor for Tailnet discovery; bound to the embedded helper transport. |
| POST | `/v1/pair/request` | Submit `{ "code": "one-time code", "name": "My Android" }`; receive an application ID and claim credential. |
| POST | `/v1/pair/claim` | Poll with `{ "id": "application ID", "claim": "claim credential" }` at least five seconds apart; receive a token only after desktop approval. |
| POST | `/v1/tailnet/request` | Submit `{ "name": "My Android" }` over the embedded Tailnet transport; receive an id, claim and pending or approved state. |
| POST | `/v1/tailnet/claim` | Poll with `{ "id": "...", "claim": "..." }`; the claim is bound to the same Tailscale node that requested access. |
| POST | `/v1/device/name` | Change this device's own reported name; the bearer credential selects the record. |
| GET | `/v1/status` | Protocol, capabilities, permission, gateway `instanceId`, cursor, and supported settings. |
| GET | `/v1/conversations?offset=0` | Up to 100 authorized conversations per page, plus `nextOffset`. |
| GET | `/v1/conversations/{id}` | Recent history, live state, approvals, queue state, and pagination cursor. |
| GET | `/v1/conversations/{id}?before={seq}` | Older history page. |
| GET | `/v1/conversations/{id}/attachments/{seq}/{index}` | Bytes for an attachment the phone sent on that message, scoped to the gateway's mobile-upload folders. |
| GET | `/v1/conversations/{id}/events` | Server-sent snapshot when the conversation changes. |
| GET | `/v1/conversations/events` | Server-sent list snapshots with `listVersion`, `instanceId`, cursor, and a current first page in `conversationList`. |
| GET | `/v1/workbench` | All authorized active conversations plus the ten most recent idle conversations, sorted by activity time. Lightweight summaries omit transcripts, files and task commands. |
| GET | `/v1/workbench/events` | Server-sent home snapshots in `workbench`, with a content-derived `listVersion`. Advertised as `workbench-summary`. |
| GET | `/v1/api-keys` | Plaintext API-route export; requires all-access control permission and the `api-keys` capability. |
| GET | `/v1/account-usage` | Sanitized subscription quotas, API balances and local usage aggregates; requires all-access control and the `account-usage` capability. |
| POST | `/v1/account-usage/refresh` | Submit `{}` to start a coalesced account refresh; returns immediately with the current snapshot. |

User rows may include `attachedFiles` with each file's display name, image flag and, for newly uploaded files, byte size. The attachment endpoint resolves the named message and index again, serves only files this gateway stored under its `device-attachments` or `mobile-images` folders, and never exposes a phone or desktop filesystem path. Desktop-local files that appear in the same history row remain name-only on the phone.

`POST /v1/conversations/{id}/commands` accepts an idempotent `requestId`, the current `instanceId`, and an `action`. Supported actions include `send`, `find`, `stop`, `approve`, `configure`, `compact`, queue control, Goal control, and scheduled-task control when advertised in `capabilities`. `send` accepts `prompt`, `expectedSeq`, and optional `queue: true`; a queue holds at most 50 messages per conversation and 200 overall. `/find …` text is answered on the desktop without starting an engine; a newer client can use the dedicated `find` action. An approval is bound to `runId`, `approvalId`, and a content fingerprint, and only grants or denies one request. `stop` must match the current `runId`.

Android's Work status sheet previews pending questions and opens the same answer form as the conversation's Answer questions button. Single-choice, multiple-choice and typed answers return to the original native request; Later leaves it pending and Skip questions sends no selected answer. Empty native input (`{}`) is hidden. The sheet refreshes when requests or control permissions change, and submissions recheck the conversation, server instance, run and fingerprint. Requests without `responseSupported` remain desktop-only. iOS ordinary-conversation question forms remain a separate parity gap.

Desktop composer messages and paired-device messages share one computer-owned queue ordered by host acceptance time. Both desktop and phone show the merged order with each entry's original `desktop` or `mobile` source. Either device can edit, remove, or send an entry into the current task. In-place edits retain the original source, device authorization, queue position, and prepared attachments; a stale edit cannot overwrite a newer one. Phone snapshots and command receipts carry attachment names and image flags without computer filesystem paths. Queue removals, pauses, and resumes keep the same order for the remaining entries.

The `next-turn-settings` capability allows a model, thinking-level, or supported Codex Fast change during a run for the next turn. Connection and permission changes still require an idle conversation. Models are distinguished by both model ID and connection, since a subscription and an API route may expose the same ID. The snapshot may carry context and compaction progress; Android displays compaction in the message stream rather than a permanent token counter.

Queued messages offer **Send now** during an active Goal, including the wait between rounds and completion verification. A snapshot's `queueSteering.goalId` binds `queue-steer` to that goal, so a round finishing during a phone request does not leave the instruction targeting an expired run. An instruction between rounds starts the selected message as the next Goal round and cancels the earlier completion verification. Other queued messages retain their order. Older hosts continue to use `runId` for current-reply instructions.

Command results are persisted by request ID. A retry must use the **same** ID and parameters; `pending` means the action is still being prepared, while `unknown` or `interrupted` after a crash must be reconciled before the user chooses another action. HTTP 200 alone does not mean an engine turn completed. A reconnect replaces the current snapshot instead of appending it. `instanceId` changes when the gateway restarts, so old cursors and unconfirmed controls must not be treated as current. The client does not automatically resend a timed-out send, stop, or approval.

### Account quota and usage

Android and iOS expose **Settings → Quota & usage**, with a shortcut in each paired computer's management menu. Choose a computer, then **Quota & balances** or **Usage history**. History supports today, the last 7/30 days, this calendar month (from the first day through today) and lifetime totals, filtered by subscription/API, account/key and model. Periods follow the computer's local calendar. Removed-key records and legacy counters remain available in lifetime totals; missing tokens are identified rather than filled with estimates.

The desktop advertises `account-usage` only to all-access control devices. The version-1 snapshot explicitly projects account labels, reported balances and quota windows, reading timestamps, and period/model counters. The `month` range is optional so newer clients still accept snapshots from hosts that predate it and hide the option. The snapshot omits raw keys, endpoints, native account payloads, upstream error strings and quota histories. A refresh submits `{}`, coalesces concurrent requests and starts at most once per minute. Clients read the current result without waiting for provider checks and poll for at most one minute while the page is visible. Opening a page reads existing data; it does not start provider queries.

Clients probe `/v1/status` before the first read and on a manual refresh. Without `account-usage`, they use GET rather than POST so an older host's generic `405 Remote access is read-only` response is not mistaken for a permission denial. Missing endpoints (404/405) show an update/restart instruction, while 401 requires pairing again and 403 requires full-device control. Diagnostic details are collapsed. The compact computer row contains source, sync time and refresh; history keeps type/account/model filters collapsed until opened, showing the active filter count.

Snapshots are encrypted on the phone and bound to the computer and pairing credential. Connection failures retain the last snapshot and its timestamp. HTTP 401/403 clears it, rotated credentials cannot reuse it, and forgetting a computer removes its cache. Account quotas may be shared across devices; usage statistics cover only calls recorded by the selected computer. Balances are never summed across keys or currencies. Subscription cost is an API-equivalent estimate, not an actual charge.

### Codex reset credits

On Android and iOS, open the model picker in a remote Codex subscription conversation and select **Reset Codex usage**. A capable host advertises `codex-reset-credits` only to devices with full-device control. The preview shows the conversation's desktop account, available card count, and earliest reported expiry. Canceling or viewing it does not consume a credit. **Confirm and use one credit** consumes one official reset credit on that account; it does not send a message or change the preferred account. After a successful reset, send the message again.

The conversation command actions are `codex-reset-preview` and `codex-reset-consume`. The second echoes the preview's `accountId` and `confirmationToken` with `confirmed: true`. Both use the ordinary command receipts. The desktop checks the account and device permission again before consuming. Missing credit information and zero available credits offer no new consumption. An uncertain reset can still be retried when no cards remain: reopening the preview restores the original provider idempotency key, including after a desktop restart. Its confirmation says **Retry this reset request**. Older hosts and API conversations do not offer the entry.

Conversation and discussion artifact lists merge references to the same canonical
file before pagination, then sort by file modification time, newest first. Files
with the same modification time use the most recent message reference first.
Refreshing the list after an existing file changes updates its position.

### Android conversation history

An ordinary conversation page holds at most 200 history records, including tool
records, and about 1 MiB of text and serialized process detail. Long records can
reduce the page count. Tool records contribute to reply process panels rather
than separate chat bubbles, so 200 records do not imply 200 visible messages.

Starting with Android build 131, the latest page appears first, followed by
automatic history loading. The first extra page admits at most eight visible
messages. Actual end-to-end history request times then determine the
target: up to 30 visible messages when every page takes at most 800 ms, or 12
when pages take at most two seconds. A slower page stops further automatic
requests. Tool-only pages do not satisfy the visible-message target. This uses
the paired computer's real request path, including a direct Tailscale tunnel,
rather than assuming that Wi-Fi or a VPN implies a fast connection.

The automatic walk stops after eight requests, six seconds of completed request
time, the start of history, a failure, or the display budget below. One in-flight
request can outlast that time budget. It preserves the latest reply and the
reader's scroll anchor, stays quiet on transient failures, and does not resume
after a manual earlier-message request. **Load earlier messages** and pull to
refresh remain available for older history. Late pages from another connection,
computer, conversation or history version cannot replace the current view.

Android retains at most 600 records and 4 MiB of estimated text/process weight.
This is a sliding display window, not an end to accessible history. Loading older
pages releases records from the newer end when necessary, keeping the requested
older records and their next cursor. Latest-page snapshots keep updating live
controls without replacing a detached older window. The composer has no
**Back to latest messages** action. Reopening the conversation loads its current
latest page; incoming snapshots do not interrupt deliberate history reading.

A tool-only or already-cached page continues toward a new chat message, the end
of history, a bounded batch, or eight requests per click. A partial batch resumes
at its earliest retained record, including on a terminal server page, so unread
records are not skipped. Invalid or non-advancing cursors fail with retry
available. The result reports the actual number of newly retained chat messages
or process records. Prepending preserves the current reading position when its
anchor remains in the window; scroll up to see the new content. Discussion
groups use a separate limit of 80 messages per server page and a separate
retention policy.

### Forks and subtasks

The `fork` capability allows `action: "fork"` with `expectedSeq`. During a running or recovering turn, a snapshot from the current turn remains valid as tool rows arrive, and the fork excludes that entire turn. An idle fork requires the exact stored sequence. The response identifies the new conversation; the source keeps running.

Gateways advertising `subagents` include a bounded `subagents` array in conversation snapshots, even when an unchanged `historyVersion` lets them omit `messages`. A task carries its engine, task ID, initiating `userSeq`, actual status and `turnId`, goal/progress/result, recent history, pending approval count and supported actions. Large details are shortened with `detailsTruncated`; task identities and attention counts remain available. Read-only devices receive status and attention counts without actionable approvals or controls. A tool-created child's workspace must also be authorized to expose its details, artifacts or commands.

`action: "subagent-command"` carries `taskId`, `engine`, `operation` (`reply`, `stop`, or `approve`) and `expectedTurnId`. A reply also carries `prompt`; an approval carries `approvalId`, the original request `fingerprint`, `allow` and, when required, `input` or `optionId`. The server checks the child again before dispatch and routes the response to that child's original engine request. Parent approvals and parent input are separate. Controls are hidden when the engine or child no longer supports them. Native Claude tasks expose approval and stop; direct replies are unavailable in its current stdio protocol.

Android and iOS use a turn card and a separate child page, with no desktop floating panel. Returning keeps the parent transcript, draft and reading position. See [Conversation work panel](conversation-work-panel.md) for display behavior and validation limits.

### Agent discussions (beta)

A Windows or macOS desktop that advertises `discussions` and `discussion-rich` exposes discussion groups to an all-access control device. The ordinary conversation list may include `discussionGroups`, `discussionsNextOffset`, and `discussionVersion`; older capable gateways provide `/v1/discussions`. Restricted devices do not gain discussion access from this capability.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/discussions?offset=N` | Up to 100 groups per page. |
| GET | `/v1/discussions/catalog` | Opaque member binding IDs for configured harnesses and models; no keys or native paths. |
| GET | `/v1/discussions/{id}?before=SEQ` | Message page (at most 80 messages) and member state. |
| GET | `/v1/discussions/{id}/events` | Group snapshot stream. |
| POST | `/v1/discussions/commands` | Create, rename, pin, delete, add or edit members, verify, send, stop, retry, and respond to approvals. |
| GET | `/v1/discussions/commands/{requestId}` | Persistent receipt for the same device and request. |
| GET | `/v1/discussions/{id}/artifacts` | Referenced uploads and generated files; artifact IDs are opaque. |

Groups have at most four members. Discussion sends can target selected participants in parallel or serial order. A send commits the public message before any first-use connection check; ready members start immediately, while unverified members wait in their own queued delivery until the background check succeeds. The richer attachment capability accepts up to 16 files: JPEG images up to 4 MiB each, documents up to 10 MiB each, 32 MiB decoded total, and a 48 MiB JSON request limit. The client sends Base64 bytes, never a phone or desktop filesystem path. Approval responses match the original delivery, run, approval ID, and fingerprint; secret answers are not persisted in the receipt log. Older clients and hosts ignore unsupported capabilities.

## Build and verify

Building the desktop Tailnet helper from source requires Go 1.27.4 or a Go installation able to fetch that toolchain:

```sh
npm run build:tailnet
npm run build:remote-guard
```

Packaged Windows x64 and macOS arm64 builds include both native helpers and their notices. To make an embedded Tailscale update available, attach the matching `.bin` and `.txt` files from `dist/tailnet-updates/` in the accepted desktop artifacts to the same stable GitHub release.

Local checks include both the updater and the helper:

```sh
node --test tests/embedded-network.test.js tests/remote-desktop.test.js tests/remote-access.test.js tests/tailnet-updates.test.js
node --test tests/remote-guard.test.js
node tests/remote-guard-process.cjs
node tests/embedded-network-electron.cjs
node tests/tailnet-update-restart-electron.cjs
node tests/electron-smoke.cjs
```

`go test ./...` runs from both `integrations/tailnet` and `integrations/remote-guard`. The process smoke test builds nothing on its own, so run `npm run build:remote-guard` first. The Android pairing, gateway, and discussion smoke scripts require a built APK and an explicitly selected disposable rooted emulator (`ADB` and `ANDROID_SERIAL`). Those loopback fixtures check protocol and UI behavior, but physical-device Tailnet connectivity, Wi-Fi/cellular handoff, sleep recovery, and iOS behavior still require separate acceptance.
