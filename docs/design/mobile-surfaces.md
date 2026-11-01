# Mobile desktop design alignment

Android and iOS share the desktop chat and settings vocabulary as of 2026-11-01. Native touch targets, navigation, keyboard handling, dock fading and popup glass retain their mobile behavior.

| Element | Light | Dark |
| --- | --- | --- |
| User bubble | `#EDF3FE` | `#283142` |
| Page | `#FFFFFF` | `#151517` |
| Settings card outline | `#D6D6D8` | `#424448` |
| Settings control fill | `#F5F6F7` | `#292A2D` |
| Secondary text | `#61666B` | `#CFD3D6` |
| Tertiary text | `#81858C` | `#ADB2B8` |
| Placeholder | `#ADB2B8` | `#81858C` |

User bubbles use an 18dp/pt radius, settings cards 16 and settings fields 10. Existing popup and sheet radii remain separate. Appearance is a three-choice icon row with an accessible selected state, saving through each client's existing preference path. Neutral switches retain at least 48dp/pt touch targets and an inverted thumb in dark mode.

## Completion and accounting

The remote read model now includes an optional `turnDetails` object on saved assistant messages. It contains only the recorded `state`, `duration_ms`, `model`, `total_cost_usd` and normalized `usage` buckets. It excludes credentials, raw provider responses and last-call context pressure. It travels with both current and older history pages. Clients tolerate its absence, so older desktop/mobile combinations still work.

Successful completed turns use a neutral rule above the reply. When process entries exist, the completion label expands them; an error or stopped turn never receives a successful completion claim. A footer usage button opens a dismissible, scrollable sheet with the total, recorded model, cache hit rate, reported buckets and cost when available.

Local chat records its selected model and duration with the reply. Provider-reported JSON or streaming usage is normalized to the same buckets. OpenAI prompt totals exclude reported cache reads; Anthropic input is already uncached. Stream start/delta accounting is merged before adding a request, so cumulative output is counted once. Tool rounds accumulate once per completed response. A bucket omitted by any round remains unknown for the entire turn. No additional usage requests or unsupported streaming options are introduced.

Missing accounting stays hidden; explicit zero remains visible. Cache hit rate requires known input and cache reads, and its denominator includes reported cache writes. Historical replies never borrow the current composer model. These presentation records stay outside model message bodies.

## Verification

Node coverage checks normalization, unknown/zero/invalid fields, terminal states, snapshot/pagination transport and exclusion of private fields. Android unit and instrumentation coverage checks arithmetic, provider streams, footer reuse, sheet dismissal, appearance accessibility and narrow layouts at 320dp with 1.3 font scaling. Swift protocol checks include the same accounting cases. This Windows host can syntax-check the changed Swift sources but cannot execute the Xcode/iOS checks; those remain required on a Mac or CI.

Local screenshots, build logs and validation results are in `build/mobile-design-qa/`. The signed ARM64 update is exported separately to `dist/mobile-design-sync-100/`.

## File cards and delivery scope

A file card opens only its selected file. Android and iOS retain the full reply reference and assistant message sequence, querying `/v1/conversations/:id/artifacts?offset=0&seq=:seq&reference=:encodedReference`. The desktop resolves the reference in that message's original working directories, including a named output folder. It does not select a file by basename or fall back to another build when the selected file is missing. File byte downloads retain the existing opaque artifact ID and authorization checks. The computer menu keeps the separate conversation-wide file list and download-task history.

Editing a text document is not itself delivery. Text files enter the artifact list only through a final-answer reference or an explicit delivery such as a user attachment. Markdown and other text deliverables remain supported, including older replies that explicitly reference them. Regression evidence for this change is in `build/artifact-selection-qa/`; its signed ARM64 update is exported to `dist/artifact-selection-101/`.
