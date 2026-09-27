package app.camellia.mobile;

import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public class RemoteEnginesTest {
    @Test public void includesPiOnlyWhenAdvertised() {
        assertEquals(List.of("pi", "codex"), RemoteEngines.available(List.of("pi", "codex", "pi", "unknown")));
        assertEquals("Pi", RemoteEngines.label("pi"));
        assertFalse(RemoteEngines.available(null).contains("pi"));
        assertTrue(RemoteEngines.available(List.of()).isEmpty());
        assertEquals(List.of("dsh"), RemoteEngines.available(List.of("dsh")));
    }
}
