# Antigravity runtime

Camellia provides two optional Antigravity connections through its ACP interface:

- **Google subscription:** the official CLI manages Google sign-in, tools and
  native conversation state. Camellia adapts its documented `stream-json` mode.
  `npm run setup:antigravity:subscription` downloads only the CLI.
- **Shared API routes:** the official `google-antigravity` Python SDK uses
  Camellia's router and permission prompts. `npm run setup:antigravity` downloads
  the SDK and its dedicated Python interpreter.

Desktop builds include only download manifests. Opening Antigravity prepares the
selected connection on demand, without requiring a global CLI or Python install.
The download prompt uses the device's saved connection preferences.

- SDK: `google-antigravity==0.1.17`; dependencies pinned in `requirements.lock`.
- CLI: version and official Windows/macOS download URLs pinned in `runtime.json`;
  the SHA-512 is verified before installation. Automatic CLI updates are disabled.
- Interpreter and installer: pinned in `runtime.json`. The uv wheel is fetched
  from PyPI and checked against its SHA-256 before extraction.
- Platforms: Windows x64 and macOS ARM64.
- Python packages are stored separately from the interpreter for relocation.
- The application installs no global Python packages and changes no shell PATH.
- SDK configuration is stored in Camellia's own data directory. Google mode uses
  the official CLI's global settings and credential store. Camellia edits its
  settings from the unified settings page, retaining a backup on first overwrite.

Google sign-in is completed in the official CLI terminal. Run **Refresh account**
after login to fetch account models. CLI credentials are never exposed to other
harnesses or converted to API keys. See the [CLI repository](https://github.com/google-antigravity/antigravity-cli)
and [headless interface](https://antigravity.google/docs/cli/headless/).

The SDK's Python sources are Apache-2.0 licensed; its compiled runtime is provided
by Google in the platform wheel. The original package licenses remain alongside
the installed SDK, Python and dependencies. See the [official SDK repository](https://github.com/google-antigravity/antigravity-sdk-python)
and [documentation](https://antigravity.google/docs/sdk/overview).
