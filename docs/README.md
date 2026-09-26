# Documentation

The [English README](../README.md) and [简体中文 README](../README.zh-CN.md) introduce Camellia and explain how to get started.

Release notes: [v0.1.0 — Windows preview](releases/v0.1.0.md).

## Guides

| Document | Contents | Language |
| --- | --- | --- |
| [Configuration](configuration.md) | Providers, routing, native settings, usage, and local data | English |
| [Development](development.md) | Code layout, runtime preparation, testing, and packaging | English |
| [Mobile access preview](remote-access.md) | Tailscale-only read gateway, device pairing, scope and reconnect protocol | 简体中文 |
| [Linux server development preview](linux-server-preview.md) | Headless foreground service, local control, pairing and current implementation limits | 简体中文 |
| [Linux server acceptance record](linux-server-acceptance.md) | Built x64 artifact, actual native-engine checks and remaining user-assisted acceptance | English |
| [Android client](../android/README.md) | APK installation, native client, secure credentials, build and tests | 简体中文 |
| [Troubleshooting: runtimes](troubleshooting-runtimes.md) | Engines disappearing or failing to start; antivirus exclusions for the runtimes folder | English |
| [WBL API usage](wbl-api.md) | Direct curl requests, tested Responses behavior, and proxy troubleshooting | 简体中文 |

## Implementation references

| Document | Contents | Language |
| --- | --- | --- |
| [Unified settings and runtimes](design/unified-settings.md) | Configuration files, synchronization, backups, and runtime delivery | 简体中文 |
| [Linux server CLI proposal](design/linux-server-cli.md) | Headless architecture, GUI device flows, credential boundaries, and runnable settings design preview (not a server release) | 简体中文 |
| [Provider account adapters](design/provider-balances.md) | Account APIs, units, verification scope, and adapter maintenance | 简体中文 |
| [Harness integration](design/harness-integration.md) | Integration decisions and earlier engine evaluation | 简体中文 |
| [DSH integration](../integrations/dsh/README.md) | Maintained source patches and pinned upstream packages | English |
| [Kimi runtime](../runtimes/kimi/README.md) | Runtime package, execution directories, and ACP integration | English |

Implementation notes include dated research. Use the guides and current code for supported behavior; verify upstream interfaces again before extending an adapter.

## Archive and images

[Archived documents](archive/README.md) preserve earlier reviews and design work. They are not current installation or configuration instructions.

`images/` contains README screenshots. Account and usage examples use demonstration data. Local reference captures are kept in the ignored `images/local/` directory.
