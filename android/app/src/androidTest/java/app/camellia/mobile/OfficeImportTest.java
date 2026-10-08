package app.camellia.mobile;

import android.content.Context;
import android.net.Uri;
import android.test.InstrumentationTestCase;
import android.util.Log;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;

public final class OfficeImportTest extends InstrumentationTestCase {
    private Context context;
    private final List<File> fixtures = new ArrayList<>();
    private final List<String> references = new ArrayList<>();
    @Override protected void setUp() throws Exception { super.setUp(); context = getInstrumentation().getTargetContext(); }
    @Override protected void tearDown() throws Exception {
        for (String reference : references) AttachmentStore.remove(context, reference);
        for (File fixture : fixtures) Files.deleteIfExists(fixture.toPath());
        super.tearDown();
    }

    public void testAndroidExtractsNamespacesUnicodeRichStringsAndNumericOrder() throws Exception {
        byte[] docx = zip(Map.of("word/document.xml", utf8("<w:document xmlns:w='urn:w'><w:p><w:t>中文 &amp; 😀</w:t><w:tab/><w:t>tail</w:t><w:br/></w:p></w:document>")));
        assertEquals("中文 & 😀\ttail\n\n", ChatDocument.officeText(context, "docx", docx));
        Map<String, byte[]> sheets = new LinkedHashMap<>();
        sheets.put("xl/worksheets/sheet10.xml", utf8("<worksheet><row><c r='A1' t='s'><v>0</v></c></row></worksheet>"));
        sheets.put("xl/worksheets/sheet2.xml", utf8("<worksheet><row><c r='A1' t='inlineStr'><is><t>Inline</t></is></c><c r='B1'><v>42</v></c></row></worksheet>"));
        sheets.put("xl/sharedStrings.xml", utf8("<sst><si><r><t>Rich </t></r><r><t>中文</t></r></si></sst>"));
        String text = ChatDocument.officeText(context, "xlsx", zip(sheets));
        assertTrue(text, text.indexOf("sheet2.xml") < text.indexOf("sheet10.xml"));
        assertTrue(text, text.contains("A1=Inline\tB1=42\t\n")); assertTrue(text, text.contains("A1=Rich 中文\t\n"));
        String slides = ChatDocument.officeText(context, "pptx", zip(Map.of("ppt/slides/slide10.xml", utf8("<s><p><t>Tenth</t></p></s>"), "ppt/slides/slide2.xml", utf8("<s><p><t>Second</t></p></s>"))));
        assertTrue(slides, slides.indexOf("Second") < slides.indexOf("Tenth")); assertNoStagedFiles();
    }

    public void testAndroidUtf16AndDtdRejection() throws Exception {
        String valid = "<?xml version='1.0' encoding='UTF-16'?><p><t>中文 😀</t></p>";
        assertEquals("中文 😀\n", ChatDocument.officeText(context, "docx", zip(Map.of("word/document.xml", valid.getBytes(StandardCharsets.UTF_16)))));
        for (byte[] xml : new byte[][]{
            utf8("<!DOCTYPE p [<!ENTITY secret 'expanded'>]><p><t>&secret;</t></p>"),
            "<?xml version='1.0' encoding='UTF-16'?><!DOCTYPE p [<!ENTITY secret SYSTEM 'file:///private'>]><p><t>&secret;</t></p>".getBytes(StandardCharsets.UTF_16),
            utf8("<!DOCTYPE p SYSTEM 'http://127.0.0.1:1/private'><p><t>Word</t></p>")}) {
            byte[] docx = zip(Map.of("word/document.xml", xml));
            expectIOException(() -> ChatDocument.officeText(context, "docx", docx), "DTD"); assertNoStagedFiles();
        }
        assertEquals("<!DOCTYPE is text\n", ChatDocument.officeText(context, "docx", zip(Map.of("word/document.xml", utf8("<p><!-- <!DOCTYPE is a comment --><t><![CDATA[<!DOCTYPE is text]]></t></p>")))));
    }

    public void testLargeTextAndSharedTablesFailWithoutLeavingTemporaries() throws Exception {
        byte[] text = zip(Map.of("word/document.xml", utf8("<p><t>" + repeat('x', OfficeDocument.MAX_TEXT) + "</t></p>")));
        expectIOException(() -> ChatDocument.officeText(context, "docx", text), "Too much document text"); assertNoStagedFiles();
        StringBuilder items = new StringBuilder("<sst>"); for (int item = 0; item <= OfficeDocument.MAX_SHARED_STRINGS; item++) items.append("<si/>"); items.append("</sst>");
        byte[] table = zip(Map.of("xl/sharedStrings.xml", utf8(items.toString())));
        expectIOException(() -> ChatDocument.officeText(context, "xlsx", table), "Too many spreadsheet shared strings"); assertNoStagedFiles();
        String one = repeat('x', OfficeDocument.MAX_TEXT / 2 + 1);
        byte[] large = zip(Map.of("xl/sharedStrings.xml", utf8("<sst><si><t>" + one + "</t></si><si><t>" + one + "</t></si></sst>")));
        expectIOException(() -> ChatDocument.officeText(context, "xlsx", large), "shared-string text"); assertNoStagedFiles();
    }

    public void testRealImportKeepsEncryptedOriginalAndTextAndRemovesTemporary() throws Exception {
        byte[] bytes = zip(Map.of("word/document.xml", utf8("<p><t>Local 中文</t></p>")));
        File source = fixture("office-test-", ".docx"); Files.write(source.toPath(), bytes);
        JSONObject document = ChatDocument.read(context, Uri.fromFile(source), true);
        references.add(document.getString("data")); references.add(document.getString("text"));
        assertTrue(Arrays.equals(bytes, AttachmentStore.read(context, document.getString("data"))));
        assertEquals("Local 中文\n", new String(AttachmentStore.read(context, document.getString("text")), StandardCharsets.UTF_8));
        File stored = new File(new File(context.getNoBackupFilesDir(), "chat-attachments"), document.getString("data").substring(AttachmentStore.PREFIX.length()));
        assertFalse(Arrays.equals(bytes, Files.readAllBytes(stored.toPath()))); assertNoStagedFiles();
    }

    public void testTextBlankCheckKeepsExistingAsciiTrimSemantics() throws Exception {
        File blank = fixture("office-text-", ".txt"); Files.write(blank.toPath(), utf8(" \t\r\n\u0001"));
        expectIOException(() -> ChatDocument.read(context, Uri.fromFile(blank), true), "No document text found");
        File unicode = fixture("office-text-", ".txt"); String original = " \u00a0 \n"; Files.write(unicode.toPath(), utf8(original));
        JSONObject document = ChatDocument.read(context, Uri.fromFile(unicode), true);
        references.add(document.getString("data")); references.add(document.getString("text"));
        assertEquals(original, new String(AttachmentStore.read(context, document.getString("text")), StandardCharsets.UTF_8));
    }

    public void testParseFailuresAndInterruptedImportsRemoveTemporaries() throws Exception {
        byte[] malformed = zip(Map.of("word/document.xml", utf8("<p><t>bad</p>")));
        expectIOException(() -> ChatDocument.officeText(context, "docx", malformed), "Invalid Office XML"); assertNoStagedFiles();
        byte[] missing = zip(Map.of("word/media/image.png", new byte[100]));
        expectIOException(() -> ChatDocument.officeText(context, "docx", missing), "Invalid Office"); assertNoStagedFiles();
        File directory = directory();
        InputStream interrupted = new ByteArrayInputStream(malformed) {
            @Override public synchronized int read(byte[] value, int offset, int count) { int read = super.read(value, offset, count); Thread.currentThread().interrupt(); return read; }
        };
        try { expectIOException(() -> OfficeImports.stage(directory, interrupted), "cancelled"); }
        finally { Thread.interrupted(); }
        assertNoStagedFiles();
    }

    public void testMaintenanceProtectsActiveImportAndRemovesInterruptedImports() throws Exception {
        File directory = directory(); Files.createDirectories(directory.toPath());
        File stale = new File(directory, "import-00000000-0000-0000-0000-000000000000.zip"); fixtures.add(stale); Files.write(stale.toPath(), new byte[10]);
        File unrelated = new File(directory, "unrelated.zip"); fixtures.add(unrelated); Files.write(unrelated.toPath(), new byte[1]);
        try (OfficeImports.Staged active = OfficeImports.stage(directory, new ByteArrayInputStream(new byte[]{1, 2, 3}))) {
            AttachmentMaintenance.get(context).collectNow(true).get(15, TimeUnit.SECONDS);
            assertFalse(stale.exists()); assertTrue(active.file.isFile()); assertTrue(unrelated.isFile());
        }
        assertNoStagedFiles();
    }

    public void testAndroidIgnoresCorruptMediaAndRejectsSelectedCrc() throws Exception {
        byte[] bytes = zip(Map.of("word/document.xml", utf8("<p><t>Word</t></p>"), "word/media/image.png", new byte[1024 * 1024]));
        int data = localData(bytes, "word/media/image.png"); bytes[data] = 7;
        assertEquals("Word\n", ChatDocument.officeText(context, "docx", bytes));
        int central = central(bytes, "word/document.xml"); bytes[central + 16] ^= 1;
        expectIOException(() -> ChatDocument.officeText(context, "docx", bytes), "Invalid Office"); assertNoStagedFiles();
    }

    public void testSelectiveAllocationAndHeapAgainstEagerExtraction() throws Exception {
        File media = benchmarkArchive(false), xml = benchmarkArchive(true);
        measure("ignored-media", media); measure("large-selected-xml", xml); assertNoStagedFiles();
    }

    private void measure(String scenario, File file) throws Exception {
        byte[] original = Files.readAllBytes(file.toPath());
        // Warm up parser discovery and ZIP code outside the measurement.
        ChatDocument.officeText(context, "docx", zip(Map.of("word/document.xml", utf8("<p><t>Warm</t></p>"))));
        Memory selective = new Memory(); String actual;
        try (selective) { actual = ChatDocument.officeText(context, "docx", original); }
        Memory eager = new Memory(); String previous;
        try (eager) { previous = eagerDocx(original, eager); }
        assertEquals(previous, actual); assertEquals("Only text\n", actual);
        assertTrue("Selective allocations " + selective.allocated + "; eager " + eager.allocated, eager.allocated > selective.allocated * 3);
        JSONObject result = new JSONObject().put("scenario", scenario).put("compressedBytes", original.length).put("largeEntryExpandedBytes", 24 * 1024 * 1024)
            .put("selectiveJavaAllocatedBytes", selective.allocated).put("eagerJavaAllocatedBytes", eager.allocated)
            .put("selectiveJavaHeapPeakDelta", selective.heapDelta()).put("eagerJavaHeapPeakDelta", eager.heapDelta())
            .put("selectivePssPeakDeltaKiB", selective.pssDelta()).put("eagerPssPeakDeltaKiB", eager.pssDelta())
            .put("selectiveMillis", selective.elapsed).put("eagerMillis", eager.elapsed);
        Log.i("CamelliaOfficeTest", "CAMELLIA_ANDROID_OFFICE_MEMORY " + result);
    }

    // The previous production DOCX path, retained only as a measured baseline.
    private static String eagerDocx(byte[] bytes, Memory memory) throws Exception {
        Map<String, byte[]> entries = new HashMap<>(); int total = 0, count = 0;
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(bytes))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (++count > OfficeDocument.MAX_ENTRIES) throw new IOException("Too many entries");
                byte[] data = ChatDocument.bounded(zip, OfficeDocument.MAX_EXPANDED - total); total += data.length; memory.sample();
                String name = entry.getName();
                if (name.equals("word/document.xml") || name.equals("xl/sharedStrings.xml") || name.matches("xl/worksheets/sheet[0-9]+\\.xml") || name.matches("ppt/slides/slide[0-9]+\\.xml")) entries.put(name, data);
            }
        }
        byte[] body = entries.get("word/document.xml");
        if (new String(body, StandardCharsets.UTF_8).toUpperCase(Locale.ROOT).contains("<!DOCTYPE")) throw new IOException("DTD"); memory.sample();
        XmlPullParser parser = android.util.Xml.newPullParser(); parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true); parser.setInput(new ByteArrayInputStream(body), null);
        StringBuilder output = new StringBuilder();
        while (parser.next() != XmlPullParser.END_DOCUMENT) {
            if (parser.getEventType() == XmlPullParser.START_TAG && parser.getName().equals("t")) output.append(parser.nextText());
            else if (parser.getEventType() == XmlPullParser.START_TAG && parser.getName().equals("tab")) output.append('\t');
            else if (parser.getEventType() == XmlPullParser.END_TAG && (parser.getName().equals("p") || parser.getName().equals("br"))) output.append('\n');
        }
        memory.sample(); if (output.toString().trim().isEmpty()) throw new IOException("No text"); return output.toString();
    }

    private File benchmarkArchive(boolean selectedXml) throws Exception {
        File file = fixture("office-benchmark-", ".docx");
        byte[] zeros = new byte[32768], text = new byte[32768]; Arrays.fill(text, (byte) 'x');
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(file.toPath()))) {
            zip.putNextEntry(new ZipEntry("word/document.xml")); zip.write(utf8("<document><p><t>Only text</t></p>"));
            if (selectedXml) { zip.write(utf8("<ignored>")); for (int count = 0; count < 768; count++) zip.write(text); zip.write(utf8("</ignored>")); }
            zip.write(utf8("</document>")); zip.closeEntry();
            if (!selectedXml) { zip.putNextEntry(new ZipEntry("word/media/image.png")); for (int count = 0; count < 768; count++) zip.write(zeros); zip.closeEntry(); }
        }
        return file;
    }

    private File directory() { return new File(context.getCacheDir(), OfficeImports.DIRECTORY); }
    private void assertNoStagedFiles() {
        File[] files = directory().listFiles((parent, name) -> name.startsWith("import-") && name.endsWith(".zip"));
        assertTrue("Office temporary remains", files == null || files.length == 0);
    }
    private File fixture(String prefix, String extension) throws IOException { File file = File.createTempFile(prefix, extension, context.getCacheDir()); fixtures.add(file); return file; }
    private static String repeat(char value, int count) { char[] text = new char[count]; Arrays.fill(text, value); return new String(text); }
    private static byte[] utf8(String value) { return value.getBytes(StandardCharsets.UTF_8); }
    private static byte[] zip(Map<String, byte[]> entries) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes)) { for (Map.Entry<String, byte[]> entry : entries.entrySet()) { zip.putNextEntry(new ZipEntry(entry.getKey())); zip.write(entry.getValue()); zip.closeEntry(); } }
        return bytes.toByteArray();
    }
    private static boolean matches(byte[] bytes, int offset, byte[] value) { if (offset + value.length > bytes.length) return false; for (int index = 0; index < value.length; index++) if (bytes[offset + index] != value[index]) return false; return true; }
    private static int littleShort(byte[] bytes, int offset) { return (bytes[offset] & 255) | (bytes[offset + 1] & 255) << 8; }
    private static int localData(byte[] bytes, String name) {
        for (int index = 0; index < bytes.length - 30; index++) if (bytes[index] == 0x50 && bytes[index + 1] == 0x4b && bytes[index + 2] == 3 && bytes[index + 3] == 4 && matches(bytes, index + 30, utf8(name))) return index + 30 + littleShort(bytes, index + 26) + littleShort(bytes, index + 28);
        throw new AssertionError("Missing local entry");
    }
    private static int central(byte[] bytes, String name) {
        for (int index = 0; index < bytes.length - 46; index++) if (bytes[index] == 0x50 && bytes[index + 1] == 0x4b && bytes[index + 2] == 1 && bytes[index + 3] == 2 && matches(bytes, index + 46, utf8(name))) return index;
        throw new AssertionError("Missing central entry");
    }
    private interface Checked { void run() throws Exception; }
    private static void expectIOException(Checked action, String message) throws Exception { try { action.run(); fail("Expected IOException"); } catch (IOException expected) { assertTrue(expected.toString(), expected.getMessage().contains(message)); } }

    private static final class Memory implements AutoCloseable {
        final long baseline, pssBaseline, allocationBaseline, started;
        final AtomicLong heap = new AtomicLong(), pss = new AtomicLong();
        final ScheduledExecutorService sampler = Executors.newSingleThreadScheduledExecutor();
        long allocated, elapsed;
        Memory() throws InterruptedException {
            System.gc(); System.runFinalization(); Thread.sleep(100);
            baseline = used(); pssBaseline = android.os.Debug.getPss(); heap.set(baseline); pss.set(pssBaseline);
            allocationBaseline = Long.parseLong(android.os.Debug.getRuntimeStat("art.gc.bytes-allocated")); started = android.os.SystemClock.elapsedRealtime();
            sampler.scheduleAtFixedRate(this::sampleAll, 0, 10, TimeUnit.MILLISECONDS);
        }
        static long used() { Runtime runtime = Runtime.getRuntime(); long total = runtime.totalMemory(), free = runtime.freeMemory(); return total == runtime.totalMemory() ? total - free : 0; }
        void sample() { heap.accumulateAndGet(used(), Math::max); }
        void sampleAll() { sample(); pss.accumulateAndGet(android.os.Debug.getPss(), Math::max); }
        long heapDelta() { return Math.max(0, heap.get() - baseline); }
        long pssDelta() { return Math.max(0, pss.get() - pssBaseline); }
        @Override public void close() { sampleAll(); sampler.shutdownNow(); allocated = Long.parseLong(android.os.Debug.getRuntimeStat("art.gc.bytes-allocated")) - allocationBaseline; elapsed = android.os.SystemClock.elapsedRealtime() - started; }
    }
}
