package app.camellia.mobile;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Set;
import java.util.UUID;

/** UI snapshot: metadata plus the open conversation. Disk access belongs to the writer. */
final class LocalChatStore {
    interface Callback<T> { void done(T value); void failed(Exception error); }
    private final LocalChatWriter writer;
    private JSONObject state, active;
    private JSONObject dirtyConfig;
    private long configRevision;
    private int pending;
    private boolean saveFailed;
    final Exception cleanupError, pendingError;

    static final class Reply {
        final String id, run;
        final int position;
        long revision;
        Reply(String id, int position, String run) { this.id = id; this.position = position; this.run = run; }
    }
    static final class Turn {
        final JSONObject request;
        final Reply reply;
        Turn(JSONObject request, Reply reply) { this.request = request; this.reply = reply; }
    }

    private LocalChatStore(LocalChatWriter writer, JSONObject state, Exception cleanupError, Exception pendingError) {
        this.writer = writer; this.state = state; this.cleanupError = cleanupError; this.pendingError = pendingError;
        saveFailed = pendingError != null;
    }

    static void open(Context context, String recoveryNotice, Callback<LocalChatStore> callback) {
        LocalChatWriter writer = LocalChatWriter.get(context);
        writer.submit(database -> {
            Exception pendingError = null;
            try { writer.retryFailed(); } catch (Exception error) { pendingError = error; }
            if (recoveryNotice != null && pendingError == null) writer.recover(recoveryNotice);
            return new LocalChatStore(writer, database.index(), database.cleanupError, pendingError);
        }, callback);
    }

    JSONObject config() { return state.optJSONObject("config"); }
    JSONArray workspaces() { return state.optJSONArray("workspaces"); }
    JSONArray conversations() { return state.optJSONArray("conversations"); }
    boolean busy() { return pending > 0; }
    boolean saveFailed() { return saveFailed; }
    boolean hasHistory(String id) { return active != null && active.optString("id").equals(id); }
    void releaseHistory() { active = null; }
    void useConversation(JSONObject conversation) { active = conversation; }

    JSONObject conversation(String id) {
        if (hasHistory(id)) return active;
        for (int index = 0; index < conversations().length(); index++) {
            JSONObject conversation = conversations().optJSONObject(index);
            if (conversation != null && conversation.optString("id").equals(id)) return conversation;
        }
        return null;
    }

    void readConversation(String id, Callback<JSONObject> callback) {
        writer.submit(database -> {
            JSONObject result = database.conversation(id);
            if (result != null) writer.restorePending(database, id, result);
            return result;
        }, callback);
    }

    private void metadata(JSONObject value) throws Exception {
        String id = value.getString("id"); boolean found = false;
        for (int index = 0; index < conversations().length(); index++) {
            if (conversations().getJSONObject(index).optString("id").equals(id)) { conversations().put(index, value); found = true; break; }
        }
        if (!found) conversations().put(value);
        if (hasHistory(id)) {
            var keys = value.keys(); while (keys.hasNext()) { String key = keys.next(); active.put(key, LocalChatRecord.copy(value.get(key))); }
        }
    }

    private <T> void write(LocalChatWriter.Work<T> work, Callback<T> callback, java.util.function.Consumer<T> apply) {
        pending++;
        writer.submit(work, new Callback<>() {
            public void done(T result) {
                pending--;
                try { apply.accept(result); callback.done(result); }
                catch (Exception error) { saveFailed = true; callback.failed(error); }
            }
            public void failed(Exception error) { pending--; saveFailed = true; callback.failed(error); }
        });
    }

    void patchConversation(String id, JSONObject changes, Callback<JSONObject> callback) throws Exception {
        JSONObject snapshot = LocalChatRecord.object(changes);
        write(database -> database.patch(id, snapshot), callback, result -> {
            try { metadata(result); } catch (Exception error) { throw new IllegalStateException(error); }
        });
    }

    void archiveConversation(String id, boolean archived, Callback<JSONObject> callback) throws Exception { patchConversation(id, new JSONObject().put("archived", archived), callback); }
    void pinConversation(String id, boolean pinned, Callback<JSONObject> callback) throws Exception { patchConversation(id, new JSONObject().put("pinned", pinned), callback); }
    void configureTools(String id, boolean enabled, Callback<JSONObject> callback) {
        write(database -> database.tools(id, enabled), callback, result -> {
            try { metadata(result); } catch (Exception error) { throw new IllegalStateException(error); }
        });
    }

    void createWorkspace(String name, Callback<JSONObject> callback) {
        write(database -> database.transaction(() -> {
            JSONObject workspace = new JSONObject().put("id", UUID.randomUUID().toString()).put("name", name);
            database.put("workspace", workspace.getString("id"), 0, workspace, "", 0); return workspace;
        }), callback, result -> workspaces().put(result));
    }

    void renameWorkspace(String id, String name, Callback<JSONObject> callback) {
        write(database -> database.transaction(() -> {
            JSONObject workspace = database.get("workspace", id, 0);
            if (workspace == null) throw new java.io.IOException("Workspace not found");
            workspace.put("name", name); database.put("workspace", id, 0, workspace, "", 0); return workspace;
        }), callback, result -> {
            try { for (int index = 0; index < workspaces().length(); index++) if (workspaces().getJSONObject(index).optString("id").equals(id)) workspaces().put(index, result); }
            catch (Exception error) { throw new IllegalStateException(error); }
        });
    }

    void deleteWorkspace(String id, Callback<JSONObject> callback) {
        write(database -> {
            database.transaction(() -> {
                database.remove("workspace", id, 0);
                JSONArray conversations = database.rows("conversation");
                for (int index = 0; index < conversations.length(); index++) {
                    JSONObject row = conversations.getJSONObject(index);
                    if (row.optString("workspaceId").equals(id)) { row.put("workspaceId", ""); database.put("conversation", row.getString("id"), 0, row, "", 0); }
                }
                return null;
            }); return database.index();
        }, callback, result -> {
            state = result;
            if (active != null && active.optString("workspaceId").equals(id)) try { active.put("workspaceId", ""); } catch (Exception error) { throw new IllegalStateException(error); }
        });
    }

    void createConversation(String workspace, String route, Callback<JSONObject> callback) {
        write(database -> {
            String id = UUID.randomUUID().toString();
            database.transaction(() -> {
                JSONObject row = new JSONObject().put("id", id).put("title", "").put("workspaceId", workspace).put("routeId", route).put("updatedAt", System.currentTimeMillis());
                database.put("conversation", id, 0, row, "", 0);
                database.put("draft", id, 0, new JSONObject().put("draft", ""), "", 0);
                return null;
            }); return database.conversation(id);
        }, callback, result -> {
            try { metadata(LocalChatRecord.metadata(result)); } catch (Exception error) { throw new IllegalStateException(error); }
        });
    }

    void deleteConversations(Set<String> ids, Callback<Void> callback) {
        Set<String> targets = Set.copyOf(ids);
        write(database -> { database.deleteConversations(targets); for (String id : targets) writer.discard(id + "/"); return null; }, callback, result -> {
            for (int index = conversations().length() - 1; index >= 0; index--) if (targets.contains(conversations().optJSONObject(index).optString("id"))) conversations().remove(index);
            if (active != null && targets.contains(active.optString("id"))) active = null;
        });
    }

    void importConfig(JSONObject config, Callback<JSONObject> callback) throws Exception {
        JSONObject snapshot = LocalChatRecord.object(config); long revision = ++configRevision;
        state.put("config", LocalChatRecord.object(snapshot)); dirtyConfig = snapshot;
        write(database -> database.transaction(() -> { database.put("config", "main", 0, snapshot, "", 0); return snapshot; }), callback, result -> { if (revision == configRevision) dirtyConfig = null; });
    }

    void saveDraft(String id, JSONObject conversation, boolean immediate, Callback<Void> callback) throws Exception {
        JSONObject snapshot = LocalChatRecord.draft(conversation);
        writer.coalesce(id + "/draft", database -> database.transaction(() -> {
            if (database.get("conversation", id, 0) == null) return null;
            JSONObject previous = database.get("draft", id, 0);
            if (!LocalChatRecord.same(previous, snapshot)) database.put("draft", id, 0, snapshot, "", 0);
            return null;
        }), snapshot, "", immediate ? 0 : 350, tracked(callback));
    }

    void startTurn(String id, int from, int expectedCount, JSONObject user, LocalChatConfig.Route route, String thinking, String location, String emptyTitle, Callback<Turn> callback) throws Exception {
        JSONObject userSnapshot = LocalChatRecord.object(user);
        write(database -> {
            writer.retryFailed();
            if (from < 0 || from > expectedCount || database.messageCount(id) != expectedCount)
                throw new java.io.IOException("会话历史已变化，请重新打开会话 / Chat history changed; reopen the conversation");
            JSONArray context = database.messages(id, from);
            JSONObject sent = LocalChatRecord.object(userSnapshot);
            if (!location.isEmpty()) sent.put("content", sent.optString("content") + location);
            context.put(sent);
            JSONObject request = LocalChatClient.request(route, context, thinking);
            String run = UUID.randomUUID().toString();
            JSONObject reply = new JSONObject().put("role", "assistant").put("content", "").put("state", "running").put("at", userSnapshot.getLong("at"));
            database.transaction(() -> {
                JSONObject meta = database.get("conversation", id, 0);
                if (meta == null) throw new java.io.IOException("Conversation not found");
                database.cutMessages(id, from);
                database.put("message", id, from, userSnapshot, "", 0); database.put("message", id, from + 1, reply, run, 0);
                database.put("draft", id, 0, new JSONObject().put("draft", "").put("draftImages", new JSONArray()).put("draftDocuments", new JSONArray()), "", 0);
                meta.put("updatedAt", System.currentTimeMillis()); if (meta.optString("title").isEmpty()) meta.put("title", emptyTitle);
                database.put("conversation", id, 0, meta, "", 0); return null;
            });
            writer.discard(id + "/draft");
            return new Turn(request, new Reply(id, from + 1, run));
        }, new Callback<>() {
            public void done(Turn turn) {
                try {
                    JSONObject conversation = conversation(id);
                    if (hasHistory(id)) {
                        JSONArray messages = conversation.getJSONArray("messages");
                        while (messages.length() > from) messages.remove(messages.length() - 1);
                        messages.put(LocalChatRecord.object(userSnapshot)).put(new JSONObject().put("role", "assistant").put("content", "").put("state", "running").put("at", userSnapshot.getLong("at")));
                        LocalChatDraft.save(conversation, "", -1, java.util.Collections.emptyList(), java.util.Collections.emptyList());
                        conversation.put("updatedAt", System.currentTimeMillis()); if (conversation.optString("title").isEmpty()) conversation.put("title", emptyTitle);
                        metadata(LocalChatRecord.metadata(conversation));
                    }
                    callback.done(turn);
                } catch (Exception error) { callback.failed(error); }
            }
            public void failed(Exception error) { callback.failed(error); }
        }, result -> {});
    }

    void checkpoint(Reply reply, JSONObject message, boolean immediate, Callback<Void> callback) throws Exception {
        JSONObject snapshot = LocalChatRecord.object(message);
        String id = reply.id, run = reply.run; int position = reply.position; long revision = ++reply.revision;
        writer.coalesce(id + "/message/" + position, database -> { database.reply(id, position, run, revision, snapshot); return null; }, snapshot, run, immediate ? 0 : 750, tracked(callback));
    }

    private Callback<Void> tracked(Callback<Void> callback) {
        return new Callback<>() {
            public void done(Void value) { callback.done(null); }
            public void failed(Exception error) { saveFailed = true; callback.failed(error); }
        };
    }

    void flush(Callback<Void> callback) throws Exception {
        JSONObject config = dirtyConfig == null ? null : LocalChatRecord.object(dirtyConfig); long revision = configRevision;
        write(database -> {
            writer.retryFailed();
            if (config != null && !LocalChatRecord.same(config, database.get("config", "main", 0)))
                database.transaction(() -> { database.put("config", "main", 0, config, "", 0); return null; });
            database.checkpoint(); return null;
        }, callback, value -> { saveFailed = false; if (config != null && revision == configRevision) dirtyConfig = null; });
    }

    java.util.List<JSONObject> orderedConversations(String workspace) {
        return orderedConversations(conversations(), workspace);
    }

    static java.util.List<JSONObject> orderedConversations(JSONArray conversations, String workspace) {
        java.util.List<JSONObject> entries = new java.util.ArrayList<>();
        for (int index = 0; index < conversations.length(); index++) {
            JSONObject entry = conversations.optJSONObject(index);
            if (entry != null && !entry.optBoolean("archived") && entry.optString("workspaceId").equals(workspace)) entries.add(entry);
        }
        entries.sort(java.util.Comparator.comparing((JSONObject entry) -> !entry.optBoolean("pinned"))
            .thenComparingLong(entry -> entry.optLong("order", Long.MAX_VALUE))
            .thenComparing(java.util.Comparator.comparingLong((JSONObject entry) -> entry.optLong("updatedAt")).reversed()));
        return entries;
    }
}
