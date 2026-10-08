package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class RemoteApprovalNoticesTest {
    private JSONObject request(String id) throws Exception {
        return new JSONObject().put("requestId", id).put("runId", 7).put("deliveryId", "delivery-1").put("participantId", "member-1");
    }

    @Test public void repeatsStayQuietAcrossRefreshReconnectAndSavedState() throws Exception {
        RemoteApprovalNotices notices = new RemoteApprovalNotices("[]");
        JSONArray pending = new JSONArray().put(request("permission-1"));
        assertTrue(notices.observe("computer-a/conversation-a", pending));
        assertFalse(notices.observe("computer-a/conversation-a", pending));
        assertFalse(notices.observe("computer-a/conversation-a", new JSONArray()));
        notices = new RemoteApprovalNotices(notices.serialize());
        assertFalse(notices.observe("computer-a/conversation-a", pending));
        pending.put(request("question-2").put("questions", new JSONArray().put(new JSONObject().put("question", "Continue?"))));
        assertTrue(notices.observe("computer-a/conversation-a", pending));
        assertFalse(notices.observe("computer-a/conversation-a", pending));
    }

    @Test public void bodyUpdatesAndReorderedBatchesDoNotReplayRequests() throws Exception {
        RemoteApprovalNotices notices = new RemoteApprovalNotices("[]");
        JSONObject first = request("first"), second = request("second");
        assertTrue(notices.observe("scope", new JSONArray().put(first).put(second).put(first)));
        first.put("details", "Updated preview").put("fingerprint", "new-content-fingerprint");
        assertFalse(notices.observe("scope", new JSONArray().put(second).put(first)));
        assertFalse(notices.observe("scope", new JSONArray().put(second)));
        assertFalse(notices.observe("scope", new JSONArray().put(first).put(second)));
    }

    @Test public void identitiesAreScopedToHostConversationRunAndDiscussionDelivery() throws Exception {
        RemoteApprovalNotices notices = new RemoteApprovalNotices("[]");
        JSONObject reused = request("reused-id");
        for (String scope : new String[]{"host-a/chat-a", "host-b/chat-a", "host-a/chat-b", "host-a/discussion-a"}) {
            assertTrue(notices.observe(scope, new JSONArray().put(reused)));
            assertFalse(notices.observe(scope, new JSONArray().put(reused)));
        }
        reused.put("runId", 8);
        assertTrue(notices.observe("host-a/chat-a", new JSONArray().put(reused)));
        reused.put("deliveryId", "delivery-2");
        assertTrue(notices.observe("host-a/chat-a", new JSONArray().put(reused)));
        reused.put("participantId", "member-2");
        assertTrue(notices.observe("host-a/chat-a", new JSONArray().put(reused)));
    }

    @Test public void incompleteRequestsAreQuietAndLegacyFingerprintsStillDeduplicate() throws Exception {
        RemoteApprovalNotices notices = new RemoteApprovalNotices("invalid-saved-json");
        assertFalse(notices.observe("scope", null));
        assertFalse(notices.observe("", new JSONArray().put(request("valid"))));
        assertFalse(notices.observe("scope", new JSONArray().put(JSONObject.NULL).put("bad").put(new JSONObject())));
        JSONArray legacy = new JSONArray().put(new JSONObject().put("fingerprint", "legacy"));
        assertTrue(notices.observe("scope", legacy));
        assertFalse(new RemoteApprovalNotices(notices.serialize()).observe("scope", legacy));
    }

    @Test public void largePendingBatchesDoNotVibrateOnEveryRefresh() throws Exception {
        RemoteApprovalNotices notices = new RemoteApprovalNotices("[]");
        JSONArray pending = new JSONArray();
        for (int index = 0; index < 300; index++) pending.put(request("pending-" + index));
        assertTrue(notices.observe("scope", pending));
        notices = new RemoteApprovalNotices(notices.serialize());
        assertFalse(notices.observe("scope", pending));
        assertFalse(notices.observe("scope", pending));
    }
}
