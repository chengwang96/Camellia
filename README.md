<p align="center"><img src="assets/icon-256.png" width="88" height="88" alt="Camellia cat logo"></p>

<h1 align="center">Camellia</h1>

<p align="center">One workbench for coding agents, local and remote.</p>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

Camellia brings **Claude Code, Codex CLI, DeepSeek Harness, Kimi Code, Antigravity, and Pi** into a shared desktop workbench. Use a provider API key or a supported subscription, switch engines within a conversation, and keep settings, usage, and account visibility in one place. A paired Android client and a headless Linux server extend the same workflow beyond the desktop.

![Current Camellia home screen showing six engines and the discussion, benchmark, server, and settings entries](docs/images/home.png)

## What makes Camellia useful

- **Shared conversations.** Move between engines in one workspace and conversation. Choose a direct continuation or a Markdown handoff when context needs to cross engines. Native histories remain tied to their engines.
- **Agent discussions (beta).** Invite up to four configured agents, assign roles, and choose who replies. Discussion messages, member state, tool activity, and approvals stay together in the desktop or paired Android view.
- **One routing and account view.** Manage API providers, multiple keys, supported subscription sign-ins, same-model failover, usage, balances, and optional engine runtimes in the app.
- **Comparable benchmarks.** Run the same model through six harnesses against built-in, DS-1000, or SciCode tasks. Inspect checks, time, token usage, and saved reports.
- **Remote work.** Pair a headless Linux server as another workbench, or approve an Android device to read and control selected desktop conversations over the embedded Tailscale connection.
- **Long-running work.** Goals, scheduled checks, queued messages, and next-turn model changes help manage work that outlasts one reply.

![Illustrative shared conversation in the current desktop interface](docs/images/shared-conversation.png)

## Get started

Desktop builds target **Windows x64** and **macOS Apple Silicon**. To run from source, use Node.js **22.19+ in the 22.x series or 24+**, Git, and Git for Windows with Bash on Windows:

```sh
git clone https://github.com/chengwang96/Camellia.git
cd Camellia
npm ci
npm start
```

Choose an engine on the home screen and install it when prompted. Then configure an API provider under **Settings → Providers & Keys**, or connect a supported subscription in **Settings → Engine Settings**. Camellia downloads only the runtimes you choose. Connection validation sends a short model request and may incur provider usage.

For Android installation and desktop pairing, see the [Android guide](android/README.md) and [remote access guide](docs/remote-access.md). For a headless host, see the [Linux server guide](docs/linux-server-preview.md).

## Documentation

The [documentation index](docs/README.md) links configuration, development, remote access, benchmark notes, and design records. The guides outside these two READMEs are in English. Screenshots use local demonstration data and show the current interface; they do not show a live account or a benchmark result.
