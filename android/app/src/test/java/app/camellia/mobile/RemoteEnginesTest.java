package app.camellia.mobile;

import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public class RemoteEnginesTest {
    @Test public void includesGrokOnlyWhenAdvertised() {
        assertEquals(List.of("grok", "codex"), RemoteEngines.available(List.of("grok", "codex", "grok", "unknown")));
        assertEquals("Grok Build", RemoteEngines.label("grok"));
        assertFalse(RemoteEngines.available(null).contains("grok"));
        assertTrue(RemoteEngines.available(List.of()).isEmpty());
        assertEquals(List.of("dsh"), RemoteEngines.available(List.of("dsh")));
    }
}
