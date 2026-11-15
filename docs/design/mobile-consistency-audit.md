# Mobile consistency audit

Date: 2026-11-15. Android release: 1.1.2, build 144.

The quota-page and bottom-navigation reports exposed a recurring cause: equivalent controls were rebuilt in separate screens, while earlier work was tracked as individual completed pages. A color-token file alone did not prevent differences in control states, spacing, scrolling or feedback. This audit therefore follows UI families through their entry points rather than treating one corrected screenshot as coverage of the family.

## Scope and findings

The source inventory covers 149 Android main Java files and 44 iOS app Swift files, including shared UI helpers. This is a mobile UI consistency review, not a claim that every feature or device has been visually accepted.

| Family | Entry points checked | Result |
| --- | --- | --- |
| Primary navigation | Workbench, Sessions, Computers, Settings | Android already uses `WorkbenchNavigation`; retain build 143's stable glass/selected face, viewport width cap, rounded press and shadow clearance. iOS still has an older root structure; see outstanding work below. |
| Standard actions | MainActivity, local chat, discussions, SettingsStyle, CamelliaDialog, ArtifactSheet, SettingsChoiceDialog, SubtaskPage | Fixed eight independent style adapters through `ActionStyle`. Page actions share 48dp targets; dialog actions share 52dp targets. Theme, border, primary foreground, disabled face/text and accessibility button role now come from one implementation. |
| Chat geometry | Local, remote and discussion details | Fixed differing side gutters, title sizes and header padding. `ChatStyle.pageHeader` owns the common header and `ChatDockLayout` owns viewport clipping and reserved composer space. Discussion details now use the same dock fade and fixed work-status placement. |
| Scrolling panels | Settings, errors, approvals, usage, artifact/details, tasks, conversation/computer/model/permission menus | Migrated 21 ordinary/capped ScrollView sites to `ScrollViews`; scrollbars are hidden without disabling scrolling. Preserve individual height limits and keyboard constraints. The queue already hid its scrollbar; its existing height cap was retained. Specialized transcript and refresh scrollers remain specialized. |
| Error details | Shared ErrorDetails dialog, including long errors in dark mode | Fixed text that relied on the platform default instead of theme ink. The real dialog remains scrollable and uses the shared action/scroll policies. |
| Shared visual tokens | Android Palette and iOS Palette | iOS retained earlier accent, surface, text, shape and typography values. Aligned the shared roles and added guards against silent divergence. Primary text/icons use `onAccent`, including the dark appearance. |
| Toolbar/composer actions | iOS local and remote chat, common back/new-conversation controls | Removed stale raised toolbar discs. Both send/stop controls now delegate to `ComposerActionButton`, including enabled/disabled appearance and 48pt hit areas. |
| Settings feedback and wrapping | Android settings; iOS provider import/copy and settings rows | Retained Android's opaque clipped header and transient success feedback from build 142. iOS non-serious copy/import notices now use a four-second overlay (eight with VoiceOver), clear on departure and cancel stale timers. Serious errors/confirmations remain persistent. iOS appearance choices share equal heights; row labels can wrap. |
| Menus and selection | Model, permission, computer and conversation menus | Checked shared anchoring/surface/choice paths. Preserve different content-driven height limits and explicit selection semantics; do not turn every menu into the same full-height sheet. |
| Loading, empty, blocked and offline | Local configuration, pairing/network, quota/usage, chat and task states | Checked the shared empty/blocked helpers and capability/error paths. Keep a missing prerequisite distinct from an empty result, and keep cached quota data distinct from current data. Build 140's capability check and old-host explanation remain included. |
| Media and attachments | Attachment sheet, gallery, sharing/download and inline media actions | Reviewed their shared helper boundaries. Intentional media-specific chrome remains separate from ordinary page buttons. No media/network protocol changes were made by this audit. |

## Prevention

- `tests/mobile-ui-consistency.test.js` contains six architecture guards: ordinary scrolling policy, all eight action adapters and their CI coverage, the three chat-layout callers, cross-platform semantic colors, cross-platform type/shape roles, and both iOS composer callers.
- Android `UiConsistencyTest` opens the actual activities and action factories. It compares primary/secondary, enabled/disabled/re-enabled states in Chinese/light and English/dark, checks composer tint and verifies a real long ErrorDetails dialog can still scroll.
- Android CI now includes that suite, the existing settings-control checks and subtask-layout checks. This is a workflow change; no hosted CI run or push is claimed.
- A page-specific fix must first enumerate equivalent entry points. Extend the shared owner, check all callers, then verify normal/narrow width, theme, language and state variants. A page completion entry is historical evidence, not a guarantee that all later callers remain aligned.

## Intentional differences

System photo/file pickers, operating-system permission/install dialogs, dark image/video controls and the QR scanning mask retain their native or content-specific appearance. Copy/import success can disappear automatically; errors, unsaved changes, pending approvals and actionable work status must remain available. Local API setup and desktop-granted authorization retain their different prerequisites. Standardizing these differences away would change their meaning.

## Outstanding work

1. **iOS navigation parity remains incomplete.** `CamelliaClient.swift` still routes `.home`, `.localChat`, `.computers` and `.remoteControl` through the older root/push structure; its Home view is not Android's four-destination Workbench. The shared-control fixes here do not migrate that information architecture.
2. The ten changed Swift files pass the available syntax parser with no errors. There is no macOS/Xcode typecheck, simulator visual run or IPA build on this Windows machine. Source alignment is not iOS acceptance.
3. Physical ARM64 Android validation remains unperformed. Local emulators exercise layout/control contracts; real-device rendering, keyboard and gestures still need acceptance.

## Verification and delivery

The release is built from a separate source snapshot; all 149 Android main Java files match the working source. It includes build 143's navigation and build 142's settings fixes. Version name stays 1.1.2.

- Node architecture/integration-cleanup checks: 9 passed, including all 6 new consistency guards.
- Android JVM tests: 270 passed, no failures or errors. Debug assembly and lint passed; lint has 0 errors and 22 warnings.
- Completed normal-size instrumentation: 20 settings/action cases in `matrix-actions-settings.log`, plus the focused 8-case action/subtask batch in `focused-ui.log`. The two action cases overlap, so this is 26 distinct normal-size cases.
- Completed narrow-screen instrumentation: 12 cases at 320dp effective width and 1.3 font scale in `focused-narrow.log`, covering shared actions/error details, settings choices, quota states and popup coordinates. Chinese/light and English/dark error-dialog screenshots were pulled and inspected.
- The broader conversation/navigation instrumentation matrix remains incomplete after host emulator crashes. Individual output before a crash does not establish a successful batch. The machine-readable `build/mobile-consistency-audit-144/verification.json` distinguishes successful batches from interrupted attempts.
- During development the action-state test exposed initial nested-selector state; initialization was fixed and the focused action/subtask batch passed all 8 cases. The subtask fixture now uses a genuinely long title so its wrapping assertion is meaningful on both normal and narrow screens.
- Earlier long emulator attempts ended in a host `qemu-system-x86_64-headless.exe` access violation (`0xc0000005`, Windows Application event 1000). Interrupted runs are not counted as passes.
- The signed release passed the build script's signature, ARM64-only ABI, non-debuggable manifest and native-library alignment checks. The embedded Tailnet library was rebuilt with passing Go checks.

Artifact: `dist/mobile-consistency-audit-build144/Camellia-Android-1.1.2-arm64-v8a.apk` (22,501,601 bytes).

SHA-256: `f0e2f90dc7e4db65b5c4e04b3064876d1830cd324e5411fefe9fee2ac1539cab`.

HP signing certificate SHA-256: `dc36c047b58703a3584300a5fc64960ccc5f0f2ee53c647acbbbe06c9c3a872e`.
