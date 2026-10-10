package app.camellia.mobile;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension;
import org.commonmark.ext.gfm.tables.*;
import org.commonmark.node.*;
import org.commonmark.parser.IncludeSourceSpans;
import org.commonmark.parser.Parser;

/** Worker-owned streaming state. Only the current suffix is reparsed. No Android objects. */
final class MarkdownStream {
    private static final int SMALL_TAIL = 8192;
    private static final Pattern FENCE = Pattern.compile("^(`{3,}|~{3,})([^\\r\\n]*)\\r?\\n");
    private static final Pattern DEFINITION = Pattern.compile("(?m)^ {0,3}\\[[^\\]\\r\\n]+\\]:");
    private final Parser parser = newParser();
    private String previous = "";
    private int committed, blockCount, budget, lastParsed;
    private int suffixCodeShown = -1;
    private boolean suffixTable;
    private boolean references, rawMode, tableDisabled;
    private boolean lfOnly = true;
    private CodeState code;
    private TableState table;
    long parsedCharacters;
    int parseCalls;

    static Parser newParser() {
        return Parser.builder().extensions(Arrays.asList(TablesExtension.create(), StrikethroughExtension.create(), new MarkdownMath()))
            .includeSourceSpans(IncludeSourceSpans.BLOCKS).build();
    }

    static final class Chunk {
        final Node node;
        final long signature;
        final List<Chunk> children;
        Chunk(Node node) {
            this.node = node; signature = fingerprint(node);
            children = node instanceof BulletList || node instanceof OrderedList || node instanceof ListItem || node instanceof BlockQuote
                ? chunks(MarkdownStream.children(node)) : Collections.emptyList();
        }
    }

    static final class Change {
        final int from;
        List<Chunk> chunks;
        String raw, preview, codeAppend;
        boolean codeNewline;
        boolean tableTrim;
        int codeRemove, tableRow;
        List<TableRow> rows;
        Change(int from, List<Chunk> chunks) { this.from = from; this.chunks = chunks; }
        static Change raw(String value) { Change change = new Change(0, null); change.raw = value; return change; }
    }

    static final class Update {
        final List<Change> changes = new ArrayList<>();
        final boolean finished;
        Update(boolean finished) { this.finished = finished; }
    }

    Update update(String source, boolean finished) {
        Update result = new Update(finished);
        if (finished) {
            complete(source, result);
            reset();
            return result;
        }
        if (source.equals(previous)) return result;
        if (!source.startsWith(previous)) reset();
        if (source.indexOf('\r', previous.length()) >= 0) lfOnly = false;
        previous = source;
        if (rawMode) { result.changes.add(Change.raw(source)); return result; }
        while (committed < source.length()) {
            Slice tail = new Slice(source, committed, source.length());
            if (code != null && !lfOnly) { code = null; lastParsed = 0; }
            if (!references && lfOnly && (code != null || startCode(tail, result))) {
                if (!code(tail, result)) return result;
                if (rawMode) return result;
                continue;
            }
            if (!references && !tableDisabled && (table != null || startTable(tail, result))) {
                if (table(tail, result)) return result;
                if (rawMode) return result;
                if (table == null && !tableDisabled) continue;
            }
            int growth = tail.length() - lastParsed;
            if (tail.length() > SMALL_TAIL && growth < Math.max(512, lastParsed / 8)) {
                Change change = new Change(blockCount, null);
                change.preview = tail.substring(lastParsed);
                result.changes.add(change);
                return result;
            }
            if (DEFINITION.matcher(tail).find()) {
                // Reference definitions can change earlier paragraphs. Retain their
                // document context, with geometric parsing for a large document.
                references = true; committed = blockCount = budget = 0; tail = new Slice(source, 0, source.length());
            }
            List<Node> nodes = children(parse(tail));
            try {
                int count = budget;
                for (Node node : nodes) count = checkBlock(node, count, 0);
                result.changes.add(new Change(blockCount, chunks(nodes)));
                lastParsed = tail.length();
                Node suffix = nodes.isEmpty() ? null : nodes.get(nodes.size() - 1);
                int suffixStart = suffix == null ? 0 : startOffset(tail, suffix);
                int headerEnd = tail.indexOf('\n', suffixStart);
                suffixTable = suffix instanceof TableBlock && headerEnd >= 0 && tail.indexOf('\n', headerEnd + 1) >= 0;
                suffixCodeShown = -1;
                if (suffix instanceof FencedCodeBlock && tail.indexOf('\n', startOffset(tail, suffix)) >= 0) {
                    String literal = ((FencedCodeBlock) suffix).getLiteral();
                    suffixCodeShown = literal.length() - (literal.endsWith("\n") ? 1 : 0);
                }
                if (!references && nodes.size() > 1) {
                    // An unfinished first line (e.g. a bare table pipe) can still
                    // join the preceding block. Keep that block until the line ends.
                    int lastStart = startOffset(tail, suffix);
                    int keep = tail.indexOf('\n', lastStart) >= 0 ? 1 : 2;
                    int freezeCount = nodes.size() - keep;
                    int cut = freezeCount > 0 ? startOffset(tail, nodes.get(freezeCount)) : 0;
                    if (cut > 0) {
                        for (int i = 0; i < freezeCount; i++) budget = checkBlock(nodes.get(i), budget, 0);
                        committed += cut; blockCount += freezeCount;
                        lastParsed = tail.length() - cut; tableDisabled = false;
                    }
                }
            } catch (Limit limit) { fallback(source, result); }
            return result;
        }
        // Consuming a closing fence/table can leave no suffix. Remove a stale preview.
        result.changes.add(new Change(blockCount, Collections.emptyList()));
        return result;
    }

    private void complete(String source, Update result) {
        result.changes.addAll(completed(parse(source), source).changes);
    }
    static Update completed(Node document, String source) {
        Update result = new Update(true); List<Node> nodes = children(document);
        try {
            int count = 0;
            for (Node node : nodes) count = checkBlock(node, count, 0);
            result.changes.add(new Change(0, chunks(nodes)));
        } catch (Limit limit) { result.changes.add(Change.raw(source)); }
        return result;
    }

    private void fallback(String source, Update result) {
        result.changes.clear(); result.changes.add(Change.raw(source)); rawMode = true;
        code = null; table = null;
    }

    private Node parse(String source) { parsedCharacters += source.length(); parseCalls++; return parser.parse(source); }
    private Node parse(Slice source) { return parse(source.toString()); }
    private void reset() {
        previous = ""; committed = blockCount = budget = lastParsed = 0;
        references = rawMode = tableDisabled = false; lfOnly = true; code = null; table = null;
        suffixCodeShown = -1; suffixTable = false;
    }

    private boolean startCode(Slice tail, Update result) {
        Matcher match = FENCE.matcher(tail);
        if (!match.find() || match.group(1).charAt(0) == '`' && match.group(2).contains("`")) return false;
        List<Node> nodes = children(parse(match.group()));
        if (nodes.size() != 1 || !(nodes.get(0) instanceof FencedCodeBlock)) return false;
        try { checkBlock(nodes.get(0), budget, 0); }
        catch (Limit limit) { return false; }
        if (suffixCodeShown < 0) result.changes.add(new Change(blockCount, chunks(nodes)));
        code = new CodeState(match.group(1), match.end());
        if (suffixCodeShown >= 0) code.shown += suffixCodeShown;
        suffixCodeShown = -1;
        return true;
    }

    private boolean code(Slice tail, Update result) {
        int close = -1, closeEnd = -1;
        while (code.scanned < tail.length()) {
            int newline = tail.indexOf('\n', code.scanned);
            if (newline < 0) break;
            if (closingFence(tail, code.scanned, newline, code.fence)) { close = code.scanned; closeEnd = newline + 1; break; }
            code.scanned = newline + 1;
        }
        int end = close >= 0 ? close : tail.length();
        // A delimiter at EOF may acquire more characters. Do not freeze it until
        // its newline arrives; do not display the candidate closing delimiter.
        if (close < 0 && closingFence(tail, code.scanned, tail.length(), code.fence)) end = code.scanned;
        int literalEnd = end;
        if (end > code.start && tail.charAt(end - 1) == '\n') end--;
        if (end > code.start && tail.charAt(end - 1) == '\r' && end < tail.length() && tail.charAt(end) == '\n') end--;
        Change change = new Change(blockCount, null);
        change.codeRemove = Math.max(0, code.shown - end);
        change.codeAppend = tail.substring(Math.min(code.shown, end), end).replace('\0', '\ufffd');
        change.codeNewline = literalEnd > code.start;
        result.changes.add(change); code.shown = end;
        if (close < 0) return false;
        freeze(tail.substring(0, closeEnd), result);
        code = null;
        return true;
    }

    private static boolean closingFence(Slice source, int start, int end, String fence) {
        int i = start, spaces = 0;
        while (i < end && source.charAt(i) == ' ' && spaces < 3) { i++; spaces++; }
        int begin = i;
        while (i < end && source.charAt(i) == fence.charAt(0)) i++;
        if (i - begin < fence.length()) return false;
        while (i < end && (source.charAt(i) == ' ' || source.charAt(i) == '\t' || source.charAt(i) == '\r')) i++;
        return i == end;
    }

    private boolean startTable(Slice tail, Update result) {
        int first = tail.indexOf('\n'), second = first < 0 ? -1 : tail.indexOf('\n', first + 1);
        if (first < 0 || second < 0 || second > SMALL_TAIL || tail.substring(0, first).indexOf('|') < 0) return false;
        String separator = tail.substring(first + 1, second).trim();
        if (separator.isEmpty() || !separator.matches("[| :\\-]+")) return false;
        String header = tail.substring(0, second + 1);
        List<Node> nodes = children(parse(header));
        if (nodes.size() != 1 || !(nodes.get(0) instanceof TableBlock)) return false;
        try { checkBlock(nodes.get(0), budget, 0); }
        catch (Limit limit) { return false; }
        if (!suffixTable) result.changes.add(new Change(blockCount, chunks(nodes)));
        suffixTable = false;
        table = new TableState(header, children(tableRows(nodes.get(0)).get(0)).size());
        return true;
    }

    /** Returns true while the table owns the suffix; false after a close or ambiguity. */
    private boolean table(Slice tail, Update result) {
        while (table.offset < tail.length()) {
            int newline = tail.indexOf('\n', table.offset);
            int end = newline < 0 ? tail.length() : newline;
            String line = tail.substring(table.offset, end);
            if (line.trim().isEmpty() && newline >= 0) {
                freeze(tail.substring(0, newline + 1), result); table = null; return false;
            }
            if (line.length() > SMALL_TAIL || DEFINITION.matcher(line).find()) {
                table = null; tableDisabled = true; lastParsed = 0; return false;
            }
            List<Node> nodes = children(parse(table.header + line + (newline < 0 ? "" : "\n")));
            List<TableRow> rows = nodes.size() == 1 && nodes.get(0) instanceof TableBlock ? tableRows(nodes.get(0)) : Collections.emptyList();
            if (rows.size() != 2) {
                if (newline < 0 && !nodes.isEmpty() && nodes.get(0) instanceof TableBlock) {
                    try {
                        int count = budget + 1 + table.rows * table.columns;
                        for (int i = 1; i < nodes.size(); i++) count = checkBlock(nodes.get(i), count, 0);
                        Change trim = new Change(blockCount, null); trim.rows = Collections.emptyList(); trim.tableRow = table.rows; trim.tableTrim = true;
                        result.changes.add(trim);
                        result.changes.add(new Change(blockCount + 1, chunks(nodes.subList(1, nodes.size())))); table.extra = nodes.size() > 1;
                    } catch (Limit limit) { fallback(previous, result); }
                    return true;
                }
                table = null; tableDisabled = true; lastParsed = 0; return false;
            }
            int cells = table.rows * table.columns + table.columns;
            if (cells > 1600 || budget + 1 + cells > 1600) { fallback(previous, result); return true; }
            if (table.extra) { result.changes.add(new Change(blockCount + 1, Collections.emptyList())); table.extra = false; }
            Change change = new Change(blockCount, null); change.tableRow = table.rows;
            change.rows = Collections.singletonList(rows.get(1)); result.changes.add(change);
            if (newline < 0) return true;
            table.rows++; table.offset = newline + 1;
        }
        return true;
    }

    private void freeze(String source, Update result) {
        List<Node> nodes = children(parse(source));
        try {
            for (Node node : nodes) budget = checkBlock(node, budget, 0);
            result.changes.add(new Change(blockCount, chunks(nodes)));
            committed += source.length(); blockCount += nodes.size(); lastParsed = 0; tableDisabled = false;
            suffixCodeShown = -1; suffixTable = false;
        } catch (Limit limit) { fallback(previous, result); }
    }

    private static final class CodeState {
        final String fence;
        final int start;
        int scanned, shown;
        CodeState(String fence, int start) { this.fence = fence; this.start = scanned = shown = start; }
    }
    private static final class TableState {
        final String header;
        int offset, rows = 1, columns;
        boolean extra;
        TableState(String header, int columns) {
            this.header = header; this.columns = columns; offset = header.length();
        }
    }

    static List<Node> children(Node parent) {
        List<Node> result = new ArrayList<>();
        for (Node node = parent.getFirstChild(); node != null; node = node.getNext()) result.add(node);
        return result;
    }
    private static List<Chunk> chunks(List<Node> nodes) {
        List<Chunk> result = new ArrayList<>(); for (Node node : nodes) result.add(new Chunk(node)); return result;
    }
    static List<TableRow> tableRows(Node node) {
        List<TableRow> rows = new ArrayList<>();
        for (Node section = node.getFirstChild(); section != null; section = section.getNext())
            for (Node row = section.getFirstChild(); row != null; row = row.getNext()) if (row instanceof TableRow) rows.add((TableRow) row);
        return rows;
    }
    private static int startOffset(Slice source, Node node) {
        if (node.getSourceSpans().isEmpty()) return 0;
        int line = node.getSourceSpans().get(0).getLineIndex(), offset = 0;
        for (int i = 0; i < line; i++) { int newline = source.indexOf('\n', offset); if (newline < 0) return 0; offset = newline + 1; }
        return offset;
    }

    // Keep the existing native renderer's budgets, including its depth limits.
    private static int checkBlock(Node node, int count, int depth) {
        if (++count > 1200 || depth > 24) throw new Limit();
        if (node instanceof TableBlock) {
            List<TableRow> rows = tableRows(node); int columns = rows.isEmpty() ? 0 : children(rows.get(0)).size();
            if (columns > 32 || rows.size() * columns > 1600) throw new Limit();
            count += rows.size() * columns;
            if (count > 1600) throw new Limit();
            for (TableRow row : rows) for (Node cell : children(row)) checkInline(cell, 0);
        } else if (node instanceof BulletList || node instanceof OrderedList) {
            if (depth >= 24) throw new Limit();
            for (Node item = node.getFirstChild(); item != null; item = item.getNext())
                for (Node child = item.getFirstChild(); child != null; child = child.getNext()) count = checkBlock(child, count, depth + 1);
        } else if (node instanceof BlockQuote) {
            if (depth >= 24) throw new Limit();
            for (Node child = node.getFirstChild(); child != null; child = child.getNext()) count = checkBlock(child, count, depth + 1);
        } else checkInline(node, 0);
        return count;
    }
    private static void checkInline(Node parent, int depth) {
        if (depth > 64) throw new Limit();
        for (Node child = parent.getFirstChild(); child != null; child = child.getNext()) if (!(child instanceof Text || child instanceof Code || child instanceof SoftLineBreak
            || child instanceof HardLineBreak || child instanceof HtmlInline)) checkInline(child, depth + 1);
    }
    static long fingerprint(Node node) {
        long value = hash(0xcbf29ce484222325L, node.getClass().getName());
        if (node instanceof MarkdownMath.Formula) value = hash(value, ((MarkdownMath.Formula) node).source());
        else if (node instanceof Text) value = hash(value, ((Text) node).getLiteral());
        else if (node instanceof Code) value = hash(value, ((Code) node).getLiteral());
        else if (node instanceof FencedCodeBlock) { value = hash(value, ((FencedCodeBlock) node).getInfo()); value = hash(value, ((FencedCodeBlock) node).getLiteral()); }
        else if (node instanceof IndentedCodeBlock) value = hash(value, ((IndentedCodeBlock) node).getLiteral());
        else if (node instanceof HtmlBlock) value = hash(value, ((HtmlBlock) node).getLiteral());
        else if (node instanceof HtmlInline) value = hash(value, ((HtmlInline) node).getLiteral());
        else if (node instanceof Link) { value = hash(value, ((Link) node).getDestination()); value = hash(value, ((Link) node).getTitle()); }
        else if (node instanceof Image) { value = hash(value, ((Image) node).getDestination()); value = hash(value, ((Image) node).getTitle()); }
        else if (node instanceof Heading) value ^= ((Heading) node).getLevel();
        else if (node instanceof OrderedList) value ^= ((OrderedList) node).getStartNumber();
        else if (node instanceof TableCell) value = hash(value, ((TableCell) node).isHeader() + ":" + ((TableCell) node).getAlignment());
        for (Node child = node.getFirstChild(); child != null; child = child.getNext()) value = (value ^ fingerprint(child)) * 0x100000001b3L;
        return value;
    }
    private static long hash(long seed, String value) {
        long result = seed; if (value == null) return result;
        for (int i = 0; i < value.length(); i++) result = (result ^ value.charAt(i)) * 0x100000001b3L;
        return (result ^ 0xff) * 0x100000001b3L;
    }
    private static final class Limit extends RuntimeException { }

    /** Java substring copies its contents. Keep a range into the authoritative
     * snapshot, allocating only when a suffix really needs parsing or painting. */
    private static final class Slice implements CharSequence {
        final String source;
        final int start, end;
        Slice(String source, int start, int end) { this.source = source; this.start = start; this.end = end; }
        public int length() { return end - start; }
        public char charAt(int index) { return source.charAt(start + index); }
        public CharSequence subSequence(int from, int to) { return new Slice(source, start + from, start + to); }
        public String toString() { return source.substring(start, end); }
        int indexOf(char value) { return indexOf(value, 0); }
        int indexOf(char value, int from) {
            int found = source.indexOf(value, start + from); return found < 0 || found >= end ? -1 : found - start;
        }
        String substring(int from) { return source.substring(start + from, end); }
        String substring(int from, int to) { return source.substring(start + from, start + to); }
    }
}
