package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import org.json.JSONObject;

public class ConversationOrderTest extends InstrumentationTestCase {
    private CredentialStore encrypted;

    @Override protected void setUp() throws Exception {
        super.setUp(); encrypted = new CredentialStore(getInstrumentation().getTargetContext(), "local-chat-private"); encrypted.clear();
    }

    @Override protected void tearDown() throws Exception { encrypted.clear(); super.tearDown(); }

    public void testReorderMoveRestartAndInvalidTargets() throws Exception {
        LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext());
        String workspace = store.createWorkspace("Source").getString("id");
        String target = store.createWorkspace("Target").getString("id");
        JSONObject first = store.createConversation(workspace, "route");
        JSONObject second = store.createConversation(workspace, "route");
        String firstId = first.getString("id"), secondId = second.getString("id");
        first.put("draft", "Keep this draft");
        first.getJSONArray("messages").put(new JSONObject().put("role", "user").put("content", "Keep history"));
        store.moveConversation(firstId, workspace, secondId, true);
        second.put("updatedAt", Long.MAX_VALUE); store.save();
        store = new LocalChatStore(getInstrumentation().getTargetContext());
        assertEquals(secondId, store.orderedConversations(workspace).get(0).getString("id"));
        assertEquals(firstId, store.orderedConversations(workspace).get(1).getString("id"));
        store.moveConversation(firstId, target, null, false);
        store = new LocalChatStore(getInstrumentation().getTargetContext());
        assertEquals(firstId, store.orderedConversations(target).get(0).getString("id"));
        assertEquals("Keep this draft", store.conversation(firstId).getString("draft"));
        assertEquals(1, store.conversation(firstId).getJSONArray("messages").length());
        try { store.moveConversation(firstId, target, secondId, false); fail("Accepted wrong target"); } catch (IllegalArgumentException expected) {}
        try { store.moveConversation(firstId, "missing", null, false); fail("Accepted missing workspace"); } catch (IllegalArgumentException expected) {}
        assertEquals(target, store.conversation(firstId).getString("workspaceId"));
        store.moveConversation(firstId, "", null, false);
        assertEquals(firstId, new LocalChatStore(getInstrumentation().getTargetContext()).orderedConversations("").get(0).getString("id"));
    }
}
