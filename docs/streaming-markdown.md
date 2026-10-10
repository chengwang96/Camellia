# Streaming chat Markdown

Desktop assistant replies use `src/renderer/chat/streaming-markdown.js` while
tokens arrive. The existing `mdRender` chat renderer remains the authority for
the completed response; document previews keep their separate renderer.

Windows and macOS share `src/renderer/shared/markdown-math.js` for chat,
discussion/device messages and Markdown file previews. It recognizes `$...$`
and `\(...\)` inline, plus `$$...$$` and `\[...\]` display formulas. Escaped
TeX dollars and matrix row spacing stay inside the expression. Complete formulas
are protected before chat list/table rules; quote container markers are removed
without inserting HTML into the MathML source annotation. Code examples and
unpaired currency signs remain literal. Each expression is limited to 20,000
characters, with KaTeX trust disabled and bounded macro expansion.

The stream scanner retains open bracket/parenthesis formulas across blank lines
and skips escaped closing delimiters. A completed expression is rendered during
streaming and uses the same renderer when history is loaded or reconciled.

- Updates are batched for 50 ms, then painted on an animation frame. Block stop
  and turn completion flush immediately, including native reasoning blocks.
- Completed paragraphs stay in the DOM. The boundary scanner retains open
  emphasis, links, code and math in the unfinished suffix, including syntax
  crossing blank lines and indented code continued after a blank line.
- Fenced code with a complete language line appends to its existing text node.
  Tables append completed rows and reconcile the current row. Ambiguous table
  syntax returns to the ordinary suffix renderer.
- A suffix longer than 8192 characters is parsed at geometric growth intervals
  (512 new characters, increasing to one eighth of its previously parsed length).
  Intervening text remains visible, with formatting reconciled on the next parse.
  Display-math and fence delimiters also request parsing.
- Completion renders the whole answer once and reconciles it against the live
  DOM. Unchanged blocks, code controls and open formula previews are reused.
  Identical canonical assistant messages reuse the completed render.
- Thinking-tag separation processes ordinary deltas without rereading the
  answer. Possible tag boundaries use the existing literal-code-aware splitter;
  completion checks its result again. Native reasoning appends plain text.
- Process layout uses a revision and cached content flags instead of reading
  every earlier Markdown block's text on each flush. Choice extraction runs after
  a 300 ms quiet period, or immediately when the final-answer phase settles.

Streaming state belongs to its live block and is disposed at stop/completion or
when the block is detached. It references the authoritative body string rather
than keeping another full source or HTML cache. This change introduces no
persistent history format or additional application disk files.

## Verification

Run `node --test tests/streaming-markdown.test.js tests/thinking-tags.test.js
tests/chat-markdown.test.js` and `python tests/streaming-markdown-ui.py`.
Additional math checks are `node --test tests/markdown-math.test.js
tests/markdown-preview.test.js`, `python tests/chat-math-ui.py`, and
`python tests/desktop-math-electron-ui.py`. The last uses real Electron with
an isolated profile, checks all three renderer surfaces and local KaTeX fonts,
and records its actual host platform; a Windows pass does not claim macOS
runtime validation.
The browser test uses the actual chat page with a fake desktop bridge and makes
no model calls. It checks intermediate and final DOM parity, node reuse, formula
panels, selection, focus, scroll position, batching and state disposal.

The performance fixtures cover repeated paragraphs, a 105 KB code block,
1500 table rows, a 128 KB paragraph and 1600 list items, arriving in 200-character
chunks. Streaming parse volume decreases by approximately 93–100% compared with
parsing the whole prefix at each chunk. Completion includes one full parse;
these figures describe parse volume, not elapsed-time speedup. Measurements are
written to `dist/ui-preview/streaming-markdown-metrics.json`.
