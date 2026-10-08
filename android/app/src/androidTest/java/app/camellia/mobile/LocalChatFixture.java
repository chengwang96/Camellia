package app.camellia.mobile;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.UUID;

final class LocalChatFixture {
    private final LocalChatWriter writer;
    private JSONObject state;

    LocalChatFixture(Context context) throws Exception {
        writer = LocalChatWriter.get(context);
        state = writer.call(LocalChatFixture::read).get(10, java.util.concurrent.TimeUnit.SECONDS);
        if (!state.has("workspaces")) state.put("workspaces", new JSONArray());
        if (!state.has("conversations")) state.put("conversations", new JSONArray());
        if (!state.has("config")) state.put("config", new JSONObject());
        state.getJSONArray("workspaces"); state.getJSONArray("conversations"); state.getJSONObject("config");
    }

    JSONObject config() { return state.optJSONObject("config"); }
    void configureTools(String id, boolean enabled) throws Exception {
        replace(state);
        state = writer.call(database -> { database.tools(id, enabled); return read(database); }).get(10, java.util.concurrent.TimeUnit.SECONDS);
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
        replace(state);
    }

    void importConfig(JSONObject config) throws Exception {
        JSONObject next = new JSONObject(state.toString());
        next.put("config", new JSONObject(config.toString()));
        replace(next);
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
        return LocalChatStore.orderedConversations(conversations(), workspace);
    }

    void pinConversation(String id, boolean pinned) throws Exception {
        JSONObject previous = new JSONObject(state.toString());
        try { conversation(id).put("pinned", pinned); save(); }
        catch (Exception error) { state = previous; throw error; }
    }

    void deleteConversations(java.util.Set<String> ids) throws Exception {
        JSONObject previous = new JSONObject(state.toString());
        for (int index = conversations().length() - 1; index >= 0; index--)
            if (ids.contains(conversations().getJSONObject(index).optString("id"))) conversations().remove(index);
        try { save(); } catch (Exception error) { state = previous; throw error; }
    }


    private static JSONObject read(LocalChatDatabase database) throws Exception {
        JSONObject result = database.index();
        JSONArray conversations = result.getJSONArray("conversations");
        for (int index = 0; index < conversations.length(); index++)
            conversations.put(index, database.conversation(conversations.getJSONObject(index).getString("id")));
        JSONObject extra = database.get("extra", "main", 0);
        if (extra != null) { var keys = extra.keys(); while (keys.hasNext()) { String key = keys.next(); result.put(key, extra.get(key)); } }
        return result;
    }

    private void replace(JSONObject value) throws Exception {
        JSONObject snapshot = LocalChatRecord.object(value);
        writer.call(database -> database.transaction(() -> {
            java.util.Set<String> previous = new java.util.HashSet<>();
            try (android.database.Cursor rows = database.db.rawQuery("SELECT DISTINCT reference FROM refs", null)) { while (rows.moveToNext()) previous.add(rows.getString(0)); }
            database.db.delete("refs", null, null); database.db.delete("records", null, null);
            database.db.execSQL("UPDATE flags SET value=0 WHERE name='units'");
            database.importLegacy(snapshot);
            for (String reference : previous) database.db.execSQL("INSERT OR IGNORE INTO garbage VALUES(?)", new Object[]{reference});
            return null;
        })).get(10, java.util.concurrent.TimeUnit.SECONDS);
    }

    static void clear(Context context) throws Exception {
        LocalChatWriter.get(context).close();
        java.io.File file = LocalChatDatabase.file(context);
        android.database.sqlite.SQLiteDatabase.deleteDatabase(file);
        new CredentialStore(context, "local-chat-private").clear();
    }

    static void idle(android.app.Instrumentation instrumentation) {
        try {
            for (int step = 0; step < 3; step++) {
                LocalChatWriter.get(instrumentation.getTargetContext()).executor.submit(() -> {}).get(10, java.util.concurrent.TimeUnit.SECONDS);
                instrumentation.waitForIdleSync();
            }
        } catch (Exception error) { throw new AssertionError(error); }
    }

    static android.app.Activity start(android.app.Instrumentation instrumentation, android.content.Intent intent) {
        android.app.Activity activity = instrumentation.startActivitySync(intent);
        if (!(activity instanceof LocalChatActivity) && !(activity instanceof SettingsActivity)) return activity;
        long deadline = android.os.SystemClock.uptimeMillis() + 10000;
        while (android.os.SystemClock.uptimeMillis() < deadline) {
            idle(instrumentation);
            var ready = new java.util.concurrent.atomic.AtomicBoolean();
            instrumentation.runOnMainSync(() -> {
                try {
                    var field = activity.getClass().getDeclaredField("store"); field.setAccessible(true);
                    LocalChatStore store = (LocalChatStore) field.get(activity);
                    if (activity instanceof LocalChatActivity) {
                        var target = LocalChatActivity.class.getDeclaredField("conversationId"); target.setAccessible(true);
                        String id = (String) target.get(activity);
                        ready.set(store != null && (id == null || store.hasHistory(id)));
                    } else ready.set(store != null);
                    if (activity.getWindow().getDecorView().findViewWithTag("localStorageLoadRetry") != null) ready.set(true);
                } catch (Exception error) { throw new AssertionError(error); }
            });
            if (ready.get()) return activity;
            android.os.SystemClock.sleep(20);
        }
        throw new AssertionError("Local storage page did not finish loading");
    }

}
