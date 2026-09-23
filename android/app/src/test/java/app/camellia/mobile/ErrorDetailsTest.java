package app.camellia.mobile;

import java.io.IOException;
import org.junit.Test;
import static org.junit.Assert.*;

public class ErrorDetailsTest {
    @Test public void preservesCauseChainAndPlainMessages() {
        Exception error = new IOException("saving failed", new IllegalStateException("disk full"));
        String detail = ErrorDetails.describe(error);
        assertTrue(detail.contains("IOException: saving failed"));
        assertTrue(detail.contains("IllegalStateException: disk full"));
        assertEquals("plain failure", ErrorDetails.withSummary("plain failure", null));
    }

    @Test public void summaryKeepsFallbackAndDetailOnce() {
        Exception error = new IOException("connection reset");
        String summary = ErrorDetails.withSummary("Could not load computers.", error);
        assertTrue(summary.startsWith("Could not load computers."));
        assertEquals(1, summary.split("connection reset", -1).length - 1);
        assertTrue(ErrorDetails.withSummary("IO detail", new IOException("IO detail")).contains("IO detail"));
    }

    @Test public void capsErrorText() {
        String detail = ErrorDetails.describe(new IOException("x".repeat(ErrorDetails.limit("").length() + 8192)));
        assertTrue(detail.length() < 8 * 1024 + 16);
        assertTrue(detail.endsWith("…"));
    }
}
