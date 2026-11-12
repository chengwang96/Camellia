# Android streaming Markdown

Local chat, remote chat and remote discussions share `StreamingMarkdownView`,
`MarkdownStream` and the native `MarkdownView` renderer. This changes only
presentation; provider context, chat storage and the remote protocol keep their
existing formats. No persistent render cache is created.

Math is parsed before CommonMark escapes and emphasis. Inline `$...$` and
`\(...\)` and display `$$...$$` and `\[...\]` use native JLaTeXMath spans,
including fractions, scripts, sums, roots and matrices. Display blocks scroll
horizontally when needed. Code spans, code blocks, escaped dollars and ordinary
currency stay literal. An unfinished formula keeps its TeX visible until its
delimiter closes; unsupported TeX also falls back to visible source. Formula
copy restores its original delimiters and line breaks. The parser runs on the
existing workers, and formula views are patched in place without replacing the
streaming architecture. CommonMark 0.24's Java collection methods are desugared
for the app's Android 8.0 minimum version. License notices ship in the existing
Markdown notices asset and are visible in Settings.

Updates are coalesced for 50 ms. Each visible reply has one worker job and the
latest pending snapshot. Two shared parser threads serve the active replies.
Views are patched on the main thread after parsing. Completion bypasses the
batch delay and reconciles one canonical parse of the complete reply. Existing
history is rendered once on opening, using the activity's shared parser.

The stream retains the unfinished suffix. CommonMark source spans locate block
boundaries. An incomplete first line can still join the preceding block, so
that preceding block remains mutable until the first line ends. Reference
definitions retain document context because they can change earlier links.
Replaced or shortened snapshots reset suffix state and reconcile existing views.

Top-level LF fenced code appends to its existing text buffer. A candidate closing
delimiter remains mutable until its newline arrives. Tables parse and patch the
current row, preserving completed rows and horizontal scroll position; ambiguous
unfinished rows stay mutable. CRLF code and ambiguous table syntax use the
ordinary suffix parser. All paths retain the existing block, cell and depth
budgets, falling back to selectable plaintext when those budgets are exceeded.
As on the desktop client, a GFM table may immediately follow a paragraph
without an intervening blank line. Before parsing, the Android renderer inserts
a parser-only paragraph boundary when a header and alignment row form a valid
table; the stored reply and copied Markdown remain unchanged. Fenced code and
list/quote container lines are left alone.

A suffix longer than 8192 characters is parsed after at least 512 new characters
or one eighth of its previously parsed length, whichever is greater. Intervening
text appears immediately as a plain preview and is reconciled on the next parse.
The full snapshot's append-prefix comparison still runs on the worker; parse
volume measurements do not represent elapsed-time speedups.

Bindings retain view references and small fingerprints rather than completed
ASTs or source slices. Code copy reads the current text buffer. Completed blocks,
code controls, table cells and selections are reused when their formatting is
unchanged. Lists and quotes reconcile their child bindings, preserving nested
code controls and completed items while their final child continues streaming.
Scroll anchoring captures the viewport immediately before the patch
and restores it after layout. Leaving a page disposes its renderer jobs and
scroll listeners. A restarted discussion delivery invalidates its previous run.

Conversation messages and discussion deliveries use stable view bindings.
Finishing a local reply reuses the reply's existing message view. Remote chat and
discussions transfer a live view to its canonical history message when it can be
matched to the completed turn/delivery. Tool and delivery controls update
separately from Markdown.

Remote chat shows "Waiting for output…" only for an active reply without text
or process entries. Saved stopped and failed turns use their recorded terminal
status and elapsed time, including when stopped before the first output. Partial
answers, process entries and usage remain available after stopping and reopening.

The remote compaction timer advances from the host's elapsed time using the
device's monotonic clock. Replayed snapshots and local redraws cannot rewind an
active timer. Stage/chunk updates preserve its elapsed time; a new start or
timeline boundary resets it, and a terminal state freezes the final host duration.

## Verification

`MarkdownMathTest` checks delimiter semantics, TeX preservation, code/currency
exclusions, source spans, partial formulas, nested blocks and fingerprints.
Streaming prefix fixtures include inline and multiline math. The disposable
`MarkdownMathRenderingTest` checks actual glyph rendering in light/dark themes,
fractions, sums, matrices, Greek symbols, horizontal scroll, source copy,
invalid TeX and formula view reuse across streaming completion.

The release upgrade smoke test seeds TeX in an older signed APK, upgrades without
clearing data, and verifies native spans in the actual local history alongside
encrypted data and drafts. R8 must retain `NewCommandMacro`'s no-argument
constructor and `executeMacro` entry point; matrix environments otherwise fall
back to raw TeX despite working in a debug build. Current math evidence and
light/dark screenshots are under `artifacts/android-math-20261010/`.

`MarkdownStreamTest` compares small inputs against complete CommonMark parsing
at 1-, 7- and 37-character chunk boundaries. It also checks replacements, late
references, render budgets and five long-reply fixtures in 200-character chunks.
The fixtures cover paragraphs, fenced code, tables, a 135 KB paragraph and 1100
list items. Cumulative parsed characters decrease by approximately 86–99% against
parsing each complete prefix, including completion in both measurements.
`MarkdownTablesTest` covers paragraph-interrupting tables, escaped pipes, fenced
code and CRLF, while `MarkdownTest` verifies the native table view is created.

`StreamingMarkdownTest` checks native final-format parity, code copy and wrap,
nested list/quote bindings, table cell/row identity, selection, horizontal
scrolling, viewport anchoring,
coalescing, restart invalidation and state disposal. It uses a disposable activity
under the debug source set, excluded from release builds. `MarkdownTest`,
`LocalChatTest` and `RemoteDiscussionsTest` exercise the actual chat entry points
and completion handoffs without model calls.

`RemoteFeedbackTest` also checks the empty live-to-stopped handoff, reopening a
stopped turn, starting a later run, partial output and usage preservation, and
empty finished or legacy rows that must not display a waiting indicator.
`CompactionClockTest` checks stale/replayed progress, forward corrections, missing
timing fields, new operations and terminal durations with a deterministic clock.
`RemoteRichControlsTest` exercises repeated snapshots and local redraws on the
real chat page while verifying that the compaction clock continues advancing.

Build with `assembleDebug assembleDebugAndroidTest testDebugUnitTest lintDebug`.
Run the instrumentation classes with the platform instrumentation runner on a
disposable emulator. Fixture metrics and validation results are recorded under
`dist/test-results/android-streaming-markdown-20261007-summary.json`.
