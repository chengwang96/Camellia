package app.camellia.mobile;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class RemotePendingCommandsTest {
    private JSONObject request(String conversation, String id) throws Exception {
        return new JSONObject().put("conversationId", conversation).put("payload", new JSONObject().put("requestId", id));
    }
    @Test public void aLegacyRequestOnlyBlocksItsOwnConversation() throws Exception {
        JSONObject profile = new JSONObject().put("pendingCommand", request("one", "first"));
        assertNotNull(RemotePendingCommands.get(profile, "one", false));
        assertNull(RemotePendingCommands.get(profile, "two", false));
    }
    @Test public void migrationKeepsBothConversationsAcrossSerialization() throws Exception {
        JSONObject profile = new JSONObject().put("pendingCommand", request("one", "first"));
        RemotePendingCommands.put(profile, request("two", "second"), false);
        JSONObject saved = new JSONObject(profile.toString());
        assertNotNull(RemotePendingCommands.get(saved, "one", false));
        assertNotNull(RemotePendingCommands.get(saved, "two", false));
        RemotePendingCommands.remove(saved, "first");
        assertNull(RemotePendingCommands.get(saved, "one", false));
        assertNotNull(RemotePendingCommands.get(saved, "two", false));
    }
    @Test public void staleLegacyAliasCannotOverwriteTheDispatchedRequest() throws Exception {
        JSONObject profile = new JSONObject().put("pendingCommand", request("one", "first"));
        profile.put("pendingCommands", new JSONObject().put("one", request("one", "first").put("dispatched", true)));
        profile = new JSONObject(profile.toString()); profile.getJSONObject("pendingCommand").remove("dispatched");
        RemotePendingCommands.put(profile, request("two", "second"), false);
        assertTrue(RemotePendingCommands.get(profile, "one", false).getBoolean("dispatched"));
        assertFalse(profile.has("pendingCommand"));
    }
    @Test public void oneRequestHasOnlyOneStoredAttachmentPayload() throws Exception {
        JSONObject profile = new JSONObject();
        RemotePendingCommands.put(profile, request("one", "first"), false);
        assertTrue(profile.has("pendingCommand")); assertFalse(profile.has("pendingCommands"));
        RemotePendingCommands.put(profile, request("two", "second"), false);
        assertFalse(profile.has("pendingCommand")); assertEquals(2, profile.getJSONObject("pendingCommands").length());
    }
    @Test public void stopDoesNotReplaceTheSendAndCanSettleIndependently() throws Exception {
        JSONObject profile = new JSONObject();
        RemotePendingCommands.put(profile, request("one", "send"), false);
        RemotePendingCommands.put(profile, request("one", "stop"), true);
        RemotePendingCommands.remove(profile, "stop");
        assertNotNull(RemotePendingCommands.find(profile, "send"));
        assertNull(RemotePendingCommands.get(profile, "one", true));
        RemotePendingCommands.put(profile, request("one", "stop-again"), true);
        RemotePendingCommands.remove(profile, "send");
        assertNull(RemotePendingCommands.get(profile, "one", false));
        assertNotNull(RemotePendingCommands.find(profile, "stop-again"));
    }
}
