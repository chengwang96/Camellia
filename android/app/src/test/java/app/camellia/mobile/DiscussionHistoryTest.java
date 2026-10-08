package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class DiscussionHistoryTest {
    private JSONObject message(long seq, String request, String text) throws Exception {
        return new JSONObject().put("seq", seq).put("role", "user").put("requestId", request).put("text", text);
    }
    private JSONObject delivery(String id, String request, String status) throws Exception {
        return new JSONObject().put("id", id).put("requestId", request).put("status", status).put("partialText", "")
            .put("tools", new JSONArray().put(new JSONObject().put("inputText", "input").put("output", "output")));
    }
    private JSONObject request(String id, String mode) throws Exception { return new JSONObject().put("id", id).put("mode", mode); }
    private JSONObject page(long first, int count) throws Exception {
        JSONArray messages = new JSONArray(), deliveries = new JSONArray(), requests = new JSONArray();
        for (long seq = first; seq < first + count; seq++) {
            String id = "request-" + seq;
            messages.put(message(seq, id, "Message " + seq)); deliveries.put(delivery("delivery-" + seq, id, "completed")); requests.put(request(id, "parallel"));
        }
        return new JSONObject().put("id", "group").put("title", "Group").put("messages", messages).put("deliveries", deliveries).put("requests", requests);
    }
    private void verifyCounters(DiscussionHistory history) {
        long bytes = 0;
        for (JSONObject row : history.messages.values()) bytes += DiscussionHistory.weight(row);
        for (JSONObject row : history.deliveries.values()) bytes += DiscussionHistory.weight(row);
        for (JSONObject row : history.requests.values()) bytes += DiscussionHistory.weight(row);
        assertEquals(bytes, history.estimatedBytes());
        assertTrue(history.historyMessages() <= DiscussionHistory.MAX_MESSAGES);
        assertTrue(history.historyBytes() <= DiscussionHistory.MAX_BYTES);
    }

    @Test public void repeatedPagesAndLiveUpdatesHaveABoundedWindow() throws Exception {
        DiscussionHistory history = new DiscussionHistory(); history.merge(page(921, 80), false);
        for (long first = 841; first > 0; first -= 80) history.merge(page(first, 80), true);
        assertEquals(600, history.messages.size()); assertEquals(Long.valueOf(401), history.messages.firstKey());
        assertEquals(600, history.deliveries.size()); assertEquals(600, history.requests.size()); assertTrue(history.limited());
        for (int round = 0; round < 20; round++) { history.merge(page(921, 80), false); verifyCounters(history); }
        for (long seq = 1001; seq <= 1400; seq += 20) { history.merge(page(seq, 20), false); verifyCounters(history); }
        assertEquals(600, history.messages.size()); assertEquals(600, history.deliveries.size()); assertEquals(600, history.requests.size());
        assertFalse(history.requests.containsKey("request-401")); assertFalse(history.deliveries.containsKey("delivery-401"));
    }

    @Test public void toolsAndAttachmentsConsumeTheSameByteBudget() throws Exception {
        DiscussionHistory history = new DiscussionHistory(); JSONObject page = page(1, 20);
        for (int i = 0; i < 20; i++) {
            page.getJSONArray("messages").getJSONObject(i).put("attachments", new JSONArray().put(new JSONObject().put("name", "attachment".repeat(1000))));
            page.getJSONArray("deliveries").getJSONObject(i).getJSONArray("tools").getJSONObject(0).put("output", "x".repeat(150000));
        }
        history.merge(page, false); verifyCounters(history);
        assertTrue(history.limited()); assertTrue(history.messages.size() < 20); assertTrue(history.messages.size() > 0);
        assertEquals(history.messages.size(), history.requests.size()); assertEquals(history.messages.size(), history.deliveries.size());
        assertFalse(history.messages.containsKey(1L));
    }

    @Test public void wholeRequestsAreEvictedEvenWhenRepliesInterleave() throws Exception {
        DiscussionHistory history = new DiscussionHistory(); JSONObject page = page(1, 601);
        page.getJSONArray("messages").put(new JSONObject().put("seq", 602).put("requestId", "request-1").put("deliveryId", "delivery-1").put("role", "assistant").put("text", "Late answer"));
        history.merge(page, false); verifyCounters(history);
        assertEquals(600, history.messages.size()); assertFalse(history.messages.containsKey(1L)); assertFalse(history.messages.containsKey(602L));
        assertFalse(history.deliveries.containsKey("delivery-1")); assertFalse(history.requests.containsKey("request-1"));
    }

    @Test public void currentWorkApprovalsAndSerialFailuresSurviveTrimming() throws Exception {
        DiscussionHistory history = new DiscussionHistory(); JSONObject page = page(1, 604);
        page.getJSONArray("deliveries").getJSONObject(0).put("status", "running");
        page.getJSONArray("deliveries").getJSONObject(1).put("status", "failed"); page.getJSONArray("requests").getJSONObject(1).put("mode", "serial");
        page.getJSONArray("deliveries").getJSONObject(2).put("status", "interrupted");
        page.put("pendingApprovals", new JSONArray().put(new JSONObject().put("deliveryId", "delivery-3")));
        history.merge(page, false); verifyCounters(history);
        assertEquals(603, history.messages.size()); assertEquals(600, history.historyMessages());
        for (long seq = 1; seq <= 3; seq++) assertTrue(history.messages.containsKey(seq));
        assertFalse(history.messages.containsKey(4L));
        assertTrue(history.protectedDelivery("delivery-1")); assertTrue(history.protectedDelivery("delivery-2")); assertTrue(history.protectedDelivery("delivery-3"));
        JSONObject current = page(1, 604); history.merge(current, false); verifyCounters(history);
        assertEquals(600, history.messages.size()); assertFalse(history.messages.containsKey(1L)); assertFalse(history.messages.containsKey(2L));
        assertFalse(history.protectedDelivery("delivery-1"));
    }

    @Test public void stalePagesCannotRegressLiveWorkAndMissingWorkIsRetired() throws Exception {
        DiscussionHistory history = new DiscussionHistory(); JSONObject current = page(1, 1);
        current.getJSONArray("deliveries").getJSONObject(0).put("status", "running").put("partialText", "Newest"); history.merge(current, false);
        JSONObject stale = page(1, 1); stale.getJSONArray("deliveries").getJSONObject(0).put("status", "queued").put("partialText", "Stale");
        history.merge(stale, true); assertEquals("Newest", history.deliveries.get("delivery-1").optString("partialText"));
        history.merge(page(2, 1), false); assertFalse(history.deliveries.containsKey("delivery-1"));
        history.merge(stale, true); assertFalse(history.deliveries.containsKey("delivery-1")); verifyCounters(history);
    }

    @Test public void metadataDoesNotKeepEvictedArraysAndReplacementCountersStayExact() throws Exception {
        DiscussionHistory history = new DiscussionHistory(); JSONObject incoming = page(1, 2);
        history.merge(incoming, false); long original = history.estimatedBytes();
        assertFalse(history.group.has("messages")); assertFalse(history.group.has("requests")); assertEquals(0, history.group.getJSONArray("deliveries").length());
        incoming.getJSONArray("messages").getJSONObject(1).put("text", "x".repeat(100)); history.merge(incoming, false);
        assertTrue(history.estimatedBytes() > original); verifyCounters(history);
        for (int round = 0; round < 100; round++) { history.merge(incoming, false); verifyCounters(history); }
        history.clear(); assertEquals(0, history.estimatedBytes()); assertEquals(0, history.historyBytes()); assertEquals(0, history.historyMessages());
        assertFalse(history.limited()); assertNull(history.group); assertTrue(history.messages.isEmpty()); assertTrue(history.deliveries.isEmpty()); assertTrue(history.requests.isEmpty());
        history.merge(page(1000, 1), false); verifyCounters(history); assertEquals(1, history.messages.size());
    }

    @Test public void oversizedCompletedRequestIsDroppedAndNoFullJsonSerializationIsNeeded() throws Exception {
        JSONObject huge = new JSONObject() {
            @Override public String toString() { throw new AssertionError("History must not serialize records for weighing"); }
        };
        huge.put("seq", 1).put("requestId", "huge").put("text", "x".repeat((int) DiscussionHistory.MAX_BYTES));
        DiscussionHistory history = new DiscussionHistory();
        history.merge(new JSONObject().put("messages", new JSONArray().put(huge)).put("requests", new JSONArray().put(request("huge", "parallel"))), false);
        assertTrue(history.limited()); assertTrue(history.messages.isEmpty()); assertTrue(history.requests.isEmpty()); verifyCounters(history);
    }
}
