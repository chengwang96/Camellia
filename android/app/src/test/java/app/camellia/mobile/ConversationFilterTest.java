package app.camellia.mobile;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import org.json.JSONObject;

public class ConversationFilterTest {
    @Test public void allKeepsEveryActivity() {
        assertTrue(MainActivity.matchesConversationFilter("all", "idle"));
        assertTrue(MainActivity.matchesConversationFilter("all", "running"));
        assertTrue(MainActivity.matchesConversationFilter("all", ""));
    }

    @Test public void runningKeepsOnlyLiveReplies() {
        assertTrue(MainActivity.matchesConversationFilter("running", "running"));
        assertFalse(MainActivity.matchesConversationFilter("running", "permission"));
        assertFalse(MainActivity.matchesConversationFilter("running", "idle"));
    }

    @Test public void waitingIncludesPermissionsAndQuestions() {
        assertTrue(MainActivity.matchesConversationFilter("waiting", "permission"));
        assertTrue(MainActivity.matchesConversationFilter("waiting", "question"));
        assertFalse(MainActivity.matchesConversationFilter("waiting", "running"));
    }

    @Test public void legacyFilesFilterFallsBackToAll() throws Exception {
        assertTrue(MainActivity.matchesConversationFilter("files", new JSONObject()));
    }

    @Test public void archivedKeepOnlyRowsWithArchiveTimestamp() throws Exception {
        assertTrue(MainActivity.matchesConversationFilter("archived", new JSONObject().put("archivedAt", 10)));
        assertFalse(MainActivity.matchesConversationFilter("archived", new JSONObject()));
    }
}
