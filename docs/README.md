# Documentation

The [English README](../README.md) and [简体中文 README](../README.zh-CN.md) introduce Camellia and explain how to get started.

Release notes: [v0.1.0 — Windows preview](releases/v0.1.0.md).

## Guides

| Document | Contents | Language |
| --- | --- | --- |
| [Configuration](configuration.md) | Providers, routing, native settings, usage, and local data | English |
| [Development](development.md) | Code layout, runtime preparation, testing, and packaging | English |
| [Troubleshooting: runtimes](troubleshooting-runtimes.md) | Engines disappearing or failing to start; antivirus exclusions for the runtimes folder | English |

## Implementation references

| Document | Contents | Language |
| --- | --- | --- |
| [Unified settings and runtimes](design/unified-settings.md) | Configuration files, synchronization, backups, and runtime delivery | 简体中文 |
| [Provider account adapters](design/provider-balances.md) | Account APIs, units, verification scope, and adapter maintenance | 简体中文 |
| [Harness integration](design/harness-integration.md) | Integration decisions and earlier engine evaluation | 简体中文 |
| [DSH integration](../integrations/dsh/README.md) | Maintained source patches and pinned upstream packages | English |
| [Kimi runtime](../runtimes/kimi/README.md) | Runtime package, execution directories, and ACP integration | English |

Implementation notes include dated research. Use the guides and current code for supported behavior; verify upstream interfaces again before extending an adapter.

## Archive and images

[Archived documents](archive/README.md) preserve earlier reviews and design work. They are not current installation or configuration instructions.

`images/` contains README screenshots. Account and usage examples use demonstration data. Local reference captures are kept in the ignored `images/local/` directory.
