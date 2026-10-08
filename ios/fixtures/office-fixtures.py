#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Writes the Office fixtures the document checks read.

The point is not to ship sample documents. It is that the ZIP reader and the
XML extraction get exercised against archives a real ZIP writer produced, with
a central directory, DEFLATE-compressed parts and a proper entry layout --
rather than against archives this code also invented, which would agree with a
wrong reader as happily as with a right one.
"""
import os
import sys
import zipfile

WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
SHEET_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DRAWING_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/main"
PRESENTATION_NAMESPACE = "http://schemas.openxmlformats.org/presentationml/2006/main"

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>
"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
"""

# Two runs in the first paragraph, separated by a tab, then a second paragraph.
# The expected extraction is "Hello\tworld\n\u7b2c\u4e8c\u6bb5\n".
DOCUMENT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="{ns}">
  <w:body>
    <w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/><w:t>world</w:t></w:r></w:p>
    <w:p><w:r><w:t>\u7b2c\u4e8c\u6bb5</w:t></w:r></w:p>
  </w:body>
</w:document>
""".format(ns=WORD_NAMESPACE)

# A1 is a shared string, B1 a literal number, and the second row one more
# shared string. The expected extraction names each cell by its reference.
SHARED_STRINGS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="{ns}" count="2" uniqueCount="2">
  <si><t>Alpha</t></si>
  <si><t>Beta</t></si>
</sst>
""".format(ns=SHEET_NAMESPACE)

SHEET = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="{ns}">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>
    <row r="2"><c r="A2" t="s"><v>1</v></c></row>
  </sheetData>
</worksheet>
""".format(ns=SHEET_NAMESPACE)


def slide(text):
    return """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="{p}" xmlns:a="{a}">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>{text}</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>
""".format(p=PRESENTATION_NAMESPACE, a=DRAWING_NAMESPACE, text=text)


def write(path, parts):
    """DEFLATE-compressed, so the reader's inflate path is the one under test."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, text in parts:
            archive.writestr(name, text.encode("utf-8"))


def main(directory):
    os.makedirs(directory, exist_ok=True)
    write(os.path.join(directory, "sample.docx"), [
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", ROOT_RELS),
        ("word/document.xml", DOCUMENT),
    ])
    write(os.path.join(directory, "sample.xlsx"), [
        ("[Content_Types].xml", CONTENT_TYPES),
        ("xl/sharedStrings.xml", SHARED_STRINGS),
        ("xl/worksheets/sheet1.xml", SHEET),
    ])
    # Two slides, so the numeric ordering is exercised rather than assumed.
    write(os.path.join(directory, "sample.pptx"), [
        ("[Content_Types].xml", CONTENT_TYPES),
        ("ppt/slides/slide1.xml", slide("Slide one title")),
        ("ppt/slides/slide2.xml", slide("Slide two title")),
    ])
    print("fixtures: " + directory)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
