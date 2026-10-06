# Troubleshooting: runtimes disappear or engines fail to start

[Back to Camellia](../README.md) · [Documentation index](README.md)

## Symptoms

- A benchmark run reports `runtime is not installed or is incomplete` for an engine that used to work.
- The engine stops opening sessions, and `npm start` prints `runtime incomplete — reinstall with: npm run setup:runtimes -- <engine>`.
- The engine's directory under `runtimes/` exists but its package folder is empty.
- A run fails with `Cannot find package '…/@deepseek-ai/dsh-app-boot/index.js'` while the engine's own entry file is still there — the entry survived but its companion packages are empty shells.

## Why this happens

Camellia downloads each engine from its official npm package into `runtimes/<engine>/`. Those files are plain JavaScript, which **cannot carry an Authenticode signature** — the only "publisher proof" Windows security software trusts is a signed `.exe`/`.dll`.

The engines differ in how much of their logic is a signed binary:

| Engine | Distribution | What antivirus sees |
|---|---|---|
| Claude Code / Codex CLI | Official JS package + a **signed** binary (e.g. `codex.exe` signed by OpenAI OpCo) | A signed executable — usually trusted outright |
| Kimi Code | Official JS package | One unsigned JS package |
| Antigravity | Official Python SDK | Python packages |
| DSH | Official JS package, ~240 plugin sub-packages (`@deepseek-ai/dsh-*`), including modules that **create processes and adjust Windows ACLs** to build its sandbox | An unsigned script collection performing sensitive operations — the highest-risk profile |

DSH's design (a microkernel with hundreds of small plugin packages, plus sandbox modules that touch process creation and ACLs) is legitimate engineering, but it is exactly the shape that behavioural security software flags first — especially when a benchmark launches six CLI processes at once with full permissions.

The empty folders come from how engines are installed. Camellia runs `npm ci`, which **deletes `node_modules` before it installs**. If that command is killed part-way — by security software, a cancelled download, or quitting the app — the engine is left as a directory shell whose packages are all empty. An entry file on its own is not a working runtime, so Camellia now also requires a companion plugin (for DSH, `@deepseek-ai/dsh-app-boot`) before it reports an engine as installed.

## Fix

For a CLI installed outside Camellia, open **Settings → Engine Settings** and click **Use Camellia** next to the original-installer update hint. The in-app confirmation uses the settings theme and shows the current CLI and the managed destination. Camellia prepares its pinned official runtime and verifies its version, uninstalls the original npm package (including npx installations) or standalone native executable, and clears the custom path. Shared npm packages, conversations and account settings are kept. Future version checks and updates use the managed installation; the Antigravity subscription CLI continues to update with Camellia releases. Cancelling makes no changes, and download or verification failures leave the original CLI available.

Managed installations take priority over the bundled runtime after migration. JavaScript files whose npm installation cannot be identified are left intact; select the installed package entry to migrate them.

Camellia builds each runtime in a staging directory and swaps it in only after the install finishes, so an interrupted install no longer empties a runtime that was already working. It reinstalls a missing runtime automatically the next time you start it (`npm start` runs a pre-start check). To reinstall by hand:

```bash
npm run setup:runtimes -- dsh
```

## Prevent it from happening again

Add the runtimes directory to your security software's exclusion list so it stops scanning them.

### Windows Security (Defender)

1. Open **Settings → Privacy & security → Windows Security → Virus & threat protection**.
2. Under **Virus & threat protection settings**, click **Manage settings**.
3. Scroll to **Exclusions** and click **Add or remove exclusions**.
4. Choose **Add an exclusion → Folder** and select the `runtimes` folder of your Camellia checkout (e.g. `D:\Code\DSH\runtimes`).

Or, from an **administrator** PowerShell:

```powershell
Add-MpPreference -ExclusionPath "D:\Code\DSH\runtimes"
```

Adjust the path to your checkout.

### Other antivirus or cleaner tools

Tools like 360 or system "cleaner" utilities have their own exclusion/whitelist panels — add the same `runtimes` folder there. If detections keep happening, check the tool's quarantine/protection history for entries mentioning `@deepseek-ai` or the `runtimes` path and restore from there.

### Reinstalling from a terminal

Some security software runs in the kernel as a file-system filter driver, so it can interrupt an install without leaving any entry in Windows Security, Windows Defender history or the quarantine list — the panels show nothing even when it is involved. When the in-app Download button keeps failing, reinstall from a terminal instead: the command reports its own errors, so a killed install is visible and can simply be repeated.

```bash
npm run setup:runtimes -- dsh
```

## Verifying

After reinstalling or excluding, confirm the runtime is intact:

```bash
node scripts/prepare-runtimes.cjs --check
```

Every engine should print `ready`. If an engine prints `runtime incomplete`, reinstall it with the command above.
