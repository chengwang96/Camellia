package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

public class ChatNotificationEventsTest {
    private JSONObject conversation(long reply) throws Exception { return new JSONObject().put("id", "chat").put("lastReplyAt", reply); }
    private JSONArray terminal(long seq, String state) throws Exception {
        return new JSONArray().put(new JSONObject().put("seq", seq).put("role", "assistant")
            .put("turnDetails", new JSONObject().put("state", state)));
    }
    @Test public void historyIsQuietAndNewCompletionEmitsOnceAcrossRepeatedAndStaleSnapshots() throws Exception {
        ChatNotificationEvents events = new ChatNotificationEvents("{}");
        assertTrue(events.conversation("host/chat", conversation(10), null, terminal(2, "complete")).isEmpty());
        assertEquals(List.of("reply"), events.conversation("host/chat", conversation(20), null, terminal(4, "complete")));
        assertTrue(events.conversation("host/chat", conversation(20), null, terminal(4, "complete")).isEmpty());
        assertTrue(events.conversation("host/chat", conversation(10), null, terminal(2, "complete")).isEmpty());
        assertTrue(events.conversation("host/chat", conversation(20), null, terminal(4, "complete")).isEmpty());
    }
    @Test public void failuresAreNotSuccessfulRepliesAndDelayedReplyMetadataDoesNotAlertTwice() throws Exception {
        ChatNotificationEvents events = new ChatNotificationEvents("{}");
        events.conversation("chat", conversation(10), new JSONObject(), terminal(2, "complete"));
        assertEquals(List.of("error"), events.conversation("chat", conversation(10), null, terminal(4, "error")));
        assertTrue(events.conversation("chat", conversation(20), null, terminal(4, "error")).isEmpty());
        assertTrue(events.conversation("chat", conversation(30), null, terminal(6, "stopped")).isEmpty());
        assertEquals(List.of("reply"), events.conversation("chat", conversation(40), null, terminal(8, "complete")));
    }
    @Test public void legacyCompletionAndListToDetailTransitionsDoNotDuplicateOrReplayHistory() throws Exception {
        ChatNotificationEvents events = new ChatNotificationEvents("{}");
        assertTrue(events.conversation("chat", conversation(10), null, null).isEmpty());
        assertTrue(events.conversation("chat", conversation(10), null, terminal(2, "error")).isEmpty());
        assertEquals(List.of("reply"), events.conversation("chat", conversation(20), null, null));
        assertTrue(events.conversation("chat", conversation(20), null, terminal(4, "complete")).isEmpty());
        assertTrue(events.conversation("legacy", conversation(0), null, new JSONArray()).isEmpty());
        assertEquals(List.of("reply"), events.conversation("legacy", conversation(0), null, terminal(2, "complete")));
    }
    @Test public void approvalsPersistAcrossRecreationAndRemainScopedToComputerAndRun() throws Exception {
        ChatNotificationEvents events = new ChatNotificationEvents("{}");
        JSONObject request = new JSONObject().put("requestId", "a").put("runId", 1);
        JSONObject live = new JSONObject().put("approvals", new JSONArray().put(request));
        assertEquals(List.of("approval"), events.conversation("host-a/chat", conversation(0), live, new JSONArray()));
        events = new ChatNotificationEvents(events.serialize());
        assertTrue(events.conversation("host-a/chat", conversation(0), live, new JSONArray()).isEmpty());
        assertEquals(List.of("approval"), events.conversation("host-b/chat", conversation(0), live, new JSONArray()));
        request.put("runId", 2);
        assertEquals(List.of("approval"), events.conversation("host-a/chat", conversation(0), live, new JSONArray()));
    }
    @Test public void newSessionBaselinesUnseenOfflineHistory() throws Exception {
        ChatNotificationEvents first = new ChatNotificationEvents("{}");
        first.conversation("chat", conversation(10), null, terminal(2, "complete"));
        ChatNotificationEvents restarted = new ChatNotificationEvents(first.serialize());
        assertTrue(restarted.conversation("chat", conversation(999), null, terminal(200, "error")).isEmpty());
        assertEquals(List.of("reply"), restarted.conversation("chat", conversation(1000), null, terminal(202, "complete")));
    }
    @Test public void discussionBaselinesPastDeliveriesAndDeduplicatesLaterEvents() throws Exception {
        ChatNotificationEvents events = new ChatNotificationEvents("{}");
        JSONObject delivery = new JSONObject().put("id", "d").put("runId", 1).put("status", "completed");
        JSONObject group = new JSONObject().put("deliveries", new JSONArray().put(delivery));
        assertTrue(events.discussion("group", group).isEmpty());
        delivery.put("runId", 2).put("status", "running");
        assertTrue(events.discussion("group", group).isEmpty());
        delivery.put("status", "failed");
        assertEquals(List.of("error"), events.discussion("group", group));
        assertTrue(events.discussion("group", group).isEmpty());
        delivery.put("runId", 3).put("status", "completed");
        assertEquals(List.of("reply"), events.discussion("group", group));
        assertFalse(events.claim("group", "reply", "d:3:completed"));
        assertFalse(new ChatNotificationEvents(events.serialize()).claim("group", "reply", "d:3:completed"));
    }
}
