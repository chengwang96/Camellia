# Antigravity runtime

Camellia provides two optional Antigravity connections through its ACP interface:

- **Google subscription:** the official CLI manages Google sign-in, tools and
  native conversation state. Chat uses the CLI's authenticated local interactive
  transport; restricted connection checks use its `stream-json` mode.
  `npm run setup:antigravity:subscription` downloads only the CLI.
- **Shared API routes:** the official `google-antigravity` Python SDK uses
  Camellia's router and permission prompts. `npm run setup:antigravity` downloads
  the SDK and its dedicated Python interpreter.

Desktop builds include only download manifests. Opening Antigravity prepares the
selected connection on demand, without requiring a global CLI or Python install.
The download prompt uses the device's saved connection preferences.

- SDK: `google-antigravity==0.1.20`; dependencies pinned in `requirements.lock`.
- CLI: the initial 1.3.5 download URLs and SHA-512 checksums are pinned in
  `runtime.json`. **Check for updates** queries Google's platform release manifest;
  **Update** verifies the checksum, version and transport before replacing the
  executable, retaining the previous version for recovery. Unattended native
  self-updates remain disabled so a running conversation cannot change runtimes.
- Interpreter and installer: pinned in `runtime.json`. The uv wheel is fetched
  from PyPI and checked against its SHA-256 before extraction.
- Platforms in the pinned manifest: Windows x64, macOS ARM64, Linux x64, and Linux ARM64.
- Python packages are stored separately from the interpreter for relocation.
- The application installs no global Python packages and changes no shell PATH.
- SDK configuration is stored in Camellia's own data directory. Google mode uses
  the official CLI's global settings and credential store. Camellia edits its
  settings from the unified settings page, retaining a backup on first overwrite.

Google sign-in is completed in the official CLI terminal. Run **Refresh account**
after login to fetch account models. CLI credentials are never exposed to other
harnesses or converted to API keys. See the [CLI repository](https://github.com/google-antigravity/antigravity-cli)
and [headless interface](https://antigravity.google/docs/cli/headless/).

The subscription cascade is a durable server-side conversation, so Camellia
resumes it after idle engine cleanup and does not apply the parked-session TTL
used for prompt caches. Re-sending an unchanged message continues that cascade
instead of rebuilding it. When a genuinely revised message needs a new cascade,
Camellia checks the final subscription text against a 172,800-byte UTF-8
budget, leaving 10% headroom below the CLI's 192,000-byte single-message limit.
The same budget covers skill expansion and Google subscription members in group
discussions. Inline images are sent as separate media in interactive chat.
The Antigravity API connection uses its own model and request budgets.

For a long replay, Camellia reserves room for the pending request before it
summarizes history. If the summary cannot fit, Camellia can continue with a
local Markdown handoff linked to the full transcript. A revision's handoff
contains the history preceding the edited message. Camellia saves oversized
new chat messages as UTF-8 text attachments and sends a short pointer.

If the local CLI connection drops during submission, Camellia checks the native
trajectory before deciding how to continue. A refused connection can be retried
before sending. A user step in the trajectory lets Camellia keep following
the same turn, and uncertain submissions remain visible in the conversation.

The SDK's Python sources are Apache-2.0 licensed; its compiled runtime is provided
by Google in the platform wheel. The original package licenses remain alongside
the installed SDK, Python and dependencies. See the [official SDK repository](https://github.com/google-antigravity/antigravity-sdk-python)
and [documentation](https://antigravity.google/docs/sdk/overview).
