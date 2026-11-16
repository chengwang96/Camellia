# Mobile Workbench Refresh

Status: Implemented on Android phones and in tablet landscape split views, including multi-server Home and the unified composer footer; iPad composition remains future work.

This document describes the mobile visual refresh and Android's multi-server Workbench. Home aggregates authorized summaries without changing draft, command, approval or conversation-detail behavior. iOS still has the older Home and navigation structure where noted below.

## Android implementation

The Android implementation uses:

- Runtime design tokens in `Palette`, with compact radii and the neutral workbench background.
- `AgentBadge`, `StatusPill`, and `WorkbenchNavigation` shared views.
- Compact session rows with file/workspace/time context and all/running/waiting/files/archived filters that wrap to two rows on narrow phones.
- Android's Running and idle-only Recent sections aggregate every paired server, paint cached summaries immediately and update independently through lightweight Workbench subscriptions. Slow or disconnected hosts never gate other hosts or chat requests. Old servers use paginated list subscriptions, with independent polling when streams are unavailable. Local chat and settings share a compact shortcut card; computer management lives in the Computers destination. iOS's older Home does not yet have these sections.
- A four-destination phone navigation bar for Workbench, Sessions, Computers, and Settings.
- A single composer footer combines the current reply state with approvals, unconfirmed commands, goal state, scheduled-task counts and background work. There is no separate work-summary row above the composer. Tap the footer to open the WorkSheet for approvals, goal/task controls and background actions. Unread errors keep their details; pending commands retain same-request retry, with a Work status action in that dialog. Queued messages use the dedicated queue tray for their count, delivery state, preview and management action.
- The Goal/tasks section reads the conversation's automation snapshot independently of its live turn. It shows full selectable objectives/instructions and existing pause/resume controls directly in the scrollable sheet, updates when automation changes, and applies the same completed-goal visibility rule as the inline bar.
- Compact ToolActivity and Artifact rows.
- Compact Settings groups for account/connection, application/permissions, data/diagnostics and about.
- Shared attachment sheets with a labelled source row and 48dp-or-larger source tiles.
- A docked queue tray with status, next-message preview and a dedicated management sheet; queued items expose explicit edit, insert-now and remove actions with safe handling for starting, paused and failed states.
- Model and permission pickers open as glass menus above the composer trigger, with a grip and rise-in animation. The trigger remains visible and can be tapped again to dismiss the menu. Menus are horizontally centered on the trigger and constrain their scrollable height to the available space above it, including when the keyboard is open.
- On tablet-width windows, long model menus can use up to 72% of the visible height with a 720dp cap; short menus still hug their content. Phone menus retain their 56% / 420dp limit. Both remain bounded by the space above the trigger.
- Remote conversations use a persistent left session sidebar in tablet landscape when the window is at least `840×600dp`. The sidebar shows engine, activity, time and unread state, supports direct conversation switching, and preserves the existing chat page on the right.

Phone remains portrait-only. The tablet split is implemented for the remote conversation view; tablet navigation-rail composition and iOS runtime validation remain future work.

### Reference pass: tactile surfaces

The 2026-11-14 polish pass was checked against the local reference set in `build/design-references/`: **DSH Go Remote** and **Happier**. We adopted their interaction cues rather than copying their brands:

- A quiet page wash under white cards, with the top colour matching the system bars.
- A 1dp outline plus low elevation on floating icon buttons and secondary actions.
- Accent-filled primary actions with a restrained shadow, and a pressed-depth state.
- Hairline card outlines and 1dp elevation on grouped settings, recent-session rows and attachment tiles.
- A separate, higher elevation for popovers and sheets; text-only status labels stay flat.
- Dialog fields use rounded, outlined surfaces instead of the platform underline.
- Buttons, retry actions and empty-state actions use the same outlined capsule treatment; a clickable control is never left looking like an emphasised text label.
- Single- and multi-select questions render as full-row outlined choices with a drawn radio/check mark and a tonal selected state, not as platform `RadioButton` or `CheckBox` widgets.
- Switches draw their own 1dp track outline and shaded thumb so they remain legible on both the light and dark card surfaces.
- The chat composer is one input surface. Attachment, web-tools and permission actions are flat icon hit areas inside it; the model name is a plain text selector; only Send/Stop carries the accent fill. This avoids the previous stack of individually outlined capsules.
- Inside message cards and queue rows, actions use accent text or a soft tonal pill without a border. Home shortcuts do not repeat an action button at all: the entire row is tappable and one chevron communicates navigation. Borders are reserved for page-level controls, dialog actions and fields.

This control pass follows Material 3's outlined-button rule of a 1dp border and clear pressed state, then uses a low-contrast tonal fill so secondary controls remain legible on the page wash. It adds the low elevation and pressed depth observed in the two local references. The 48dp minimum touch target is retained even where the visible control is smaller.

Related documents:

- [`mobile-surfaces.md`](mobile-surfaces.md) records the current desktop/mobile alignment.
- [`../android-chat-view-lifecycle.md`](../android-chat-view-lifecycle.md) owns chat page cleanup and lifecycle behavior.
- [`../../android/DESIGN.md`](../../android/DESIGN.md) records the current Android visual vocabulary.

## Direction

The selected direction is **Calm Workbench**:

- Keep the desktop neutral base, engine identities, status vocabulary, model controls, and one blue accent.
- Make the phone feel like a workbench rather than a settings landing page.
- Prefer content-driven rows over large empty cards.
- Use progressive disclosure for work state: one summary, then a sheet or detail page.
- Build components first so the tablet layout can rearrange them without a second visual redesign.

The phone remains portrait-only. The first tablet composition is the wide remote-chat split described below; other tablet destinations remain single-column.

## Non-goals

- No separate tablet APK or device-specific theme.
- No phone landscape layout.
- No desktop protocol changes.
- No new model or remote-control features in the visual refresh.
- No wholesale copy of AGPL reference projects or their brand assets.

## Visual principles

1. **Calm hierarchy.** Page, section, row, and action must have visibly different weights.
2. **One accent.** Use desktop blue for primary action, selection, focus, and active state. Status colors are semantic, not decorative.
3. **Borders over shadows.** Hairlines and tonal surfaces establish hierarchy; reserve shadows for the composer and sheets.
4. **Compact, not cramped.** Aim for a 16dp page gutter and 12-14dp card padding while keeping 48dp touch targets.
5. **Message-first chat.** Assistant content reads on the page; tool activity collapses into one row instead of becoming another card stack.
6. **One status footer.** Reply state, goals, scheduled tasks, background work and approvals share the composer footer and work sheet; queued messages retain their dedicated tray.
7. **Desktop continuity.** Reuse engine badges, status terms, model labels, permission terms, and artifact language rather than inventing mobile-only vocabulary.

## Tokens

### Color

| Token | Light | Dark |
| --- | --- | --- |
| `page` | `#F6F7F9` | `#151517` |
| `surface` | `#FFFFFF` | `#222326` |
| `surfaceSoft` | `#FBFCFE` | `#1B1C1F` |
| `ink` | `#14171A` | `#F0F2F4` |
| `muted` | `#69717B` | `#A4AAB2` |
| `line` | `#E2E6EA` | `#393B40` |
| `accent` | `#4D6BFE` | `#8095FF` |
| `accentSoft` | `#EEF2FF` | `#293454` |
| `success` | `#1F8A5B` | `#61D49E` |
| `warning` | `#A8610A` | `#F1B45F` |
| `danger` | `#C93645` | `#FF8791` |
| `userBubble` | `#EEF2FF` | `#283142` |

Use `success`, `warning`, and `danger` only for status text or a small icon. Do not fill large cards with status colors.

### Typography

Use the platform UI font. Keep Chinese and English on the same scale.

| Role | Size / line height | Weight |
| --- | --- | --- |
| Hero | `28sp / 34sp` | 700 |
| Page title | `22sp / 28sp` | 700 |
| Section title | `17sp / 24sp` | 650 |
| Row title | `16sp / 22sp` | 600 |
| Body | `14sp / 21sp` | 400 |
| Secondary | `12sp / 18sp` | 400 |
| Caption / time | `11sp / 15sp` | 500 |
| Code | `13sp / 20sp` | 400, monospace |

Avoid more than two weights on one screen. Timestamps and secondary labels use `muted`, not a second accent.

### Spacing, radius, and sizing

- Spacing scale: `4, 8, 12, 16, 20, 24, 32dp`.
- Page gutter: `16dp`; card padding: `12–14dp`; row horizontal padding: `14–16dp`.
- Settings row height: `52–56dp`; conversation row height: `64–72dp`.
- Bottom navigation height: `64dp` plus system inset.
- Touch target minimum: `48dp`.
- Radius: `12dp` for compact cards, `14–15dp` for primary work cards, `18dp` for sheets, `999dp` for pills.
- Separators: `1dp` hairline using `line`.
- Shadow: only composer and sheets; keep it subtle and appearance-aware.

### Motion

- Route changes: `180–220ms`; use the platform ease curve.
- Avoid whole-screen bitmap transitions for in-place state changes.
- Status updates should not animate layout height unless the reader initiated the expand.
- Respect reduced-motion settings.

## Components

### `WorkbenchHeader`

Compact top bar with a 28dp brand/engine mark, a title, optional context line, and up to two actions. The title truncates; context never wraps.

States: normal, connected, reconnecting, no computer, search active. Keep back navigation in the leading position on every non-root page.

### `BottomNavigation`

Four destinations initially:

1. Workbench
2. Sessions
3. Computers
4. Settings

Each item has a 24dp icon, label, selected treatment, and a badge slot for approvals or unread work. A later tablet navigation-rail composition can reuse this order; the current wide split keeps the bar on destination screens.

The 64dp bar has 32dp capsule ends. Its 56dp selected segment and press-ripple mask share a 28dp radius. Sustained presses must keep all four corners clear while still showing feedback inside the rounded shape. Navigation icons are 24dp; labels use 11sp medium weight, with near-ink inactive controls rather than tertiary grey.

The entire bottom region has a full-width live frosted veil, beginning with a 64dp transparent-to-material transition above the bar and continuing through the system gesture/navigation inset. The scroll viewport reaches the physical bottom; no opaque root padding or system contrast scrim follows it. The capsule samples this veil and adds a lighter neutral glass wash, a thin directional light rim and a broad soft shadow. The selected segment uses a low-opacity tonal overlay instead of an opaque grey face. Background hues remain visible through both materials; avoid stacking heavy washes that compound into an opaque white slab. Pixel checks compare equal backdrops across destinations and require meaningful transmission between contrasting backdrops. Icons and labels retain full opacity. Internal scroll padding reserves the 64dp bar, 12dp bottom/shadow gap, 8dp content clearance and the system bottom inset, so the final action can clear the controls. The same geometry applies to all four destinations. Power saver uses an opaque material fallback and stops backdrop capture.

Workbench, Sessions, Computers and Settings have no status footer above the navigation bar or refresh spinner above the content. Refreshing does not translate the content or reserve a loading gap. Pull-to-refresh, its threshold haptic and accessibility action still work, and automatic synchronization continues. Status updates leave the bar's position and size, and the scrolling viewport's height, unchanged. Connection state stays in the existing header or computer row. Conversation detail retains its composer status line and older-message loading indicator.

### `AgentBadge`

Uses the desktop engine mark or a neutral text fallback. Variants: 20dp inline, 28dp row, 32dp hero. Never invent a new engine logo; keep brand assets in one shared source.

### `StatusPill`

States: idle, running, waiting, paused, failed, offline, archived. Each state has a dot and text; do not communicate status by color alone. Use short labels:

- `运行中`
- `等待处理`
- `已暂停`
- `失败`
- `离线`
- `已归档`

### `ContinueCard`

The primary object on Workbench. Shows title, latest preview, engine, computer, elapsed time, and one status. The whole card opens the conversation; a trailing action may open details but must not compete with the card press.

### `SessionRow`

Compact conversation row with engine badge, title, preview, computer/workspace context, time, and status. Supports selection mode, unread marker, long press menu, and swipe actions only where the underlying state is reversible. Preserve the existing accessibility labels and test tags.

### `ChatStatusLine`

The composer footer carries the current reply state. Additional work uses this priority order:

1. Approval or question requiring the reader
2. Failed or unconfirmed command
3. Goal or scheduled-task state
4. Background task count

When additional work is present, tapping the footer opens `WorkSheet`. Unread errors open their details instead; unconfirmed commands retain retry with the original request ID, and that dialog also offers a Work status action. Queue counts and management stay in `QueueTray` and `QueueSheet`. Do not add a separate summary row above the composer.

### `ToolActivityRow`

Collapsed summary such as `已完成 · 5 次工具调用 · 1 个文件`. Tap expands the existing process detail. Use a chevron, not a card. Preserve live and completed states.

### `ArtifactCard`

File icon, filename, type/size, state, and one primary action. Keep artifact references distinct from inline media previews. Do not turn every file reference into a large card; group multiple files under one compact block.

### `ApprovalSheet`

Modal height adapts to content and safe area. Header states what is being requested, body shows the exact command/path/context, actions use clear primary and secondary labels, and destructive/deny actions remain visually distinct. Approval must remain reachable from the composer footer and notification deep links.

### `Composer`

One rounded surface containing attachment action, text field, model selector, permission control, and send/stop action. Preserve auto-resize, IME insets, draft restoration, edit targets, attachments, and existing accessibility labels. The send button is the only filled accent control in the composer.

The permission control is always a separate composer action, never a row inside the attachment sheet. On phone widths it is a compact shield icon with a 48dp target; at `600dp` and above it expands to a shield plus the short current level label (`Ask`, `Default`, `Full`). Both variants have transparent resting backgrounds, including behind the shield, and retain a bounded ripple on press. Discussion composer follows the same rule.

The model selector is content-sized from the current model name plus thinking label. Do not give it `weight=1` or a fixed full-row width. Cap a long label at `58%` of the editor width and at the actual remaining width after fixed tools and Send/Stop, so wide tablets reveal more of the name without allowing the control to collide with the actions.

### `QueueTray` / `QueueSheet`

`QueueTray` is a single compact row above the composer. It shows the queue count, aggregate state, the next message preview, attachment count, and a `Manage` action. It must never expand into the transcript or repeat each queue item as a tall inline card.

`QueueSheet` is the only expanded queue surface. Each entry shows its position, state, message, attachment names, and three explicit actions: edit, insert into the current task, and remove. Editing keeps the queue position and attachments. Insert is available only for a live run or active Goal and is disabled while the queue is paused or failed. A starting entry cannot be edited or removed. The sheet carries a visible Resume action when the queue needs review.

Use the sheet itself as the only elevated surface. Queue cards are flat filled surfaces with a hairline border and no per-card shadow; stacked elevation inside a modal reads as dirty edges and is especially visible inside a scroll view. Keep one tonal primary action (`Insert`) and render `Edit` and `Remove` as text actions, with `Remove` reserved for the error colour. Hide the list scrollbar and let the partially visible next card communicate that the list scrolls.

### `SettingsGroup` / `SettingsRow`

Grouped list with a section label, 52–56dp rows, leading icon, title, optional value, chevron, and divider. Values truncate from the left when needed. Destructive rows use `danger` for text and icon only.

### `ModelPickerSheet`

Both local and remote model pickers open above the composer trigger, centered on that trigger and bounded by the visible frame. Size model menus from their actual title text, row/panel padding and a reserved selection-mark column, with a `220dp` minimum and `340dp` maximum, further limited by the viewport gutters. Supporting descriptions wrap within that width. Keep width stable when the selected model changes. Use a visible grip and a short content rise-in animation. Permission sheets keep their separate sizing policy.

### `ConversationSidebar`

Wide landscape remote chat uses a `300–360dp` left pane. Rows show engine badge, title, activity or idle context, relative time and unread state. The current conversation has a tonal selected background. The sidebar paints from the local cache and refreshes through `/v1/conversations?offset=0`; tapping another row persists the current draft and replaces only the chat pane. Keep the sidebar hidden in portrait and below the `840×600dp` landscape threshold.

### `EmptyState`

Brand/engine mark, one short heading, one explanatory sentence, and at most two actions. Do not use a large card around the empty state. Keep the composer available in chat empty states.

## Screen structure

### Workbench

- Compact brand header: Camellia mark only. The paired-computer context and new-conversation action live in Sessions/Computers instead of a duplicate bar on Workbench.
- Back from a conversation returns to the screen that opened it: Workbench for a home row, Sessions for a session-list row.
- Switching among the four bottom destinations is an in-place content swap: the navigation bar keeps its geometry and does not slide. Horizontal push/pop transitions remain reserved for entering and leaving a conversation or other nested page.
- Sessions, Computers and Settings are sibling top-level destinations, not a parent chain. None shows a header back button; the Settings title stays centered. Settings subpages retain their back buttons. System Back from Sessions returns to Workbench, not Computers.
- Hero title: continue working.
- The shortcut group contains only **Local chat** and **Settings**. Computer management uses the bottom **Computers** destination; Workbench has no duplicate computer shortcut, connection-state label or connection-retry actions.
- No count subtitle and no duplicate continue card. The first card is not repeated again below itself.
- `运行中` section for running, permission/question and background-work conversations. It omits itself when nothing is active.
- `最近` section merges idle conversations by `updatedAt` across all paired servers. Three rows are shown initially; View all expands the cached summaries in place across servers. Each server contributes its ten latest idle rows and every active row through `/v1/workbench/events`. Summaries have a separate persistent cache and never replace full conversation-list pages. Rows display their server name and use server address plus conversation ID as their identity. Clicking a row selects its saved server credentials before opening the conversation; background home refreshes never change the selected server.
- List changes are coalesced during a touch gesture and its fling, then applied after 180ms without scrolling. The cache and subscription remain current while the gesture runs. Inserts, removals and reordering preserve the surviving visible card's offset; leaving the page discards pending UI work. Expanding/collapsing Running uses the same list update and does not restart the subscription.
- Each running/recent row owns its own activity label. There is no page-level running/waiting total, so a completed run cannot leave a separate summary claiming that some other conversation is still running.
- Bottom navigation.

Each paired server owns a single coalesced home subscription on its own worker, independent of chat and command workers. Opening has a 12-second deadline; 45 seconds without a snapshot or heartbeat makes a live stream stale. Failures retry with backoff up to two minutes (429 waits at least one minute); 401/403 remove cached rows and wait for an explicit retry. A fast host updates its cards as soon as its snapshot arrives; a slow host does not gate it, and an offline host does not keep the page in a loading state. While the server's first snapshot is pending its cached rows say Checking status; once that connection attempt fails they say Offline · Previously running (or Offline · Status unconfirmed). A host whose stream succeeded but whose cached row is still unverified keeps Previously running or Status unconfirmed. Servers with no snapshot show a compact per-server notice. Home, computer-status, prefetch, image and import clients must carry an Activity context so the embedded Tailnet handles them; a context-free `RemoteApi` silently bypasses it. Leaving Home, backgrounding or changing routes cancels subscriptions and rejects late callbacks. Pull refresh restarts subscriptions at most once per five seconds without a top spinner or footer. Servers without the new endpoint use legacy list events and fetch every remaining page so older active tasks are not lost; servers without either stream poll every 15 seconds, or 30 seconds after a slow response. Existing card reuse, scroll anchoring and touch/fling coalescing still apply.

### Sessions

- Header: title, active computer, search, computer switcher, new conversation. It is a top-level destination and has no back button.
- Search field and filter chips: all, running, waiting, with files, archived.
- Show the active computer's conversations, grouped by workspace and then by recency. Switching computers is an in-place context change, not a nested page push.
- Compact `SessionRow`s.
- Preserve existing pagination, selection, search, archive, rename, and prefetch behavior.
- When no computer is selected, keep the Sessions destination visible with a "No computer connected" state and a **Manage computers** action. Do not redirect the bottom bar to the Computers destination.

### Computers

- Header: connection-management title and no back button.
- List paired computers, their connection state, **Add computer**, and per-computer management actions.
- Opening a computer saves it as the active computer and switches directly to the Sessions destination. It does not push Sessions as a child page.
- The bottom **Computers** item opens this destination directly. Workbench does not repeat it as a shortcut.

### Chat

- Compact header: back, title, engine/computer status, overflow.
- Message canvas with user bubble and assistant content on the page.
- `ToolActivityRow` for process details.
- `ArtifactCard` for delivered files.
- One `ChatStatusLine` in the composer footer.
- One compact `QueueTray` above the composer when messages are queued; full queue management opens in `QueueSheet`.
- `Composer`.

Do not reintroduce separate full-width cards above the composer for goal, queue, background work, approvals, and work status at the same time.

### Settings

- Compact header.
- Account/computer summary block.
- Grouped rows for models, connection, permissions, appearance, language, diagnostics, and about.
- Destructive action group visually separated.
- No full-page empty whitespace beneath short groups.

## Android mapping

Do not create a second unrelated style system. Extend the existing semantic styles:

- `Palette` remains the color/type source for chat and shared controls.
- `ChatStyle` keeps chat geometry and message behavior.
- `SettingsStyle` owns settings page padding, group, row, and field treatment.
- Add only the missing semantic aliases and shared metrics; avoid parallel constants with different names for the same value.

Refactor order:

1. Add semantic color/metric aliases and update `AgentBadge`, `StatusPill`, `SessionRow`, and `SettingsRow` primitives.
2. Apply the system to Settings and Workbench using existing data.
3. Replace the conversation list presentation while preserving loading, prefetch, selection, and search behavior.
4. Apply the chat header, `ToolActivityRow`, `ArtifactCard`, and `ChatStatusLine`.
5. Consolidate approval, goal, task and background controls in `WorkSheet`; preserve queue management in `QueueSheet`.
6. Run visual and accessibility regression across phone and the tablet remote-chat split.

Keep the current state ownership until the visual layer is stable. In particular, do not combine this work with a remote connection lifecycle refactor.

## iOS mapping

Use the same tokens and component names in SwiftUI. Keep the existing `PageStack` for phone navigation until the Android component contract is stable. iPad split layout is a later composition step. iPhone remains portrait-only.

## Tablet composition

- The implemented split applies to remote chat: a `300–360dp` session sidebar at the left and the existing chat as the right pane.
- Workbench, Sessions, Computers and Settings remain single-column for now; the bottom navigation has not yet become a rail.
- Workbench and Settings remain single centered columns on tablet portrait.
- `ChatStatusLine`, `ApprovalSheet`, and `Composer` keep the same appearance in both compositions.

The split is enabled only when the available window is at least `840dp` wide, `600dp` tall, and wider than it is tall. Phone-sized devices remain portrait-only.

Locale/theme overrides must contain only preference fields. Copying the full launch `Configuration` also overrides orientation, window bounds and dp sizes, leaving portrait resources frozen after an actual tablet rotation. `TabletRotationContinuityTest` requests system portrait/landscape changes and checks visible sidebar bounds, the existing connection owner/generation, current conversation, return destination and unsent draft. It covers opening a conversation while already in landscape and rotating an open conversation back and forth. This replaces the earlier synthetic resource-update/callback check; the regression was reproduced on the old build and verified at `960×600dp` and `1280×800dp`.

## Verification

Visual:

- Light and dark.
- Chinese and English.
- Font scale `1.0`, `1.3`, and at least one large-text state.
- Width `320dp`, `360dp`, and `411dp`; phone landscape is not a redesign target.
- Settings, list, empty chat, active chat, approval sheet, goal/task summary, long Markdown, artifacts, and media.

Behavior:

- Existing unit and instrumentation suites remain green.
- Drafts, attachments, edit targets, pending commands, approval deep links, and selected conversation survive page replacement and rotation.
- Conversation list loading, pagination, prefetch, search, multi-select, archive, and rename remain unchanged.
- Workbench subscriptions are coalesced per server, stop while hidden or offline, and do not consume chat or command request lanes.

Release:

- Lint and release build pass.
- Screenshot artifacts are retained under `build/` with the corresponding APK.

## Resolved implementation choices

1. Workbench, Sessions, Computers and Settings are the four bottom-navigation destinations.
2. Android Workbench paints all paired servers' cached tasks, then updates each through the lightweight summary stream while visible, retaining the legacy paginated fallback.
3. Approvals and questions take priority over failed or unconfirmed commands, goals, scheduled tasks and background work in `ChatStatusLine`; queue state stays in `QueueTray`.
