package app.camellia.mobile;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class OfficeDocumentTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void paragraphsPreserveNamespacesUnicodeTabsAndBreaks() throws Exception {
        File archive = archive(Map.of("word/document.xml", utf8("<w:document xmlns:w='urn:w'><w:p><w:t>中文 &amp; 😀</w:t><w:tab/><w:t>tail</w:t><w:br/></w:p></w:document>")));
        assertEquals("中文 & 😀\ttail\n\n", OfficeDocument.read(archive, "docx"));
    }

    @Test public void sheetsUseSharedStringsEvenWhenTheyFollowSheetsInZip() throws Exception {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("xl/worksheets/sheet10.xml", utf8("<worksheet><row><c r='A1' t='s'><v>0</v></c></row></worksheet>"));
        entries.put("xl/worksheets/sheet2.xml", utf8("<worksheet><row><c r='A1' t='inlineStr'><is><t>Inline</t></is></c><c r='B1'><v>42</v></c></row></worksheet>"));
        entries.put("xl/sharedStrings.xml", utf8("<sst><si><r><t>Rich </t></r><r><t>中文</t></r></si></sst>"));
        String text = OfficeDocument.read(archive(entries), "xlsx");
        assertTrue(text, text.indexOf("sheet2.xml") < text.indexOf("sheet10.xml"));
        assertTrue(text, text.contains("A1=Inline\tB1=42\t\n"));
        assertTrue(text, text.contains("A1=Rich 中文\t\n"));
    }

    @Test public void slidesKeepNumericOrder() throws Exception {
        String text = OfficeDocument.read(archive(Map.of("ppt/slides/slide10.xml", utf8("<s><p><t>Tenth</t></p></s>"),
            "ppt/slides/slide2.xml", utf8("<s><p><t>Second</t></p></s>"))), "pptx");
        assertTrue(text, text.indexOf("Second") < text.indexOf("Tenth"));
    }

    @Test public void onlyChosenFormatIsParsed() throws Exception {
        File archive = archive(Map.of("word/document.xml", utf8("<p><t>Word</t></p>"), "xl/sharedStrings.xml", utf8("<broken"),
            "xl/worksheets/sheet1.xml", utf8("<!DOCTYPE x><x/>"), "ppt/slides/slide1.xml", utf8("<broken")));
        assertEquals("Word\n", OfficeDocument.read(archive, "docx"));
    }

    @Test public void ignoredCorruptCompressedMediaIsNeverInflated() throws Exception {
        File archive = archive(Map.of("word/document.xml", utf8("<p><t>Word</t></p>"), "word/media/image.png", new byte[1024 * 1024]));
        byte[] bytes = Files.readAllBytes(archive.toPath());
        corruptEntryData(bytes, "word/media/image.png"); Files.write(archive.toPath(), bytes);
        assertEquals("Word\n", OfficeDocument.read(archive, "docx"));
    }

    @Test public void selectedEntryCrcAndDeclaredSizeAreVerified() throws Exception {
        File crc = archive(Map.of("word/document.xml", utf8("<p><t>Word</t></p>")));
        byte[] bytes = Files.readAllBytes(crc.toPath()); int central = central(bytes, "word/document.xml");
        bytes[central + 16] ^= 1; Files.write(crc.toPath(), bytes);
        expectIOException(() -> OfficeDocument.read(crc, "docx"), "Invalid Office");
        File size = archive(Map.of("word/document.xml", utf8("<p><t>Word</t></p>")));
        bytes = Files.readAllBytes(size.toPath()); central = central(bytes, "word/document.xml");
        putInt(bytes, central + 24, 1); Files.write(size.toPath(), bytes);
        expectIOException(() -> OfficeDocument.read(size, "docx"), "Invalid Office");
    }

    @Test public void declaredWholeArchiveExpansionIncludesIgnoredMedia() throws Exception {
        File archive = archive(Map.of("word/document.xml", utf8("<p><t>Word</t></p>"), "word/media/image.png", new byte[1]));
        byte[] bytes = Files.readAllBytes(archive.toPath()); putInt(bytes, central(bytes, "word/media/image.png") + 24, OfficeDocument.MAX_EXPANDED);
        Files.write(archive.toPath(), bytes);
        expectIOException(() -> OfficeDocument.read(archive, "docx"), "32 MiB");
    }

    @Test public void entryCountLimitIncludesIgnoredEntries() throws Exception {
        Map<String, byte[]> entries = new LinkedHashMap<>(); entries.put("word/document.xml", utf8("<p><t>Word</t></p>"));
        for (int index = 0; index < OfficeDocument.MAX_ENTRIES; index++) entries.put("ignored/" + index, new byte[0]);
        File archive = archive(entries);
        expectIOException(() -> OfficeDocument.read(archive, "docx"), "too many entries");
    }

    @Test public void duplicateSelectedPathsAreRejected() throws Exception {
        File archive = archive(Map.of("word/document.xml", utf8("<p><t>First</t></p>"), "word/documenX.xml", utf8("<p><t>Other</t></p>")));
        byte[] bytes = Files.readAllBytes(archive.toPath()); byte[] before = utf8("word/documenX.xml"), after = utf8("word/document.xml");
        for (int index = 0; index <= bytes.length - before.length; index++) if (matches(bytes, index, before)) System.arraycopy(after, 0, bytes, index, after.length);
        Files.write(archive.toPath(), bytes);
        expectIOException(() -> OfficeDocument.read(archive, "docx"), "Invalid Office");
    }

    @Test public void missingEmptyAndMalformedDocumentsAreRejected() throws Exception {
        File missing = archive(Map.of("word/media/image.png", new byte[0]));
        expectIOException(() -> OfficeDocument.read(missing, "docx"), "Invalid Office");
        File empty = archive(Map.of("word/document.xml", utf8("<p><t> \n\t</t></p>")));
        expectIOException(() -> OfficeDocument.read(empty, "docx"), "No readable");
        File malformed = archive(Map.of("word/document.xml", utf8("<p><t>Word</p>")));
        expectIOException(() -> OfficeDocument.read(malformed, "docx"), "Invalid Office XML");
    }

    @Test public void dtdIsRejectedInUtf8Utf16AndWithExternalSubset() throws Exception {
        String xml = "<?xml version='1.0' encoding='UTF-16'?><!DOCTYPE p [<!ENTITY secret SYSTEM 'file:///private'>]><p><t>&secret;</t></p>";
        File utf16 = archive(Map.of("word/document.xml", xml.getBytes(StandardCharsets.UTF_16)));
        expectIOException(() -> OfficeDocument.read(utf16, "docx"), "DTD");
        File utf8 = archive(Map.of("word/document.xml", utf8("<!DOCTYPE p [<!ENTITY secret 'expanded'>]><p><t>&secret;</t></p>")));
        expectIOException(() -> OfficeDocument.read(utf8, "docx"), "DTD");
        File external = archive(Map.of("word/document.xml", utf8("<!DOCTYPE p SYSTEM 'http://127.0.0.1:1/private'><p><t>Word</t></p>")));
        expectIOException(() -> OfficeDocument.read(external, "docx"), "DTD");
    }

    @Test public void utf16TextAndDoctypeLiteralAreAllowed() throws Exception {
        File utf16 = archive(Map.of("word/document.xml", "<?xml version='1.0' encoding='UTF-16'?><p><t>中文</t></p>".getBytes(StandardCharsets.UTF_16)));
        assertEquals("中文\n", OfficeDocument.read(utf16, "docx"));
        File literal = archive(Map.of("word/document.xml", utf8("<p><!-- <!DOCTYPE is only a comment --><t><![CDATA[<!DOCTYPE is text]]></t></p>")));
        assertEquals("<!DOCTYPE is text\n", OfficeDocument.read(literal, "docx"));
    }

    @Test public void outputLimitAppliesDuringOneLargeTextNode() throws Exception {
        File archive = archive(Map.of("word/document.xml", utf8("<p><t>" + "x".repeat(OfficeDocument.MAX_TEXT) + "</t></p>")));
        expectIOException(() -> OfficeDocument.read(archive, "docx"), "Too much document text");
    }

    @Test public void sharedStringsHaveCumulativeCharacterAndItemBudgets() throws Exception {
        String text = "x".repeat(OfficeDocument.MAX_TEXT / 2 + 1);
        File characters = archive(Map.of("xl/sharedStrings.xml", utf8("<sst><si><t>" + text + "</t></si><si><t>" + text + "</t></si></sst>")));
        expectIOException(() -> OfficeDocument.read(characters, "xlsx"), "shared-string text");
        File items = archive(Map.of("xl/sharedStrings.xml", utf8("<sst>" + "<si/>".repeat(OfficeDocument.MAX_SHARED_STRINGS + 1) + "</sst>")));
        expectIOException(() -> OfficeDocument.read(items, "xlsx"), "Too many spreadsheet shared strings");
    }

    @Test public void invalidSharedIndicesAndNumberedNamesAreRejected() throws Exception {
        for (String index : new String[]{"-1", "0", "bad", "99999999999999999999"}) {
            File archive = archive(Map.of("xl/worksheets/sheet1.xml", utf8("<worksheet><c t='s'><v>" + index + "</v></c></worksheet>")));
            expectIOException(() -> OfficeDocument.read(archive, "xlsx"), "Invalid spreadsheet shared string");
        }
        File numbered = archive(Map.of("ppt/slides/slide99999999999999999999.xml", utf8("<s><t>Text</t></s>")));
        expectIOException(() -> OfficeDocument.read(numbered, "pptx"), "Invalid Office");
    }

    @Test public void truncatedZipFails() throws Exception {
        File archive = archive(Map.of("word/document.xml", utf8("<p><t>Word</t></p>")));
        byte[] bytes = Files.readAllBytes(archive.toPath()); Files.write(archive.toPath(), Arrays.copyOf(bytes, bytes.length - 30));
        expectIOException(() -> OfficeDocument.read(archive, "docx"), null);
    }

    @Test public void stageIsBoundedAndDeletesOnReadFailureAndInterruption() throws Exception {
        File directory = temporary.newFolder();
        InputStream oversized = new InputStream() {
            int remaining = OfficeDocument.MAX_FILE + 1;
            @Override public int read() { return remaining-- > 0 ? 0 : -1; }
            @Override public int read(byte[] target, int offset, int count) { if (remaining == 0) return -1; int read = Math.min(count, remaining); Arrays.fill(target, offset, offset + read, (byte) 0); remaining -= read; return read; }
        };
        expectIOException(() -> OfficeImports.stage(directory, oversized), "10 MiB"); assertEquals(0, directory.list().length);
        expectIOException(() -> OfficeImports.stage(directory, new InputStream() { @Override public int read() throws IOException { throw new IOException("broken source"); } }), "broken source");
        assertEquals(0, directory.list().length);
        InputStream interrupt = new ByteArrayInputStream(new byte[1024]) {
            @Override public synchronized int read(byte[] bytes, int offset, int count) { int read = super.read(bytes, offset, count); Thread.currentThread().interrupt(); return read; }
        };
        try { expectIOException(() -> OfficeImports.stage(directory, interrupt), "cancelled"); }
        finally { Thread.interrupted(); }
        assertEquals(0, directory.list().length);
    }

    @Test public void stageCleanupProtectsActiveFilesAndLeavesUnrelatedFiles() throws Exception {
        File directory = temporary.newFolder(); File unrelated = new File(directory, "other.zip"); Files.write(unrelated.toPath(), new byte[1]);
        File stale = new File(directory, "import-00000000-0000-0000-0000-000000000000.zip"); Files.write(stale.toPath(), new byte[1]);
        File staged;
        try (OfficeImports.Staged current = OfficeImports.stage(directory, new ByteArrayInputStream(new byte[]{1, 2, 3}))) {
            staged = current.file; assertEquals(3, staged.length());
            assertEquals(1, OfficeImports.cleanup(directory)); assertTrue(staged.isFile()); assertTrue(unrelated.isFile());
        }
        assertFalse(staged.exists()); assertTrue(unrelated.isFile()); assertEquals(0, OfficeImports.cleanup(directory));
    }

    @Test public void interruptionBeforeParseIsReported() throws Exception {
        File archive = archive(Map.of("word/document.xml", utf8("<p><t>Word</t></p>")));
        Thread.currentThread().interrupt();
        try { OfficeDocument.read(archive, "docx"); fail(); }
        catch (InterruptedIOException expected) { assertTrue(Thread.currentThread().isInterrupted()); }
        finally { Thread.interrupted(); }
    }

    private File archive(Map<String, byte[]> entries) throws IOException {
        File file = temporary.newFile();
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(file.toPath()))) {
            for (Map.Entry<String, byte[]> entry : entries.entrySet()) { zip.putNextEntry(new ZipEntry(entry.getKey())); zip.write(entry.getValue()); zip.closeEntry(); }
        }
        return file;
    }
    private static byte[] utf8(String value) { return value.getBytes(StandardCharsets.UTF_8); }
    private static boolean matches(byte[] bytes, int offset, byte[] value) {
        if (offset + value.length > bytes.length) return false;
        for (int index = 0; index < value.length; index++) if (bytes[offset + index] != value[index]) return false;
        return true;
    }
    private static int shortValue(byte[] bytes, int offset) { return (bytes[offset] & 255) | (bytes[offset + 1] & 255) << 8; }
    private static int central(byte[] bytes, String name) {
        byte[] text = utf8(name);
        for (int index = 0; index < bytes.length - 46; index++) if (bytes[index] == 0x50 && bytes[index + 1] == 0x4b && bytes[index + 2] == 1 && bytes[index + 3] == 2 && matches(bytes, index + 46, text)) return index;
        throw new AssertionError("Missing central entry " + name);
    }
    private static void putInt(byte[] bytes, int offset, int value) { for (int index = 0; index < 4; index++) bytes[offset + index] = (byte) (value >>> (index * 8)); }
    private static void corruptEntryData(byte[] bytes, String name) {
        byte[] text = utf8(name);
        for (int index = 0; index < bytes.length - 30; index++) if (bytes[index] == 0x50 && bytes[index + 1] == 0x4b && bytes[index + 2] == 3 && bytes[index + 3] == 4 && matches(bytes, index + 30, text)) {
            int data = index + 30 + shortValue(bytes, index + 26) + shortValue(bytes, index + 28); bytes[data] = 7; return;
        }
        throw new AssertionError("Missing local entry " + name);
    }
    private interface Checked { void run() throws Exception; }
    private static void expectIOException(Checked action, String message) throws Exception {
        try { action.run(); fail("Expected IOException"); }
        catch (IOException expected) { if (message != null) assertTrue(expected.toString(), expected.getMessage().contains(message)); }
    }
}
