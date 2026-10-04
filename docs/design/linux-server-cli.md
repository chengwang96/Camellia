# Linux server CLI design record

This started as a terminal UI proposal. A live numeric `camellia-server.cjs menu`, a one-terminal `launch` flow, a paired desktop workbench, and a Linux package now exist; the older full-screen keyboard layout was only a prototype. Use the [Linux server development guide](../linux-server-preview.md) for runnable instructions and acceptance limits.

## Product boundaries

The Electron desktop and headless Linux process are two hosts of Camellia, not one shared local data store. Each server owns its workspaces, conversations, engines, API configuration, subscription logins, and usage. A desktop can pair several servers, but it keys remote data by device plus remote ID and never writes a remote conversation into its local repository. Both Tailnet access policy and Camellia's explicit device approval apply. Removing a server from a desktop clears that desktop's credential; revoking its authorization is a separate server-side action.

The server runs without X11/Wayland. In a trusted terminal, `launch` shows network login and a one-time pairing code; approval requires an explicit local `YES`. A disconnected desktop shows cached read state and disables writes rather than queueing them offline. Server paths remain server paths: they are not passed to the desktop's local `openPath`, and remote artifacts download through authorized artifact endpoints. Removing a workspace record does not recursively delete its files or silently change an existing conversation's working directory.

## Terminal and settings direction

The live `menu` uses Camellia's name, a text cat, numeric choices, English/Chinese localization, `NO_COLOR`, and an ASCII fallback. It reads real state through the local socket and asks for confirmation before sensitive changes. The older visual prototype remains available with `npm run preview:cli`; it uses demonstration data, does not contact a network, and never changes settings. A future full-screen terminal UI would need resize handling, narrow-screen fallback, accessible status text, and separate states for network login, pairing, and live control.

The intended server settings mirror desktop concepts where practical: providers and keys, usage, general preferences, engines and runtimes, workspaces, archive/cleanup, network/devices, service lifecycle, and diagnostics. The first live menu implements a useful subset rather than reproducing the desktop chat interface. The independent desktop server window carries chat, files, and session management.

## API import decision

Desktop-to-server API import is explicit, previewed, and limited to an all-access device. The current conservative merge adds providers absent on the server and retains server-side providers on conflict; the earlier proposal for per-item overwrite choices is not implemented. The preview shows source/target and counts without displaying key values. Subscription tokens, cookies, native account directories, local-only endpoints, usage, conversations, listener port, and device authorization are excluded. The main process handles keys; the renderer receives only counts and receipts. A stable request ID prevents duplicate application, and a failed reload attempts to restore the prior configuration.

Do not treat `GET /v1/api-keys` (a read/export endpoint for authorized phone migration) as an upload API. Server import has its own capability and endpoint. Subscription sign-in always occurs on the server through its native CLI flow.
