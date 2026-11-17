# Interactive visualization cards

Status: implemented application-side; live model acceptance confirmed 2026-11-14

Date: 2026-11-14

## Scope

`camellia_visualize` lets a parent conversation render a compact, interactive
HTML card inside the chat. It is intended for parameter explorers, result
comparisons, small simulators and UI mockups. It is not a replacement for
publication figures, PPT generation, large dashboards or ordinary prose.

The tool is available to ordinary parent conversations. Reviewers, managed
children and scheduled checks do not receive it. The card is a conversation
artifact, not a workspace file.

## Data flow

1. The model calls `camellia_visualize` with `action:create` and a title,
   optional summary, mode, style and self-contained HTML fragment.
2. `SharedConversations` validates the fragment and stores an HTML file plus
   metadata under the conversation's `visualize/` directory.
3. The tool result contains only `cardId`, title, mode, summary and timestamp.
4. The desktop renderer detects the result, requests the fragment through
   `conversation-command` action `visualize-get`, and mounts it in a sandboxed
   iframe.
5. The card remains available after reload. Deleting the conversation removes
   its visualization directory.

During a live reply, card results are queued instead of mounting immediately. The
renderer mounts the latest card revision once the run reaches its `result` event,
so streaming updates and duplicate tool events do not repeatedly reload the
iframe. Historical cards mount directly when a completed conversation is painted.

After mounting, the iframe reports the intrinsic width of its top-level content.
The desktop renderer shrinks the surrounding visualization card to that width
when the content is compact, while content that fills the available width keeps
the full-width layout. The width is capped by the current chat column.

## Mobile access

Remote snapshots expose completed card metadata in `message.visualizations`.
Android and iOS render native summary rows and open a card in one full-screen
WebView/WKWebView instead of embedding browsers in transcript rows. The document is
fetched from the authenticated, conversation-scoped endpoint
`GET /v1/conversations/:id/visualizations/:cardId?theme=light|dark`.
Both native endpoint allowlists admit this exact conversation/card path and
only the two supported theme values; summary metadata alone does not exercise
the document request path.

The server wraps the fragment with a restrictive CSP that denies network,
frames, forms and navigation while allowing inline styles, scripts and data
images. Android additionally disables file/content access, DOM storage,
JavaScript windows, network loads and all external URL navigation. iOS uses a
nonpersistent WebKit data store, requires a gesture for media playback and blocks
navigation away from the in-memory document. Authenticated requests use the native
client; credentials never enter either browser. Responses are bounded to 24 MiB,
including embedded media and the JSON/document wrapper.

Closing an Android card stops loading, pauses its browser, disables JavaScript,
removes callbacks, detaches the browser and explicitly calls `WebView.destroy()`.
Cleanup is idempotent and also covers Back, page replacement, request failure and
Activity destruction. A disposed dialog ignores late loads and cannot be reopened.
iOS teardown stops loading, suspends media, removes delegates and scripts, replaces
the document with an empty page and releases the WKWebView through SwiftUI's
dismantle hook; WebKit has no equivalent of `destroy()`. Both clients close the
viewer and cancel its document request when the app becomes fully backgrounded.
Reopening fetches the current desktop revision and state snapshot; mobile control
changes are not written back to the desktop.

An existing card can be corrected with `action:update`, the original `card_id`,
and either one unique `old_str`/`new_str` patch or a replacement fragment. The
card keeps one DOM position and increments its revision instead of appending a
second card.

## Persistent interaction state

Each card has a conversation-scoped JSON state document beside its HTML and
metadata. Cards read it synchronously through
`window.camelliaVisualize.state.get()` and save with `.set(object)`,
`.patch(object)` or `.reset()`. The host validates the object and persists the
latest snapshot through a debounced, authenticated IPC path.

State survives page reloads, theme changes, presentation mode and card
revisions. A card can store up to 64 KB. The header menu exposes "Reset state",
which deletes the state document and reloads the card with an empty object.
Mobile WebViews receive the current state snapshot when opened, but interactions
inside the mobile WebView are not written back to the desktop.

## Desktop presentation and actions

The desktop card header now provides:

- **Present** — enters the browser's native element fullscreen mode. `Escape`
  exits; the iframe is preserved, so interactive state is not reset. While
  presenting, the card content uses the available viewport and the entire
  header is hidden. `Escape` exits; right-click opens a localized presentation
  menu with End slide show. Compact chat width is restored on exit.
- **Copy snapshot** — copies the standalone HTML document to the clipboard.
- **Export HTML** — writes a standalone document containing the current card
  HTML, theme, bound data and persisted state.
- **Reset state** — clears the saved interaction state after confirmation.

The existing Expand/Collapse control remains available outside presentation
mode. Card chrome labels follow Camellia's language setting and update without
reloading the card.

Expand preserves the surrounding conversation and increases the iframe height.
Inside the frame, `html[data-viz-expanded="1"]` and the `camellia:expand` event
(`detail.active`) let scrollable tables use that extra height. Collapse restores
the original inline height instead of retaining the expanded measurement.

Slide decks can mark their root `data-viz-presentation="slides"`. In presentation,
the host removes theme padding and supplies a black backdrop. The deck should
fit its stage with `width:min(100vw,calc(100vh * 16 / 9))` for 16:9 slides and
hide its normal header/footer. Aspect-ratio letterboxing is retained on other
screen shapes. For slide decks, the presentation menu also offers Previous
slide and Next slide. Decks handle the `camellia:presentation-command` event
(`detail.command` is `previous` or `next`) to change pages without replacing
their document. Clicking outside the menu dismisses it; keyboard arrows move
through its items. The menu appears only during native fullscreen.

In fullscreen slide decks, an ordinary left click anywhere in the document,
including letterboxing, emits the `next` presentation command. Native controls,
links, media (including their playback controls), editable content and elements
with interactive ARIA roles retain their own behavior. Mark custom interactive
regions `data-viz-interactive` to exclude them from click-to-advance. Prevented
events, modifier clicks, text selection and the second click of a double-click
do not advance. Clicking outside an open presentation menu dismisses it without
advancing. `window.camelliaVisualize.presentation.clickToAdvance` identifies
host-provided click navigation so decks can avoid registering duplicate handlers.

## Workspace data binding

A card may declare one or more data sources:

```html
<script type="application/json"
        data-viz-data="relative/data.csv"
        data-viz-name="rows"></script>
```

At create/update time Camellia resolves the path inside the conversation
workspace, parses JSON, CSV or TSV, and replaces the declaration with an inert
JSON script block. Cards read a defensive copy with
`window.camelliaVisualize.data.get("rows")`, `.has("rows")` or `.list()`.

Bindings are snapshots: editing the source file does not mutate an existing
card until the card is updated with a new fragment or patch. Limits are 2 MB per
source, 8 MB total and 8 sources per card. Paths outside the workspace, URLs and
unsupported extensions are rejected. Place data declarations before the card
script that reads them.

## Structured actions

After a pointer or keyboard gesture inside the card, a card can emit:

```js
window.camelliaVisualize.action({
  type: "choose-destination",
  label: "海边放空",
  payload: { destination: "coast", score: 4.4 }
});
```

The host validates the action and displays a confirmation tray. Selecting
"Continue in chat" inserts a structured JSON envelope into the composer, shows a
removable "card action" row above the input and never sends the message
automatically. The envelope carries the `cardId`, so the next turn can update
the same card. It refuses to overwrite an existing draft. Action payloads are
bounded to 1.4 KB so the resulting envelope fits the composer.

## Closed loop

The supported workflow is:

1. The model creates a card with controls and state.
2. The user changes the card; its state is saved.
3. A card action places a structured choice in the composer.
4. The user reviews the card-action row and sends the message.
5. The model treats the envelope as the confirmed choice and can update the
   same `cardId`; the card revision changes without resetting saved state.

The model instructions explicitly connect steps 4 and 5. The host does not send
the message or start a follow-up turn on its own.

## Workspace images

The fragment may contain `<img data-viz-src="relative/path.png" alt="...">`.
Before the card is stored, Camellia resolves the path against the conversation
workspace, checks that its real path remains inside that workspace, validates
the image signature and extension, and replaces it with an inline data URL.
External URLs are rejected. PNG, JPEG, GIF, WebP, SVG, BMP and AVIF are
supported; each image is limited to 5 MB and all images to 12 MB across at most
16 images. SVG files containing scripts, foreignObject or inline event handlers
are rejected.

The original workspace file is not copied into the project. The card remains
readable after the source file changes because the image is embedded in the
card when it is created or updated.

## Short workspace videos

Cards may embed short local videos with:

```html
<video data-viz-src="relative/clip.mp4" controls playsinline></video>
```

MP4, M4V, MOV, WebM and OGV are accepted. Camellia validates the file signature,
requires the file to stay inside the conversation workspace and replaces the
source with a local `data:` URL. Limits are 6 MB per video, 12 MB total and
three clips per card. Codec playback still depends on Chromium/Electron.

Videos are embedded, so they remain available offline and in an exported HTML
snapshot. They are not streamed and should be short. Exiting presentation mode
pauses all media in the card; presentation decks should also pause hidden
videos when changing slides.

## Network access

Real network access is opt-in per card. The model declares up to four HTTPS
origins with `network_origins`; they are normalized to scheme + host + port and
stored with the card. Nothing loads from those origins until the user approves
the card in its header. Revoking access reloads the sandbox without the origin.
Changing the declared origins clears prior approval.

After approval:

- `img-src` and `media-src` include only the approved origins.
- A card can play an allowlisted remote `<video src="https://...">`.
- `window.camelliaVisualize.network.fetch(url)` uses a host proxy rather than
  iframe network access. It supports HTTPS `GET`/`HEAD` only, omits credentials,
  rejects redirects, times out after 10 seconds and caps text responses at 2 MB.
- Remote scripts, remote styles, forms and arbitrary iframe connections remain
  blocked.

The network permission is card metadata rather than interaction state, so
resetting controls does not silently grant it again. Mobile card documents do
not currently receive approved network origins.

## Styles

The card supports `whale`, `paper`, `editorial`, `sketch` and `terminal` styles.
`whale` follows Camellia's current light/dark theme; `paper`, `editorial` and
`sketch` keep a light document surface, while `terminal` keeps a dark terminal
surface. The style sets the card's default colors, typography, borders and
table/button surfaces. Fragments can use the exposed CSS variables such as
`--viz-bg`, `--viz-fg`, `--viz-muted`, `--viz-border`, `--viz-accent`,
`--viz-good` and `--viz-warn`. The style is metadata and can be changed through
an update without replacing the card.

## Security boundary

- The fragment must be an HTML body fragment without `html`, `head`, `body` or
  doctype tags.
- Maximum fragment size is 200,000 UTF-8 bytes.
- The iframe uses `sandbox="allow-scripts"` only. It cannot access the host
  origin, cookies, local storage, forms, popups or top navigation.
- CSP denies frames, objects and form submission. Network images, media and
  proxied fetches are limited to user-approved HTTPS origins; fonts remain
  inline data only.
- Card code may request a message be placed in the composer only after a user
  pointer or keyboard event inside the card. It cannot send the message.
- Card state writes and structured actions use the same card-frame message
  channel and are size bounded by the host.
- Card IDs are UUIDs and fragments stay inside the owning conversation
  directory.

## Limits

- Self-contained HTML, inline CSS and inline JavaScript only.
- External network access requires explicit per-card origin approval; remote
  scripts and styles remain unavailable.
- Workspace images are embedded as data URLs and are not hotlinked.
- Workspace videos are short, local snapshots rather than streaming sources.
- No direct host API access.
- No automatic message sending.
- A card is conversation-scoped and is not copied into forks.
- No freehand annotations or cross-conversation card library yet.
- Workspace data is embedded as a snapshot rather than hot-linked.

## Verification

- `tests/visualize.test.js` covers storage, traversal rejection, size limits and
  result detection, state persistence, JSON/CSV binding, short-video embedding
  and the interaction bridge.
- `tests/shared-conversations.test.js` covers parent-only exposure, persistence,
  retrieval and deletion cleanup.
- A real Chromium iframe smoke checks rendering, automatic height, persistent
  state, data access and structured actions.
- Android `VisualizationDialogTest` covers native-only summary rows, actual card
  interaction, Close/Back, page/background cleanup, late delivery and collection
  after repeated open/close cycles. It requires a disposable emulator.
- iOS protocol checks cover metadata parsing, revision deduplication, tool-result
  inheritance, scoped endpoint paths and history weight. External HTTP checks
  cover per-request response limits. WebKit rendering and teardown require Xcode
  and an iOS simulator/device; Windows source checks do not establish runtime parity.
