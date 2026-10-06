# Find files

`/find` looks for files on the computer that runs Camellia and hands them back as
downloadable deliverables. It answers locally: no engine is started and no model
tokens are spent.

## Listing recent files

A /find with no words is a real request, not an error: it lists the files
recent conversations edited or produced, newest first, so a file can be retrieved
without naming it at all. Files that still exist come first; a file that has
since been deleted is shown last and marked as missing. On the phone the **Find
files** button sends this directly when the composer is empty, so one tap lists
what was last worked on.
## Desktop

Type `/find` in the composer and pick **/find** from the slash menu, or select it
directly. The composer switches to a search box with a chip showing which folder
will be searched; describe the file in plain language and press Enter. Press
Escape to leave search mode without searching.

The reply is an ordinary assistant turn that lists every match as a quoted path.
Those paths feed the existing artifact panel, so each file can be previewed,
opened with a system app, revealed in the file manager or attached to a later
message. The folder is the one this conversation already uses, so files created
by earlier turns are reachable without leaving the conversation.

## Phone

The Android composer has a **Find files** button next to the safety-level button.
It pre-fills `/find ` so the command is discoverable, and typing `/find` by hand
works the same way. Send it like a normal message.

Because the computer answers the command itself, the conversation shows the
question and the result, the result's files appear in **Files** for the
conversation, and the existing **Save to phone** flow downloads them. An Android
client that predates this feature therefore keeps working without an update: the
composer has always been able to send text, and the desktop recognizes the
command on the way in. Newer clients also see `find` in the connection
`capabilities` list and may call the dedicated action instead.

## Where results come from

The first place /find looks is not the filesystem but Camellia's own history. The
usual case is a file some conversation already edited or produced, and the
transcript records both the paths it wrote and the words used to describe that
turn. Matching against that history is more accurate than walking folders and
needs no file content at all, so a file that has since been renamed or moved is
still recalled by the name and the words it was created under. Each history hit
names the conversation it came from; files under the current conversation's
folder rank first.

Anything the history does not cover falls back to the filesystem search below.
The model gets the same behaviour through `camellia_find_files`.
## What is searched

- The conversation's working folder, plus its workspace folder when the two
  differ. Results are deduplicated across both.
- File names and extensions, matched case-insensitively. Multi-word and
  non-ASCII queries match word by word, so `report 2024` is satisfied by a file
  whose name contains both words.
- `*` works as a wildcard: `report-*.pdf`, `*.mp4`.
- The walk descends at most eight levels and stops after 20,000 visited entries
  or 100,000 examined entries, and returns at most 20 files, newest first.

### Searching inside files

The common case is knowing a file exists without knowing its name or folder.
Prefix the query with `inside:` to search the text inside readable files instead
of their names:

```
/find inside: supplier negotiation terms
/find inside: quarterly revenue
```

Text and Office documents (`.docx`, `.pptx`, `.xlsx`, `.xls`, `.doc`, `.ppt`)
are read. Every term must appear somewhere in the file, and each hit reports a
snippet around the match, so the choice can be judged instead of guessed. Media,
PDF and unknown formats cannot be read, so they are not searched this way.
Reading is bounded (about 240 files and 48 MiB of samples per search), and files
too large to sample are skipped rather than failing the search.

The model gets the same search through the `camellia_find_files` tool, which it
should prefer over guessing shell commands. Ask in plain language — "Find the
document about supplier negotiations" — and it will search by content, narrow with more terms,
and report the paths it found. Either way the hits become ordinary artifacts, so
they open on the desktop and download to the phone.

Dependency and cache folders (`node_modules`, `vendor`, `.venv`, `.git`,
`__pycache__`, `coverage` and similar) are skipped because they never hold the
deliverable being looked for. Build output such as `dist/` and `build/` is
searched on purpose: an installer, APK or exported document usually lives there.
Hidden entries and lock files (`package-lock.json`, `*.pyc`, `*.dll`, …) are
skipped unless they are named explicitly.

Empty or over-long queries are refused with a localized message. When nothing
matches, the reply names the folders that were searched instead of guessing.

A match whose type the artifact list cannot hand over (for example a `.zip` or a
`.psd`) is still reported by name, but it is listed rather than quoted as a
downloadable path, so no panel offers a file it cannot actually serve.

## Boundaries

- Search only covers the conversation's own folders. It is not a general
  filesystem browser and does not accept an arbitrary root path from the phone.
- The phone reply carries file names, kinds and sizes but no server filesystem
  paths; the device downloads through the normal artifact list, which keeps
  re-verifying each file's identity before it is served.
- Archived conversations and busy conversations cannot be searched. The desktop
  can search before a conversation exists; it then starts one and searches its
  folder.
- History covers the conversations Camellia still knows about. A file created
  outside Camellia, or whose conversation was permanently deleted, is not in the
  index; the filesystem pass is what covers those.
