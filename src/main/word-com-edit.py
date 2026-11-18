"""Bridge legacy .doc text edits to the installed Microsoft Word.

Python is not the application's editor. It is a short COM bridge for Word
97-2003 files, whose OLE2 text stream cannot be safely rewritten in place: a
longer or shorter run changes offsets stored in the FIB and in the character
formatting runs. Word is the only local component that recalculates those
structures correctly, so this script opens a private copy, applies the text
edits or lists Word's own paragraph indices, and closes Word before the caller
swaps the copy into place.
"""

import json
import os
import shutil
import sys
import tempfile


def result(payload):
    print(json.dumps(payload))
    raise SystemExit(0)


def main():
    try:
        import win32com.client
    except Exception:
        result({"ok": False, "error": "Editing .doc files needs Microsoft Word on Windows."})
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as handle:
            request = json.load(handle)
    else:
        request = json.loads(sys.stdin.read())
    source = request.get("path")
    edits = request.get("edits")
    read_only = bool(request.get("readOnly"))
    convert = request.get("convert")
    if not isinstance(source, str) or not os.path.isfile(source):
        result({"ok": False, "error": "The document is no longer available."})
    if isinstance(convert, str):
        # Rich preview: let Word itself convert the legacy file to OOXML, then
        # the existing DOCX renderer draws layout, tables and pictures. The
        # converted copy is temporary and never replaces the original.
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        document = None
        try:
            document = word.Documents.Open(source, ReadOnly=True, AddToRecentFiles=False)
            document.SaveAs2(convert, FileFormat=12)
            document.Close(False)
            document = None
        finally:
            if document is not None:
                try: document.Close(False)
                except Exception: pass
            try: word.Quit()
            except Exception: pass
        result({"ok": True, "path": convert})
    if not read_only and not isinstance(edits, list):
        result({"ok": False, "error": "Invalid Word edits."})

    workdir = tempfile.mkdtemp(prefix="camellia-doc-")
    copy = os.path.join(workdir, "document.doc")
    keep_workdir = False
    document = None
    word = None
    try:
        shutil.copyfile(source, copy)
        # The copy must be writable even when the original is read-only; the
        # application already checked the target permission before calling.
        os.chmod(copy, 0o600)
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False
        word.DisplayAlerts = 0
        document = word.Documents.Open(copy, ReadOnly=read_only, AddToRecentFiles=False)
        total = int(document.Paragraphs.Count)
        if read_only:
            # Word's Paragraphs collection is the only reliable index space:
            # table cells, text boxes and headers are counted exactly as Word
            # counts them, which a piece-table decode cannot reproduce.
            paragraphs = []
            for index in range(total):
                paragraph = document.Paragraphs(index + 1)
                text = str(paragraph.Range.Text)
                # An inline picture is a \x01 character. Sending that row to
                # the editor as text would let a save replace the picture, so
                # picture and other non-text paragraphs are marked read-only.
                editable = not (
                    int(paragraph.Range.InlineShapes.Count)
                    or any(ord(char) < 32 and char not in "\t\r\n\x07" for char in text)
                )
                paragraphs.append({"text": text.rstrip("\r\n\x07"), "editable": editable})
            document.Close(False)
            document = None
            word.Quit()
            word = None
            result({"ok": True, "paragraphs": paragraphs})
        for edit in sorted(edits, key=lambda item: item.get("index", -1), reverse=True):
            index = edit.get("index")
            text = edit.get("text")
            if not isinstance(index, int) or index < 0 or index >= total:
                result({"ok": False, "error": "The document layout changed. Reopen it before saving."})
            if not isinstance(text, str) or "\0" in text:
                result({"ok": False, "error": "Enter valid text without null characters."})
            paragraph = document.Paragraphs(index + 1)
            # Only a plain text paragraph may be replaced. This is the last
            # line of defence against turning a picture or page break into
            # text if a stale editor sends an index for one.
            if int(paragraph.Range.InlineShapes.Count) or any(
                    ord(char) < 32 and char not in "\t\r\n\x07" for char in str(paragraph.Range.Text)):
                result({"ok": False, "error": "This paragraph contains a picture or page break and cannot be edited."})
            start = int(paragraph.Range.Start)
            # Range.Text includes the paragraph mark. Replacing it would merge
            # this paragraph with its successor, so stop one character short
            # and let Word keep its own mark in place.
            end = int(paragraph.Range.End) - 1
            if end >= start:
                document.Range(start, end).Text = text
        document.Save()
        document.Close(False)
        document = None
        # The caller reads this edited copy and removes its directory after
        # swapping it into place. Error paths must not leave a private copy.
        keep_workdir = True
        size = os.path.getsize(copy)
        print(json.dumps({"ok": True, "size": size, "copy": copy}))
        raise SystemExit(0)
    except SystemExit:
        raise
    except Exception as error:
        result({"ok": False, "error": str(error)})
    finally:
        if document is not None:
            try: document.Close(False)
            except Exception: pass
        if word is not None:
            try: word.Quit()
            except Exception: pass
        if not keep_workdir:
            shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
