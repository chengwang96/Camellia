package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import org.json.JSONObject;

public class ConversationOrderTest extends InstrumentationTestCase {

    @Override protected void setUp() throws Exception {
        super.setUp(); LocalChatFixture.clear(getInstrumentation().getTargetContext());
    }

    @Override protected void tearDown() throws Exception { LocalChatFixture.clear(getInstrumentation().getTargetContext()); super.tearDown(); }

    public void testLegacyOrderSurvivesRestartWithConversationData() throws Exception {
        LocalChatFixture store = new LocalChatFixture(getInstrumentation().getTargetContext());
        String workspace = store.createWorkspace("Source").getString("id");
        JSONObject first = store.createConversation(workspace, "route");
        JSONObject second = store.createConversation(workspace, "route");
        String firstId = first.getString("id"), secondId = second.getString("id");
        first.put("draft", "Keep this draft");
        first.getJSONArray("messages").put(new JSONObject().put("role", "user").put("content", "Keep history"));
        first.put("order", 1).put("updatedAt", Long.MAX_VALUE);
        second.put("order", 0).put("updatedAt", 1); store.save();
        store = new LocalChatFixture(getInstrumentation().getTargetContext());
        assertEquals(secondId, store.orderedConversations(workspace).get(0).getString("id"));
        assertEquals(firstId, store.orderedConversations(workspace).get(1).getString("id"));
        assertEquals("Keep this draft", store.conversation(firstId).getString("draft"));
        assertEquals(1, store.conversation(firstId).getJSONArray("messages").length());
        assertEquals(workspace, store.conversation(firstId).getString("workspaceId"));
    }
}
