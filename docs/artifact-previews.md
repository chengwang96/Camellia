# Desktop artifact previews

The desktop artifact sidebar renders Markdown locally with headings, tables, lists,
links, images and task lists. It also supports footnotes, KaTeX mathematics using
`$…$`, `$$…$$`, `\(…\)` and `\[…\]`, and syntax highlighting for recognized fenced
code languages. Code copy and wrapping remain available. Unknown languages and
code blocks over 50,000 characters remain plain code. Raw HTML is escaped; trusted
TeX commands and external-resource commands are disabled. Mermaid is not included.

CSV and TSV files open as tables with a first-row header toggle, case-insensitive
search and 100-row pages. Quoted delimiters, escaped quotes and multiline fields
are supported. Parsing warnings are shown without executing cell contents. The
table preview is limited to 20,000 rows and 200 columns within the existing 2 MiB
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
