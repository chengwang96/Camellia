package app.camellia.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class WorkSummaryPriorityTest {
    @Test public void followsTheDocumentedPriority() {
        assertEquals("approvals", MainActivity.workPriority(1, true, true, 2, 3));
        assertEquals("failed", MainActivity.workPriority(0, true, true, 2, 3));
        assertEquals("automation", MainActivity.workPriority(0, false, true, 2, 3));
        assertEquals("background", MainActivity.workPriority(0, false, false, 2, 3));
        assertEquals("queue", MainActivity.workPriority(0, false, false, 0, 3));
        assertEquals("none", MainActivity.workPriority(0, false, false, 0, 0));
    }
}
