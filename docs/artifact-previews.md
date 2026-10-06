# Desktop artifact previews

The desktop artifact sidebar renders Markdown locally with headings, tables, lists,
links, images and task lists. It also supports footnotes, KaTeX mathematics using
`$…$`, `$$…$$`, `\(…\)` and `\[…\]`, and syntax highlighting for recognized fenced
code languages. Code copy and wrapping remain available. Unknown languages and
code blocks over 50,000 characters remain plain code. Raw HTML is escaped; trusted
TeX commands and external-resource commands are disabled. Mermaid is not included.

Text-based previews read up to 20 MiB (20,971,520 bytes) from disk, including
Markdown, HTML, source code, logs and structured data. Larger files show the
available text with a truncation notice; the complete file can be opened with the
system app. This bounds preview memory and rendering work without changing the
file or limiting what the conversation engine can read through its own tools.

## LaTeX code blocks

Chat blocks whose language is `latex`, `tex` or `ltx` get a formula button in the
code header. It renders the block with the bundled KaTeX build in the desktop
renderer, so no LaTeX distribution (`pdflatex`, `latexmk`, MiKTeX, TeX Live) or
compiler process is needed. `\begin{equation}…\end{equation}` is accepted by
unwrapping the environment into a display formula, whole `\begin{document}`
documents are reduced to their body after the preamble and title commands are
dropped, and blank-line separated formulas render as separate blocks. Every block
is capped at 20,000 characters and 200 blocks. A formula KaTeX cannot parse shows
its parse error with the original source instead of failing the message, and
pasted `array` preambles using `=` are normalized because KaTeX requires column
specifiers there. TeX is only interpreted as math: `trust` and macro expansion
limits stay in place, so `\href`, `\includegraphics` or `\write18` cannot run
anything. This is not LaTeX typesetting — documents, floats, tables, references,
citations, fonts and page layout are not produced.

CSV and TSV files open as tables with a first-row header toggle, case-insensitive
search and 100-row pages. Quoted delimiters, escaped quotes and multiline fields
are supported. Parsing warnings are shown without executing cell contents. The
table preview is limited to 20,000 rows and 200 columns within the 20 MiB
text-read limit; it does not stream the full file from disk.

JSON files open as collapsible trees. Expanding a node loads 100 children at a
time. Search matches keys/paths and primitive values, returns at most 100 results,
and scans at most 20,000 nodes with a depth limit of 50. Limits are indicated in
the interface. Invalid or size-truncated JSON falls back to the available text
with an explicit notice. JSONL remains a text preview.

## Word and Excel previews

DOCX uses the local `docx-preview` renderer for document styles, tables, pictures,
headers/footers, footnotes/endnotes and explicit or saved page breaks. It does not
implement Word's automatic pagination engine, all fields or all floating layouts.
Embedded fonts and HTML altChunks are disabled. The archive is size-checked and
rebuilt without external relationships or active payloads. Rendering runs in an
opaque-origin sandbox: only nonce-authorized bundled scripts may run, network
access and nested frames are blocked, and document links cannot navigate.
Rendering errors provide a system-app fallback message.

XLSX now provides a worksheet selector, merged cells, row heights, column widths,
hidden rows/columns, basic alignment and frozen row/column positioning. Number
formatting uses SSF, including custom formats and 1900/1904 date systems. Formula
results are taken from the file cache; formulas are never evaluated. Up to 30
worksheets and the first 300 row positions / 50 columns are previewed, with a
notice when data lies beyond the limits. Charts, conditional formatting, pivot
tables and precise print layout remain unsupported.

Legacy `.xls` workbooks use the same worksheet view. Because they are BIFF/OLE2
binaries rather than ZIP archives, a small in-process reader walks the compound
file and decodes shared strings, LABEL/LABELSST text, NUMBER, RK/MULRK, BOOLEAN,
cached FORMULA results, number formats, bold/italic/underline fonts, cell fill
and alignment, merged ranges, column widths, row heights and frozen panes. The
same 30 worksheet / 300 row / 50 column limits apply, and unsupported containers
fall back to the system-app message.

## Presentation previews

PPTX slides are rendered as positioned HTML without scripts or network access.
The previewer resolves the theme colour scheme and master colour map, then applies
the layout and master decoration that a slide inherits, skipping the empty
placeholder prompts that PowerPoint stores for editing. Group shapes, connectors,
tables, charts (rendered as their cached data) and pictures are drawn with their
own relationship set, so a master or layout picture can never borrow a slide's
image. Placeholder geometry, text styles and bullet levels cascade from master to
layout to shape, font autofit scaling is honored, and theme fills, gradients,
colour transforms, rotation, flips and picture crops are approximated. PNG, JPEG,
GIF, WebP, BMP, SVG and TIFF media are inlined; EMF/WMF media cannot be decoded and
appear as a labelled placeholder instead of a broken image. Up to 100 slides are
previewed; animations, transitions, SmartArt, OLE objects, media playback, speaker
notes and precise text metrics remain unsupported.

## HTML previews

HTML/HTM opens as an interactive preview with a selector for static preview or
source text and a reload button. Inline JavaScript, event handlers, canvas and
in-page controls run in an opaque-origin iframe sandbox. The iframe has no app
bridge or parent DOM access; top navigation, popups, downloads and form submission
are not granted. API requests, external scripts, workers and nested frames are
blocked by CSP. External images/styles/fonts are also blocked; self-contained
HTML is recommended. Local relative resources remain subject to browser file URL
restrictions. Pages needing a development server, CDN scripts, authentication or
backend APIs are not equivalent to a full browser. Switching to static/source or
closing the preview discards the current iframe. Static mode disables scripts.

This aligns interactive HTML and source switching with the official file-preview
description at https://developers.openai.com/codex/artifacts-viewer; the public
documentation does not specify the implementation or exact network permissions.
The current page is titled “Work with files” for the ChatGPT desktop app, and
distinguishes it from Codex CLI, which has no visual file preview.

No LibreOffice installation is required. Mermaid and optional PDF conversion
remain separate future phases.

Legacy `.doc` and `.ppt` files are OLE2 compound binaries rather than ZIP
archives, so they cannot be parsed the way `.docx`/`.pptx` are. Each has a
dedicated in-process reader instead. Word 97-2003 (`.doc`) decodes the FIB
header and the CLX piece table, then reads the compressed 8-bit and uncompressed
UTF-16 text runs, so body paragraphs and table cells render as text and tables;
bold/italic, images and exact pagination are not reproduced. PowerPoint 97-2003
(`.ppt`) walks the `PowerPoint Document` record tree, groups the slide
containers, and lists each slide's readable text; layout, themes and images are
not reproduced. Both keep the `document` kind, so artifact ordering and the
remote file list are unchanged, and unsupported containers fall back to the
system-app message.
