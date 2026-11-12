package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class MarkdownTablesTest {
    @Test public void gfmTableCanInterruptAParagraphWithoutChangingOtherText() {
        String source = "优先级建议\n"
            + "| 优先级 | 来源 | 当前情况 |\n"
            + "|---|---|---|\n"
            + "| P0 | billion-context | 已 pair-safe |";
        assertEquals("优先级建议\n\n"
            + "| 优先级 | 来源 | 当前情况 |\n"
            + "|---|---|---|\n"
            + "| P0 | billion-context | 已 pair-safe |", MarkdownTables.normalize(source));
        assertEquals("short\n\nA | B\n- | -\n1 | 2",
            MarkdownTables.normalize("short\nA | B\n- | -\n1 | 2"));
    }

    @Test public void codeAndInvalidCandidatesStayUnchanged() {
        String fenced = "```text\nparagraph\n| A | B |\n|---|---|\n```";
        assertEquals(fenced, MarkdownTables.normalize(fenced));
        String escaped = "paragraph a\\|b\nA | B\n---|---|---";
        assertEquals(escaped, MarkdownTables.normalize(escaped));
        String mismatch = "paragraph\n| A | B |\n|---|\n| 1 | 2 |";
        assertEquals(mismatch, MarkdownTables.normalize(mismatch));
        String list = "paragraph\n- item | A |\n--- | ---";
        assertEquals(list, MarkdownTables.normalize(list));
    }

    @Test public void existingBlankLinesAndCrlfStayIntact() {
        String separated = "paragraph\n\n| A |\n|---|";
        assertSame(separated, MarkdownTables.normalize(separated));
        assertEquals("paragraph\r\n\r\n| A | B |\r\n|---|---|\r\n| 1 | 2 |",
            MarkdownTables.normalize("paragraph\r\n| A | B |\r\n|---|---|\r\n| 1 | 2 |"));
    }
}
