package app.camellia.mobile;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.commonmark.ext.gfm.tables.*;
import org.commonmark.node.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class MarkdownStreamTest {
    private static final class Display {
        final List<Node> blocks = new ArrayList<>();
        String raw;
        void apply(MarkdownStream.Update update) {
            for (MarkdownStream.Change change : update.changes) {
                if (change.raw != null) { raw = change.raw; blocks.clear(); }
                else if (change.chunks != null) {
                    raw = null;
                    assertTrue("patch must start within the displayed blocks", change.from <= blocks.size());
                    while (blocks.size() > change.from) blocks.remove(blocks.size() - 1);
                    for (MarkdownStream.Chunk chunk : change.chunks) blocks.add(chunk.node);
                } else if (change.codeAppend != null) {
                    FencedCodeBlock code = (FencedCodeBlock) blocks.get(change.from);
                    String literal = code.getLiteral(); String text = literal.endsWith("\n") ? literal.substring(0, literal.length() - 1) : literal;
                    text = text.substring(0, text.length() - change.codeRemove) + change.codeAppend;
                    code.setLiteral(text + (change.codeNewline ? "\n" : ""));
                } else if (change.rows != null) {
                    Node table = blocks.get(change.from); TableBody body;
                    if (table.getLastChild() instanceof TableBody) body = (TableBody) table.getLastChild();
                    else { body = new TableBody(); table.appendChild(body); }
                    List<TableRow> rows = MarkdownStream.tableRows(table);
                    if (change.tableTrim) {
                        for (int i = change.tableRow; i < rows.size(); i++) rows.get(i).unlink();
                        if (body.getFirstChild() == null) body.unlink();
                    }
                    for (int i = 0; i < change.rows.size(); i++) {
                        TableRow row = change.rows.get(i); row.unlink(); int index = change.tableRow + i;
                        if (index < rows.size()) { rows.get(index).insertBefore(row); rows.get(index).unlink(); }
                        else body.appendChild(row);
                    }
                }
            }
        }
        void matches(String source) {
            List<Node> expected = MarkdownStream.children(MarkdownStream.newParser().parse(source));
            assertNull("unexpected plaintext fallback", raw);
            assertEquals("source: " + source, expected.size(), blocks.size());
            for (int i = 0; i < expected.size(); i++) assertEquals("block " + i + " source: " + source + " expected " + tree(expected.get(i)) + " actual " + tree(blocks.get(i)),
                MarkdownStream.fingerprint(expected.get(i)), MarkdownStream.fingerprint(blocks.get(i)));
        }
        String tree(Node node) { String result = node.toString() + (node instanceof TableCell ? ((TableCell) node).getAlignment() + ":" + ((TableCell) node).isHeader() : "") + "["; for (Node child : MarkdownStream.children(node)) result += tree(child); return result + "]"; }
    }

    @Test public void smallPrefixesKeepCommonMarkBlockSemantics() {
        String[] sources = {
            "# Title\n\nA **bold** paragraph with _emphasis_ and ~~strike~~.\n\nNext [link](https://example.com).",
            "- first\n\n  continued paragraph\n\n  - nested\n- second\n\nAfter list\n\n    indented\n\n    continued code\n\nEnd",
            "> quote\n>\n> - item\n> - other\n\nA heading\n---\n\nA rule\n\n***\n",
            "Before\n\n````java\nfirst\n``` inside\n\0 emoji 😀\n````\n\nAfter\n\n~~~text\nlast\n~~~\n",
            "| Left | Right |\n| :--- | ---: |\n| **one** | `two` |\n| three | four |\n\nAfter",
            "[early]: https://example.com/early\n\n[early]\n\n[late]\n\n[late]: https://example.com/late\n",
            "<script>\nline\n\n</script>\n\nLiteral ![image](https://example.com/image)\n\n```\nunfinished",
            "中文\r\n\r\n```java\r\ncode\r\n```\r\n\r\nEnd"
        };
        for (String source : sources) for (int step : new int[] {1, 7, 37}) {
            MarkdownStream stream = new MarkdownStream(); Display display = new Display();
            for (int end = step; end < source.length(); end += step) {
                String prefix = source.substring(0, end); display.apply(stream.update(prefix, false)); display.matches(prefix);
            }
            display.apply(stream.update(source, false)); display.matches(source);
            display.apply(stream.update(source, true)); display.matches(source);
        }
    }

    @Test public void replacementAndShorteningDiscardCommittedSuffixState() {
        MarkdownStream stream = new MarkdownStream(); Display display = new Display();
        display.apply(stream.update("Old paragraph\n\n```java\nold code", false));
        display.apply(stream.update("New **answer**\n\n| A |\n| --- |\n| B |", false));
        display.matches("New **answer**\n\n| A |\n| --- |\n| B |");
        display.apply(stream.update("Short", false)); display.matches("Short");
        display.apply(stream.update("", true)); display.matches("");
    }

    @Test public void lateDefinitionsReconcileAlreadyDisplayedLinks() {
        MarkdownStream stream = new MarkdownStream(); Display display = new Display();
        String prefix = "[late]\n\nAnother block\n\nEnd\n\n";
        display.apply(stream.update(prefix, false));
        String source = prefix + "[late]: https://example.com/late\n";
        display.apply(stream.update(source, false)); display.matches(source);
        Link link = (Link) display.blocks.get(0).getFirstChild(); assertEquals("https://example.com/late", link.getDestination());
    }

    @Test public void rendererLimitsSwitchToOnePlaintextBinding() {
        MarkdownStream stream = new MarkdownStream(); Display display = new Display();
        String source = "- item\n".repeat(1400);
        display.apply(stream.update(source, false)); assertEquals(source, display.raw);
        long parsed = stream.parsedCharacters;
        display.apply(stream.update(source + "tail", false)); assertEquals(source + "tail", display.raw);
        assertEquals(parsed, stream.parsedCharacters);
        display.apply(stream.update(source + "tail", true)); assertEquals(source + "tail", display.raw);
    }

    @Test public void longRepliesBoundStreamingParseVolume() {
        benchmark("paragraphs", "A paragraph with **bold** text and a [link](https://example.com).\n\n".repeat(500));
        benchmark("code", "Introduction\n\n```java\n" + "System.out.println(\"hello\");\n".repeat(5000) + "```\n\nDone");
        benchmark("table", "| A | B |\n| --- | --- |\n" + "| **value** | `cell` |\n".repeat(750) + "\nDone");
        benchmark("long-paragraph", "long **unfinished paragraph** ".repeat(4500));
        benchmark("long-list", "- list item with **formatting**\n".repeat(1100));
    }

    @Test public void deeplyNestedEmptyContainersKeepThePlaintextFallback() {
        String source = ">".repeat(25) + "\n";
        MarkdownStream stream = new MarkdownStream(); Display display = new Display();
        display.apply(stream.update(source, false)); assertEquals(source, display.raw);
        display.apply(stream.update(source, true)); assertEquals(source, display.raw);
        display.apply(stream.update("Restored **format**", true)); display.matches("Restored **format**");
    }

    private void benchmark(String name, String source) {
        MarkdownStream stream = new MarkdownStream(); long baseline = source.length();
        for (int end = 200; end < source.length(); end += 200) { stream.update(source.substring(0, end), false); baseline += end; }
        stream.update(source, false); baseline += source.length();
        stream.update(source, true);
        System.out.printf(Locale.ROOT, "markdown-metric %s chars=%d baseline=%d parsed=%d calls=%d%n", name, source.length(), baseline, stream.parsedCharacters, stream.parseCalls);
        assertTrue(name + " parse volume " + stream.parsedCharacters + " vs " + baseline, stream.parsedCharacters < baseline / 5);
    }
}
