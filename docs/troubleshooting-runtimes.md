# Troubleshooting: runtimes disappear or engines fail to start

[Back to Camellia](../README.md) · [Documentation index](README.md)

## Symptoms

- A benchmark run reports `runtime is not installed or is incomplete` for an engine that used to work.
- The engine stops opening sessions, and `npm start` prints `runtime incomplete — reinstall with: npm run setup:runtimes -- <engine>`.
- The engine's directory under `runtimes/` exists but its package folder is empty.

## Why this happens

Camellia downloads each engine from its official npm package into `runtimes/<engine>/`. Those files are plain JavaScript, which **cannot carry an Authenticode signature** — the only "publisher proof" Windows security software trusts is a signed `.exe`/`.dll`.

The engines differ in how much of their logic is a signed binary:

| Engine | Distribution | What antivirus sees |
|---|---|---|
| Claude Code / Codex CLI | Official JS package + a **signed** binary (e.g. `codex.exe` signed by OpenAI OpCo) | A signed executable — usually trusted outright |
| Kimi Code | Official JS package | One unsigned JS package |
| Antigravity | Official Python SDK | Python packages |
| DSH | Official JS package, ~240 plugin sub-packages (`@deepseek-ai/dsh-*`), including modules that **create processes and adjust Windows ACLs** to build its sandbox | An unsigned script collection performing sensitive operations — the highest-risk profile |

DSH's design (a microkernel with hundreds of small plugin packages, plus sandbox modules that touch process creation and ACLs) is legitimate engineering, but it is exactly the shape that behavioral antivirus and "cleaner" tools flag first — especially when a benchmark launches five CLI processes at once with full permissions. A cleanup pass then empties the package folders, and the next run fails.

## Fix

Camellia reinstalls a missing runtime automatically the next time you start it (`npm start` runs a pre-start check). To reinstall by hand:

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

## Verifying

After reinstalling or excluding, confirm the runtime is intact:

```bash
node scripts/prepare-runtimes.cjs --check
```

Every engine should print `ready`. If an engine prints `runtime incomplete`, reinstall it with the command above.
