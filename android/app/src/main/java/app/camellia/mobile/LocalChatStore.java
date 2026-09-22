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
    void configureTools(String id, boolean enabled) throws Exception {
        JSONObject previous = new JSONObject(state.toString());
        try {
            state.remove("webSearchKey");
            conversation(id).put("webTools", enabled); save();
        } catch (Exception error) { state = previous; throw error; }
    }
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

    java.util.List<JSONObject> orderedConversations(String workspace) {
        java.util.List<JSONObject> entries = new java.util.ArrayList<>();
        for (int index = 0; index < conversations().length(); index++) {
            JSONObject entry = conversations().optJSONObject(index);
            if (entry != null && !entry.optBoolean("archived") && entry.optString("workspaceId").equals(workspace)) entries.add(entry);
        }
        entries.sort(java.util.Comparator.comparingLong((JSONObject entry) -> entry.optLong("order", Long.MAX_VALUE))
            .thenComparing(java.util.Comparator.comparingLong((JSONObject entry) -> entry.optLong("updatedAt")).reversed()));
        return entries;
    }

    void moveConversation(String id, String workspace, String target, boolean after) throws Exception {
        JSONObject entry = conversation(id);
        if (entry == null || entry.optBoolean("archived")) throw new IllegalArgumentException("Conversation not found");
        boolean exists = workspace.isEmpty();
        for (int index = 0; index < workspaces().length(); index++) if (workspaces().getJSONObject(index).optString("id").equals(workspace)) exists = true;
        if (!exists) throw new IllegalArgumentException("Workspace not found");
        java.util.List<JSONObject> ordered = orderedConversations(workspace);
        ordered.remove(entry);
        int position = ordered.size();
        if (target != null) {
            position = -1;
            for (int index = 0; index < ordered.size(); index++) if (ordered.get(index).optString("id").equals(target)) position = index + (after ? 1 : 0);
            if (position < 0) throw new IllegalArgumentException("Invalid drop target");
        }
        JSONObject previous = new JSONObject(state.toString());
        ordered.add(position, entry);
        try {
            entry.put("workspaceId", workspace);
            for (int index = 0; index < ordered.size(); index++) ordered.get(index).put("order", index);
            save();
        } catch (Exception error) { state = previous; throw error; }
    }
}
