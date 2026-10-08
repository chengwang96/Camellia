package app.camellia.mobile;

import java.io.File;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import javax.xml.parsers.SAXParserFactory;
import org.xml.sax.Attributes;
import org.xml.sax.InputSource;
import org.xml.sax.SAXException;
import org.xml.sax.SAXParseException;
import org.xml.sax.XMLReader;
import org.xml.sax.ext.DefaultHandler2;

/** Selective, streamed extraction; only spreadsheet shared strings survive an XML parse. */
final class OfficeDocument {
    static final int MAX_FILE = 10 * 1024 * 1024, MAX_EXPANDED = 32 * 1024 * 1024;
    static final int MAX_ENTRIES = 4096, MAX_TEXT = 2_000_000, MAX_SHARED_STRINGS = 100_000;
    private static final Pattern SHEET = Pattern.compile("xl/worksheets/sheet([0-9]+)\\.xml");
    private static final Pattern SLIDE = Pattern.compile("ppt/slides/slide([0-9]+)\\.xml");
    private OfficeDocument() {}

    static String read(File file, String extension) throws Exception {
        checkInterrupted();
        if (file.length() == 0 || file.length() > MAX_FILE) throw new IOException("Office 文件为空或超过 10 MiB / Office file is empty or exceeds 10 MiB");
        if (!extension.equals("docx") && !extension.equals("xlsx") && !extension.equals("pptx")) throw invalid();
        try (ZipFile zip = new ZipFile(file)) {
            if (zip.size() > MAX_ENTRIES) throw new IOException("Office 文件过于复杂 / Office document has too many entries");
            ZipEntry document = null, shared = null;
            List<Part> parts = new ArrayList<>(); Set<String> selected = new HashSet<>();
            long declared = 0;
            Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                checkInterrupted();
                ZipEntry entry = entries.nextElement(); long size = entry.getSize();
                if (size < 0 || size > MAX_EXPANDED - declared) throw expanded();
                declared += size;
                String name = entry.getName();
                boolean main = extension.equals("docx") && name.equals("word/document.xml");
                boolean strings = extension.equals("xlsx") && name.equals("xl/sharedStrings.xml");
                Matcher numbered = (extension.equals("xlsx") ? SHEET : SLIDE).matcher(name);
                boolean part = !extension.equals("docx") && numbered.matches();
                if (!main && !strings && !part) continue;
                if (entry.isDirectory() || !selected.add(name)) throw invalid();
                if (main) document = entry;
                else if (strings) shared = entry;
                else {
                    try { parts.add(new Part(entry, Integer.parseInt(numbered.group(1)))); }
                    catch (NumberFormatException error) { throw invalid(); }
                }
            }
            parts.sort(Comparator.comparingInt((Part part) -> part.number).thenComparing(part -> part.entry.getName()));
            Text output = new Text(); Budget budget = new Budget();
            if (extension.equals("docx")) {
                if (document == null) throw invalid();
                parse(zip, document, budget, new Paragraphs(output));
            } else {
                List<String> strings = new ArrayList<>();
                if (shared != null) parse(zip, shared, budget, new SharedStrings(strings));
                for (Part part : parts) {
                    output.append("\n[" + part.entry.getName() + "]\n");
                    parse(zip, part.entry, budget, extension.equals("xlsx") ? new Sheet(output, strings) : new Paragraphs(output));
                }
            }
            if (!output.readable) throw new IOException("Office 文档无可读取的文字 / No readable Office document text");
            return output.value.toString();
        }
    }

    private static void parse(ZipFile zip, ZipEntry entry, Budget budget, Handler handler) throws Exception {
        SAXParserFactory factory = SAXParserFactory.newInstance(); factory.setNamespaceAware(true);
        XMLReader reader = factory.newSAXParser().getXMLReader();
        reader.setFeature("http://xml.org/sax/features/external-general-entities", false);
        reader.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        reader.setProperty("http://xml.org/sax/properties/lexical-handler", handler);
        reader.setEntityResolver(handler); reader.setContentHandler(handler); reader.setErrorHandler(handler);
        try (InputStream input = zip.getInputStream(entry)) {
            EntryInput checked = new EntryInput(input, entry, budget);
            try { reader.parse(new InputSource(checked)); }
            catch (SAXException error) {
                if (error.getException() instanceof IOException) throw (IOException) error.getException();
                throw new IOException("Office XML 无效 / Invalid Office XML", error);
            }
            // SAX implementations may close their input. EntryInput leaves ownership here.
            // Reading through EOF validates the selected entry's size and CRC as well.
            if (!checked.complete) { byte[] buffer = new byte[8192]; while (checked.read(buffer) != -1) { } }
        }
    }

    static void checkInterrupted() throws InterruptedIOException {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Office import cancelled");
    }
    private static IOException invalid() { return new IOException("Office 文件无效 / Invalid Office document"); }
    private static IOException expanded() { return new IOException("Office 展开内容超过 32 MiB / Office expanded content exceeds 32 MiB"); }
    private static IOException tooMuchText() { return new IOException("文档文字过多，请拆分 / Too much document text; split the file"); }
    private static SAXException xmlError(IOException error) { return new SAXException(error); }

    private static final class Part {
        final ZipEntry entry; final int number;
        Part(ZipEntry entry, int number) { this.entry = entry; this.number = number; }
    }
    private static final class Budget { int read; }

    private static final class EntryInput extends FilterInputStream {
        final ZipEntry entry; final Budget budget; final CRC32 crc = new CRC32();
        long size; boolean complete;
        EntryInput(InputStream input, ZipEntry entry, Budget budget) { super(input); this.entry = entry; this.budget = budget; }
        @Override public int read() throws IOException { byte[] one = new byte[1]; return read(one, 0, 1) == -1 ? -1 : one[0] & 0xff; }
        @Override public int read(byte[] bytes, int offset, int length) throws IOException {
            checkInterrupted();
            int count = in.read(bytes, offset, Math.min(length, 32768));
            if (count > 0) {
                if (count > MAX_EXPANDED - budget.read) throw expanded();
                budget.read += count; size += count;
                if (size > entry.getSize()) throw invalid();
                crc.update(bytes, offset, count);
            } else if (count == -1 && !complete) {
                if (size != entry.getSize() || crc.getValue() != entry.getCrc()) throw invalid();
                complete = true;
            }
            return count;
        }
        @Override public long skip(long count) throws IOException {
            byte[] buffer = new byte[(int) Math.min(8192, Math.max(0, count))]; long skipped = 0;
            while (skipped < count) { int read = read(buffer, 0, (int) Math.min(buffer.length, count - skipped)); if (read == -1) break; skipped += read; }
            return skipped;
        }
        @Override public void close() { /* The enclosing parse owns the ZIP stream. */ }
    }

    private static final class Text {
        final StringBuilder value = new StringBuilder(); boolean readable;
        void append(String text) throws IOException {
            checkInterrupted(); if (text.length() > MAX_TEXT - value.length()) throw tooMuchText();
            value.append(text);
            if (!readable) for (int index = 0; index < text.length(); index++) if (text.charAt(index) > ' ') { readable = true; break; }
        }
        void append(char[] text, int offset, int count) throws IOException {
            checkInterrupted(); if (count > MAX_TEXT - value.length()) throw tooMuchText();
            value.append(text, offset, count);
            if (!readable) for (int index = offset; index < offset + count; index++) if (text[index] > ' ') { readable = true; break; }
        }
    }

    private abstract static class Handler extends DefaultHandler2 {
        @Override public void startDTD(String name, String publicId, String systemId) throws SAXException { throw xmlError(new IOException("Document DTD is not supported")); }
        @Override public InputSource resolveEntity(String publicId, String systemId) throws SAXException { throw xmlError(new IOException("External XML entities are not supported")); }
        @Override public InputSource resolveEntity(String name, String publicId, String baseURI, String systemId) throws SAXException { return resolveEntity(publicId, systemId); }
        @Override public void skippedEntity(String name) throws SAXException { throw xmlError(new IOException("Unresolved XML entity")); }
        @Override public void error(SAXParseException error) throws SAXException { throw error; }
        @Override public void fatalError(SAXParseException error) throws SAXException { throw error; }
    }

    private static final class Paragraphs extends Handler {
        final Text output; boolean text;
        Paragraphs(Text output) { this.output = output; }
        @Override public void startElement(String uri, String name, String qualified, Attributes attributes) throws SAXException {
            if (text) throw xmlError(invalid());
            text = name.equals("t");
            if (name.equals("tab")) try { output.append("\t"); } catch (IOException error) { throw xmlError(error); }
        }
        @Override public void characters(char[] value, int offset, int count) throws SAXException {
            if (text) try { output.append(value, offset, count); } catch (IOException error) { throw xmlError(error); }
        }
        @Override public void endElement(String uri, String name, String qualified) throws SAXException {
            if (name.equals("t")) text = false;
            if (name.equals("p") || name.equals("br")) try { output.append("\n"); } catch (IOException error) { throw xmlError(error); }
        }
    }

    private static final class SharedStrings extends Handler {
        final List<String> strings; StringBuilder current; boolean text; int characters;
        SharedStrings(List<String> strings) { this.strings = strings; }
        @Override public void startElement(String uri, String name, String qualified, Attributes attributes) throws SAXException {
            if (text) throw xmlError(invalid());
            if (name.equals("si")) {
                if (current != null) throw xmlError(invalid());
                if (strings.size() >= MAX_SHARED_STRINGS) throw xmlError(new IOException("共享字符串条目过多，请拆分 / Too many spreadsheet shared strings; split the file"));
                current = new StringBuilder();
            } else if (name.equals("t") && current != null) text = true;
        }
        @Override public void characters(char[] value, int offset, int count) throws SAXException {
            if (!text) return;
            if (count > MAX_TEXT - characters) throw xmlError(new IOException("共享字符串文字过多，请拆分 / Too much spreadsheet shared-string text; split the file"));
            characters += count; current.append(value, offset, count);
        }
        @Override public void endElement(String uri, String name, String qualified) throws SAXException {
            if (name.equals("t")) text = false;
            else if (name.equals("si")) { strings.add(current.toString()); current = null; }
        }
    }

    private static final class Sheet extends Handler {
        final Text output; final List<String> strings; String type = "";
        StringBuilder index; boolean value;
        Sheet(Text output, List<String> strings) { this.output = output; this.strings = strings; }
        @Override public void startElement(String uri, String name, String qualified, Attributes attributes) throws SAXException {
            if (value) throw xmlError(invalid());
            try {
                if (name.equals("c")) {
                    type = attributes.getValue("", "t"); String cell = attributes.getValue("", "r");
                    if (cell != null) output.append(cell + "=");
                } else if (name.equals("v") || name.equals("t")) { value = true; index = "s".equals(type) ? new StringBuilder() : null; }
            } catch (IOException error) { throw xmlError(error); }
        }
        @Override public void characters(char[] text, int offset, int count) throws SAXException {
            if (!value) return;
            if (index != null) {
                if (count > 11 - index.length()) throw xmlError(new IOException("Invalid spreadsheet shared string"));
                index.append(text, offset, count);
            } else try { output.append(text, offset, count); } catch (IOException error) { throw xmlError(error); }
        }
        @Override public void endElement(String uri, String name, String qualified) throws SAXException {
            try {
                if (name.equals("v") || name.equals("t")) {
                    if (index != null) {
                        int position;
                        try { position = Integer.parseInt(index.toString()); }
                        catch (NumberFormatException error) { throw new IOException("Invalid spreadsheet shared string", error); }
                        if (position < 0 || position >= strings.size()) throw new IOException("Invalid spreadsheet shared string");
                        output.append(strings.get(position)); index = null;
                    }
                    value = false;
                } else if (name.equals("c")) { output.append("\t"); type = ""; }
                else if (name.equals("row")) output.append("\n");
            } catch (IOException error) { throw xmlError(error); }
        }
    }
}
