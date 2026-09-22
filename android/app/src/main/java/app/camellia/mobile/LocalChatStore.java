package app.camellia.mobile;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.UUID;

final class LocalChatStore {
    private final CredentialStore encrypted;
    private JSONObject state;

    LocalChatStore(Context context) throws Exception {
        encrypted = new CredentialStore(context, "local-chat-private");
        state = encrypted.load();
        if (!state.has("workspaces")) state.put("workspaces", new JSONArray());
        if (!state.has("conversations")) state.put("conversations", new JSONArray());
        if (!state.has("config")) state.put("config", new JSONObject());
        state.getJSONArray("workspaces"); state.getJSONArray("conversations"); state.getJSONObject("config");
    }

    JSONObject config() { return state.optJSONObject("config"); }
    JSONArray workspaces() { return state.optJSONArray("workspaces"); }
    JSONArray conversations() { return state.optJSONArray("conversations"); }
    JSONObject conversation(String id) {
        for (int index = 0; index < conversations().length(); index++) {
            JSONObject conversation = conversations().optJSONObject(index);
            if (conversation != null && conversation.optString("id").equals(id)) return conversation;
        }
        return null;
    }

    void save() throws Exception {
        if (state.toString().length() > 8 * 1024 * 1024) throw new IllegalStateException("本机聊天存储已满，请删除旧会话 / Local storage limit reached; delete old conversations");
        encrypted.save(state);
    }

    void importConfig(JSONObject config) throws Exception {
        JSONObject next = new JSONObject(state.toString());
        next.put("config", new JSONObject(config.toString()));
        encrypted.save(next);
        state = next;
    }

    JSONObject createWorkspace(String name) throws Exception {
        JSONObject workspace = new JSONObject().put("id", UUID.randomUUID().toString()).put("name", name);
        workspaces().put(workspace);
        try { save(); } catch (Exception error) { workspaces().remove(workspaces().length() - 1); throw error; }
        return workspace;
    }

    JSONObject createConversation(String workspaceId, String routeId) throws Exception {
        JSONObject conversation = new JSONObject().put("id", UUID.randomUUID().toString()).put("title", "")
            .put("workspaceId", workspaceId).put("routeId", routeId).put("messages", new JSONArray())
            .put("updatedAt", System.currentTimeMillis()).put("draft", "");
        conversations().put(conversation);
        try { save(); } catch (Exception error) { conversations().remove(conversations().length() - 1); throw error; }
        return conversation;
    }

    void deleteConversation(String id) throws Exception {
        JSONObject previous = new JSONObject(state.toString());
        for (int index = conversations().length() - 1; index >= 0; index--) {
            if (conversations().getJSONObject(index).optString("id").equals(id)) conversations().remove(index);
        }
        try { save(); } catch (Exception error) { state = previous; throw error; }
    }

    void archiveConversation(String id, boolean archived) throws Exception {
        JSONObject previous = new JSONObject(state.toString());
        JSONObject conversation = conversation(id);
        if (conversation == null) throw new IllegalArgumentException("会话不存在 / Conversation not found");
        conversation.put("archived", archived);
        try { save(); } catch (Exception error) { state = previous; throw error; }
    }

    void deleteWorkspace(String id) throws Exception {
        JSONObject previous = new JSONObject(state.toString());
        for (int index = workspaces().length() - 1; index >= 0; index--) {
            if (workspaces().getJSONObject(index).optString("id").equals(id)) workspaces().remove(index);
        }
        for (int index = 0; index < conversations().length(); index++) {
            JSONObject conversation = conversations().getJSONObject(index);
            if (conversation.optString("workspaceId").equals(id)) conversation.put("workspaceId", "");
        }
        try { save(); } catch (Exception error) { state = previous; throw error; }
    }
}
