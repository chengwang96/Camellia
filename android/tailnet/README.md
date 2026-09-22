# Embedded Tailnet bridge

Pins Tailscale `v1.98.6`, Go `1.26.3` and gomobile `v0.0.0-20260908204917-8b95e45f8d3e`. No patches to upstream source. `build-tailnet.ps1` produces ARM64 + x86_64 JNI AAR, then regenerates bundled third-party notices from the verified module cache. Go sum verification remains enabled.

`Storage` delegates state reads/writes to Java Keystore-encrypted preferences. Missing state and unreadable state are distinct: decryption failure is fatal, not a silent new identity. tsnet uses an app-private no-backup directory for auxiliary files. Log uploads are disabled. Authentication URLs are opened only by an explicit login action, in the system browser, and restricted to HTTPS `login.tailscale.com`; no auth key is bundled. Users authorize their own nodes.

Android 11+ denies Go netlink interface discovery. `SetInterfaces` registers Java NetworkInterface enumeration through Tailscale's supported netmon hook; no root or VPN service is required. The userspace node uses OS connectivity, including Tailscale's polling network monitor, and is restarted after extended backgrounding. Wi-Fi/cellular handoff still requires real-device validation.

The bridge validates Tailnet destination addresses and ports, disallows redirects, streams bytes across JNI, and cancels open requests when the node closes. Native response bodies are never routed through a localhost HTTP proxy. Java separately enforces the gateway endpoint allowlist, body limits, request deduplication and remote permission checks.

Tests: `go test ./...`; Android `EmbeddedNetworkTest` for native startup, Android interface enumeration, encrypted storage and login URL validation. Its optional `onlineLogin=true` test contacts the official control service only to obtain a browser authorization URL; it does not authorize a node or access user conversations. Actual authenticated Tailnet dialing and phone/desktop interoperability need the user's login and device test.
