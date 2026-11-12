# Portable skills and cross-engine review

Status: application-side gaps implemented; live host acceptance pending

Date: 2026-11-13

## Implemented milestones

- Canonical portable skill registry with built-in `review` and
  `adversarial-review` skills.
- Claude and Codex bundle export from one skill source.
- Portable `skill_catalog` / `skill_load` / `skill_resource` tool bridge.
- Cross-engine review jobs with captured target hash, read-only reviewer
  policy, structured report validation, status/result/cancel, and stale target
  detection.
- Header Review dialog, latest-review reopening, and Work-panel review history.
- Settings general-page export action for Claude/Codex review bundles.
- Per-conversation consent for agent-requested reviews, plus
  `camellia_review_start`, `camellia_review_status`, `camellia_review_result`
  and `camellia_review_cancel`.
- Idempotent `request_id` replay, per-conversation/global active-review caps,
  bounded timeouts, and restart recovery that marks interrupted reviews as
  failed rather than silently passing them.
- Optional Goal completion gate: a fresh passing review is required before the
  agent can report `status: "complete"`. A stale, failed, cancelled, interrupted
  or missing report cannot pass.
- Review settings in the Review dialog for agent-requested reviews and the Goal
  gate. The reviewer and mode selected there become the conversation defaults.
- Review jobs now run in disposable workspace snapshots. The snapshot contains
  the current tracked and untracked worktree, rejects symlinks, is size bounded,
  and is deleted when the review settles or Camellia restarts.
- Reviewer children expose only `camellia_review_report` through the Camellia
  bridge, force native web tools off, and cannot call tasks, conversations,
  memory writes, web tools, or nested delegation.
- Per-conversation and global review defaults cover reviewer engine, mode,
  token budget, agent consent, same-engine warning, Goal gate, and completed
  turn review.
- Agent-requested reviews use an in-conversation consent card. No reviewer
  quota is spent before approval.
- Goal completion is gated for both agent completion claims and the manual Goal
  action. Each Goal has one initial review and one re-review; further attempts
  require a user override. Ordinary turns can optionally pause the next message
  until their automatic review settles.
- Review reports validate target paths and line bounds. Token budget overruns,
  stale targets, failures, cancellations, and interrupted jobs cannot pass.
- Portable skills have registry state, preview, app/custom installation,
  backup, update, hash verification, uninstall, recovery copies, and
  diagnostics. Settings exposes only one shared-skills switch so every harness
  uses the same bridge; host bundle management remains an internal command
  surface. Claude uses native `--plugin-dir`; Codex uses a Camellia-owned local
  marketplace and `codex plugin`; Antigravity API uses `skillsPaths`.
- Review lifecycle events appear in Context Inspector, and the Work panel shows
  findings, errors, and an action that reopens the review sheet.
- The header Review action and `Ctrl/Cmd+Shift+R` are the entry points. The
  composer Review chip is intentionally omitted to keep the editor uncluttered.
- The Review sheet keeps only reviewer engine, reviewer model and review mode
  visible by default; comparison, token budget, focus, same-engine warning and
  gate policies live under Advanced options.
- `camellia_review_start` is available to the parent agent from the first turn.
  The tool description and prompt explicitly direct the agent to use it when the
  user asks another model or engine to review, audit or challenge the change.

Remaining external work: paid live acceptance on real reviewer engines and
accounts, host-specific verification for Kimi/Grok/DSH native skill formats
(they intentionally use the portable bridge until a stable format is
confirmed), and platform packaging checks. Token budgets are now enforced both
from live usage events and again before a report can pass.

Scope: desktop skills management, shared conversation tools, child
conversations, and review workflows.

## Decision

Build two related layers:

1. **A portable skill registry with host adapters.** One canonical skill
   package is the source of truth. Native hosts receive generated
   host-specific files where the host supports skills or plugins. Hosts
   without a reliable native skill surface receive a Camellia tool bridge that
   exposes a compact catalog and loads the full skill on demand.
2. **A cross-engine review job.** A parent conversation starts a read-only
   child conversation in another engine, sends a bounded review packet, and
   receives a structured report. The reviewer never edits the workspace, and
   the parent/user owns any apply or commit action.

These are separate features with one shared primitive: a skill package can
define the review workflow, and the same package can be delivered to the
reviewer engine through either a native adapter or the Camellia bridge.

## Why this shape

The reference projects converge on the same separation:

- Superpowers keeps one `skills/` source and adds host manifests such as
  `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`. Codex declares
  `"skills": "./skills/"`; Claude uses its own marketplace metadata.
- Compound Engineering packages a skill catalog once and supports many agent
  hosts, while host-specific invocation syntax remains explicit (`/skill`,
  `$skill`, `/skill:<name>`).
- `openai/codex-plugin-cc` keeps normal review and adversarial review
  read-only, runs long jobs in the background, and exposes status/result/cancel
  instead of making a review a synchronous chat-only action.
- The host, not the reviewer, owns verification, apply, and commit. That is the
  important boundary to preserve.

Camellia already has the necessary execution pieces:

- `SharedConversations` can create, send to, read, stop, and settle child
  conversations.
- `DelegationPacket` and `Settlement` already provide bounded parent/child
  context.
- the work panel and context event stream can display background work and
  provenance.
- native engine settings already expose skill/plugin paths for several hosts.

The missing pieces are a canonical skill source, host capability negotiation,
a portable load path, and a review-specific child policy.

## Part 1: Portable skills

### Canonical package

Store app-managed skills under the Camellia application data directory:

```text
<app-data>/skills/
  review/
    SKILL.md
    references/
    scripts/
    assets/
  adversarial-review/
    SKILL.md
```

`SKILL.md` is authoritative. A small optional `skill.json` may carry fields
that are awkward in frontmatter, but the runtime must work when only
`SKILL.md` exists.

Proposed frontmatter:

```yaml
---
name: review
description: Review a bounded code change without modifying the workspace.
version: 1
license: MIT
allowed-tools:
  - Read
  - Grep
  - Glob
metadata:
  camellia:
    category: development
    read-only: true
    hosts:
      - claude
      - codex
      - kimi
      - grok
      - antigravity
      - dsh
    triggers:
      - code review
      - inspect this diff
---
```

Rules:

- `name` must be stable, lowercase, and safe as a directory name.
- Resources are referenced by relative paths and must not escape the package
  root through `..` or symlinks.
- `allowed-tools` is advisory metadata for previews and tests; it never grants
  a tool permission.
- `read-only: true` is a hard validation flag. A review skill must be
  installable only on a read-only reviewer policy or an isolated snapshot.
- A skill may declare no hosts; it is then available only through the portable
  Camellia bridge.

### Registry state

Keep a small state file, for example:

```json
{
  "version": 1,
  "skills": {
    "review": {
      "sourceHash": "sha256:...",
      "version": 1,
      "enabled": true,
      "trust": "user",
      "targets": {
        "codex": {
          "mode": "native-plugin",
          "path": "<app-data>/engine-homes/codex/plugins/review",
          "hash": "sha256:...",
          "installedAt": 0
        }
      }
    }
  }
}
```

The state file is not a second copy of the skill. It records provenance,
generated output hashes, install scopes, and update/rollback information.

### Host adapter contract

Each engine gets a small adapter with the same interface:

```js
{
  id,
  detect(hostContext),
  capabilities(),
  compile(skillBundle, options),
  planInstall(compiled, hostContext),
  validate(compiled, hostContext),
}
```

`compile()` is pure and deterministic. It returns target paths, generated file
contents, required permissions, and a compatibility status. `planInstall()` is
a dry run. No adapter writes directly during validation.

Initial adapter behavior:

| Host | Preferred mode | Fallback |
| --- | --- | --- |
| Claude Code | `.claude-plugin/plugin.json` + `skills/` | portable bridge |
| Codex CLI/App | `.codex-plugin/plugin.json` with `"skills": "./skills/"` | portable bridge |
| Kimi Code | native plugin/skill package where supported | portable bridge |
| Grok Build | native plugin/skill package where supported | portable bridge |
| Antigravity API | `skillsPaths` or native skill catalog | portable bridge |
| Antigravity subscription | native `skills`/plugin configuration | unavailable if tool-free |
| DSH | native plugin/skill package where supported | portable bridge |

The table is a policy, not a hard-coded assumption. Adapter tests must verify
the installed host version's actual manifest and discovery behavior. A host
that rejects a target is reported as incompatible rather than silently falling
back to an unsafe path.

### Portable bridge

The bridge is a Camellia-owned MCP/tool surface available to any engine that
already receives the Camellia goal tools:

```text
camellia_skill_catalog
camellia_skill_load
camellia_skill_resource
```

The catalog is injected at low cost:

```json
[
  {
    "id": "review",
    "name": "review",
    "description": "Review a bounded code change without modifying the workspace.",
    "triggers": ["code review", "inspect this diff"],
    "readOnly": true
  }
]
```

`camellia_skill_load` returns the full `SKILL.md` only when the model selects
it. `camellia_skill_resource` returns a bounded referenced file. This gives
Camellia a progressive-disclosure path that is independent of the host's skill
implementation.

The bridge does not override the host permission model. If a skill asks for a
tool the host does not permit, the call still fails through the normal
permission path.

### Install scopes

- `app` is the default: install into Camellia-managed engine homes and private
  profiles.
- `global` is explicit: modify a user-level host profile only after a dry-run
  preview and backup.
- `custom` is an explicit user-selected path, with the same path validation and
  hash tracking.

The default must never modify personal `~/.claude`, `~/.codex`, `~/.kimi-code`,
`~/.gemini`, `~/.dsh`, or `~/.grok` files.

## Part 2: Cross-engine review

### Job model

Review is a first-class background job, not a normal child prompt with a
convention attached.

```json
{
  "version": 1,
  "reviewId": "review-uuid",
  "parentConversationId": "conversation-uuid",
  "parentSeq": 42,
  "authorEngine": "claude",
  "reviewerEngine": "codex",
  "mode": "standard",
  "skillId": "review",
  "target": {
    "kind": "workspace-diff",
    "cwd": "D:\\work\\repo",
    "base": "main",
    "head": "WORKTREE",
    "targetHash": "sha256:...",
    "changedFiles": 7,
    "diffChars": 48210
  },
  "focus": [],
  "permissions": {
    "readOnly": true,
    "network": false,
    "runTests": false
  },
  "budget": {
    "maxTurns": 1,
    "maxTokens": 50000,
    "timeoutMs": 600000
  }
}
```

Modes:

- `standard`: correctness, regressions, security, tests, and narrow code
  defects.
- `adversarial`: challenge assumptions, design tradeoffs, alternatives,
  rollback, data loss, race conditions, and hidden failure modes. It accepts
  user-provided focus text.

### Target capture

Capture an immutable review target before starting the reviewer:

- `git status --porcelain=v1`
- `git diff --no-ext-diff --find-renames --stat`
- bounded unified diff
- untracked-file names and bounded contents
- changed-file hashes
- base/head identifiers
- test commands already run and their results

Hash the complete target. If the workspace changes before the reviewer
finishes, the report is marked `stale` and cannot be treated as a pass.

Large targets use a bounded manifest plus read-only file tools. The reviewer
requests specific files or chunks; it must not receive the entire repository
by default.

### Reviewer execution

Use the existing child-conversation lifecycle, but give the child a dedicated
review policy:

- `controlRole: 'reviewer'`
- target engine selected explicitly
- read-only permission mode
- no network by default
- no test execution by default
- no goals, scheduled tasks, plugin installation, memory writes, or child
  creation
- workspace shared for reads only; if the host cannot enforce read-only mode,
  create an isolated git worktree or temporary snapshot and run there
- a bounded review-specific tool set: read/list/search files, git diff/status,
  and `camellia_review_report`

The reviewer receives a `ReviewPacket`, not the author's full transcript:

```json
{
  "request": "Review the current change before merge.",
  "mode": "adversarial",
  "base": "main",
  "focus": ["retry policy", "partial failure"],
  "changedFiles": ["src/engines/compaction-plan.js"],
  "tests": ["node --test tests/compaction-plan.test.js"],
  "constraints": ["Do not edit files.", "Report only."],
  "targetHash": "sha256:..."
}
```

### Structured report

The reviewer must call a report tool; free-form prose is not enough for a
blocking gate:

```json
{
  "version": 1,
  "reviewId": "review-uuid",
  "targetHash": "sha256:...",
  "verdict": "changes_requested",
  "summary": "The retry path can duplicate a side effect.",
  "findings": [
    {
      "id": "f1",
      "severity": "high",
      "confidence": "high",
      "category": "correctness",
      "file": "src/engines/compaction-plan.js",
      "line": 123,
      "evidence": "The fragment is consumed before the retry is accepted.",
      "recommendation": "Persist the consumed boundary before retrying."
    }
  ],
  "openQuestions": [],
  "reviewedFiles": 3
}
```

Validation rules:

- `targetHash` must match the request.
- all paths must be relative to the review cwd and inside the target set.
- line numbers are optional but must be valid when present.
- a report cannot contain executable instructions or edits.
- reports are bounded by finding count and total characters.

### Lifecycle and tools

Expose review as a small tool surface:

```text
camellia_review_start
camellia_review_status
camellia_review_result
camellia_review_cancel
```

`start` accepts a request ID and is idempotent. `status` and `result` are
read-only. `cancel` stops the reviewer child and preserves the last report
state.

The work panel gets a review card with engine, mode, state, target hash, and
findings. Context events record `review-start`, `review-settle`,
`review-stale`, and optional `review-gate`.

### Review gate

An optional gate can run after an implementation turn and before the parent
declares completion. It must be explicitly enabled because it can cause a
review/fix loop.

Hard limits:

- at most one re-review after a `changes_requested` report
- maximum one reviewer turn per pass
- token, time, and concurrency budgets
- no automatic fix by the reviewer
- no gate for a report marked stale
- no gate if the reviewer engine is unavailable

The gate can block completion, but cannot silently apply patches, commit, or
retry forever.

Current implementation: the Goal gate is enforced when the agent reports
`camellia_update_goal` with `status: "complete"` and when the user chooses the
manual Goal completion action. The explicit turn-review setting adds a separate
barrier for ordinary successful turns. Re-running completion against the same
frozen target reuses the existing review instead of spending quota again; a
changed target requires a fresh review. Each Goal is limited to one initial
review and one re-review unless the user grants an override.

## Entry points and activation

Use one primary entry and two secondary entries. The user should not have to
discover a hidden slash command.

### Primary: header Review button

Add a shield/check icon next to the Context and Work-panel header actions:

- label: **Review**
- tooltip: **Review this change with another engine**
- keyboard shortcut: `Ctrl/Cmd+Shift+R`

It is visible for every open conversation, even when there are no changes.
When there is nothing reviewable, the button opens a disabled sheet with a
clear reason rather than silently doing nothing.

### Contextual: composer Review chip

Implementation decision: this chip was removed after user feedback. The header
action remains visible and the keyboard shortcut covers quick access without
adding another control to the composer.

When the workspace has uncommitted changes and a different engine is available,
show a compact chip in the composer footer:

```text
Review 3 files with Codex
```

The chip is a shortcut to the same review sheet. It is not a second workflow and
never starts a review on click alone.

### Secondary: conversation menu and Settings

The conversation menu gets **Review settings…** for per-conversation defaults
and the optional completion gate. Settings → Review gets the global defaults:

- preferred reviewer engine
- preferred reviewer model
- standard/adversarial default
- background default
- whether agents may request a review without an extra confirmation

### Review sheet

The first screen stays small:

```text
Review this change

Author    Claude Code
Reviewer  [Codex CLI v]  [Model v]
Mode      (Standard) (Adversarial)
Scope     [Working tree v]
Focus     optional text

[ ] Keep running in background
[ ] Before completion, require a clean review

[Start review]
```

Advanced options are collapsed:

- compare against a branch/commit
- include untracked files
- token/time budget
- reviewer network access
- reviewer test execution

Defaults are read-only, no network, no tests, and background on.

### First-run consent

The first review shows a one-time consent card:

- what target will be sent to the reviewer
- that the reviewer is read-only
- whether the reviewer runs in the same workspace or an isolated snapshot
- that the reviewer consumes its own engine quota
- that the reviewer cannot edit, commit, or push

The user can remember the reviewer/model choice. Starting a manual review does
not require another confirmation after this consent.

### Availability and guards

The review button is disabled, with an actionable reason, when:

- there is no reviewable change
- the author turn is still running
- no reviewer engine is installed or authenticated
- the selected reviewer is the same engine and the user has not accepted the
  same-engine warning
- two reviews are already running and the new one would exceed the concurrency
  cap

Unavailable engines show **Install** or **Sign in** actions that deep-link to
Engine Settings. They are never silently replaced by another engine.

### Agent-requested review

An agent can invoke `camellia_review_start` through the portable review skill.
For the first use in a conversation, the tool returns a confirmation card
instead of spending quota. The user can choose **Allow reviews in this
conversation** once. This keeps natural-language requests such as “ask Codex to
challenge this design” convenient without allowing an autonomous loop to start
paid reviews silently.

Current implementation: the first request renders a consent card in the
conversation. Approving it enables agent-requested reviews for that conversation
and starts the stored request. The Review dialog checkbox remains available for
manual policy changes.

### Completion gate

The gate is off by default. Enabling it is a separate explicit action:

1. Settings → Review chooses the default reviewer and global gate policy.
2. The conversation menu or review sheet enables **Before completion** for this
   conversation.
3. The first gated turn explains the quota and loop limits.

When enabled, the gate:

- runs only after the author turn has finished
- reviews the frozen target for that turn
- blocks completion only for a fresh `changes_requested` report
- allows at most one re-review
- treats a failed, cancelled, unavailable, or stale review as **not passed**
- offers **Override for this turn** only after showing the reason

The report is shown in the Work panel; it is never applied or committed
automatically.

## Reuse of existing Camellia code

| Existing piece | Reuse |
| --- | --- |
| `SharedConversations.create/send/read/cancel` | reviewer child lifecycle |
| `DelegationPacket` / `Settlement` | bounded parent/child context |
| `conversation-tools` | job control and child status |
| work panel | review card and findings |
| context events | provenance and stale state |
| `engine-settings` | adapter target paths and native manifests |
| goal tool bridge | portable skill catalog/load tools |

Do not route cross-engine review through the normal user-visible discussion
group unless the user explicitly asks for an interactive multi-agent review.
Discussion is conversational; review is a bounded job with a report contract.

## Implementation phases

### Phase 0: contracts and fixtures

- Add `SkillManifest`, `SkillTarget`, `ReviewRequest`, `ReviewReport` schemas.
- Add a feature flag for the portable skill bridge and review jobs.
- Add fixture skills: `review`, `adversarial-review`, and one harmless
  demonstration skill.
- Add fake host homes and fake reviewer engines to the test harness.

Acceptance:

- fixture skill parses with and without optional metadata
- unsafe paths and symlink escapes are rejected
- review target hash is deterministic

### Phase 1: skill registry and native adapters

- Implement skill discovery, validation, hashing, and registry state.
- Implement adapters for Claude and Codex first.
- Add Kimi, Grok, Antigravity, and DSH adapters after host-specific fixture
  checks.
- Add Settings → Skills with source, preview, target matrix, install scope,
  update, and uninstall.

Acceptance:

- one source generates valid Claude and Codex host layouts
- a missing host is reported, not silently ignored
- update preserves a backup and rolls back on validation failure
- app-scope install does not touch personal profiles

### Phase 2: portable bridge

- Add `camellia_skill_catalog`, `camellia_skill_load`, and
  `camellia_skill_resource`.
- Inject a compact catalog into Camellia goal/tool instructions.
- Load full skill text only after a model-selected tool call.
- Expose the same skill to child and scheduled task turns with read-only
  limits.

Acceptance:

- a host with no native skills can load and use the review skill
- the catalog adds bounded tokens per turn
- full skill text and resources are not loaded eagerly
- a child cannot write memory or install a plugin through the bridge

### Phase 3: cross-engine review backend

- Implement review target capture and stale detection.
- Add reviewer child policy, read-only sandbox, and review report tool.
- Add background job persistence, status/result/cancel, and concurrency caps.
- Add standard and adversarial review modes.

Acceptance:

- a parent in one engine can start a read-only reviewer in another
- reviewer write attempts are denied or run in an isolated snapshot
- cancellation and timeout leave the parent and workspace unchanged
- retry with the same request ID does not duplicate a review
- a changed workspace marks the report stale

### Phase 4: UI and gate

- Add review actions to the header/composer and work panel.
- Show engine/model, mode, focus, budget, status, findings, and stale state.
- Add optional review gate with explicit confirmation and hard loop limits.
- Add skill-driven review invocation from the portable bridge.

Acceptance:

- review can run in the background and survive a renderer reopen
- a parent cannot mark a gated turn complete while a fresh blocking finding
  exists
- a stale or failed review does not produce a false pass
- the UI clearly separates reviewer findings from author edits

## Test matrix

### Skills

- valid and malformed frontmatter
- duplicate names, case collisions, and path traversal
- symlink escape and oversized resources
- Claude/Codex manifest golden files
- Kimi/Grok/Antigravity/DSH compatibility fixtures
- app/global/custom scopes
- update, backup, rollback, uninstall
- portable catalog/load/resource tools
- untrusted skill permission and review warnings

### Review

- standard and adversarial modes
- same-engine rejection or explicit warning
- different engine selection and fallback
- clean worktree, staged/unstaged diff, untracked files
- binary files, renames, deletes, large diffs
- report validation and malformed report rejection
- reviewer timeout, cancel, crash, and restart
- target changes during review
- duplicate request ID
- review gate one-pass limit and stale report handling
- child limits and concurrent reviews

### UI

- target matrix and compatibility badges
- install preview before write
- review start/status/result/cancel
- findings grouping and stale state
- work panel persistence and context events
- English/Chinese labels and keyboard accessibility

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Host manifests change | Versioned adapters, fixture tests, compatibility status |
| Personal config damage | App-scope default, dry run, backups, atomic writes |
| Skill supply-chain risk | Hash, trust state, resource scan, explicit install |
| Reviewer edits by mistake | Read-only engine policy plus isolated worktree fallback |
| Reviewer hallucinated findings | Evidence and target hash required; user/host verification |
| Review/fix loop burns quota | One re-review, budgets, background, explicit gate |
| Large diff context blowup | Bounded manifest, file-on-demand reads, diff caps |
| Cross-engine auth unavailable | Report unavailable; never silently substitute |
| Native compaction/tooling differences | Portable bridge and per-host capability matrix |

## Non-goals for the first implementation

- a public skill marketplace
- automatic conversion of arbitrary third-party plugins or hooks
- automatic reviewer edits, commits, or pushes
- network access for reviewers by default
- automatic memory writes from review findings
- unlimited multi-pass review loops
- proxying native engine traffic to emulate another host's skill mechanism

## First milestone recommendation

Build Phase 1 and Phase 3 together for one narrow path:

- import and install one `review` skill
- generate Claude and Codex host manifests
- start a Codex reviewer from a Claude parent
- return a structured read-only report
- display it in the work panel

This proves both the portable skill source and the cross-engine review boundary
without committing to a marketplace or broad plugin compatibility first.
