package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class LongPasteTest {
    @Test public void usesTheDesktopThreshold() {
        assertEquals(5000, LongPaste.MIN_CHARS);
        assertFalse(LongPaste.shouldAttach("a".repeat(LongPaste.MIN_CHARS - 1)));
        assertTrue(LongPaste.shouldAttach("a".repeat(LongPaste.MIN_CHARS)));
        assertFalse(LongPaste.shouldAttach("   \n\t  "));
        assertFalse(LongPaste.shouldAttach(null));
    }

    @Test public void noticeReportsTheCharacterCount() {
        String english = LongPaste.notice(5000, false);
        assertTrue(english.contains(".txt"));
        assertTrue(english.contains("5000 characters"));
        String chinese = LongPaste.notice(5000, true);
        assertTrue(chinese.contains(".txt"));
        assertTrue(chinese.contains("5000 个字符"));
    }
}
