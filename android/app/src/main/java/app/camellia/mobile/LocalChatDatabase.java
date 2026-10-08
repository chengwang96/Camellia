package app.camellia.mobile;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Used exclusively by the local storage worker. Record contents remain encrypted. */
final class LocalChatDatabase implements AutoCloseable {
    static final int LIMIT = 8 * 1024 * 1024;
    private static final int BLOB_WINDOW = 256 * 1024;
    final SQLiteDatabase db;
    private final Context context;
    private final SecretKey key;
    private int transactions;
    Exception cleanupError;

    interface Work<T> { T run() throws Exception; }

    static File file(Context context) { return new File(context.getNoBackupFilesDir(), "local-chat-v2.db"); }

    LocalChatDatabase(Context context) throws Exception {
        this.context = context.getApplicationContext();
        key = CredentialStore.key();
        db = SQLiteDatabase.openOrCreateDatabase(file(context), null);
        try {
            if (db.getVersion() != 0 && db.getVersion() != 2) throw new IOException("Unsupported local chat database version");
            int autoVacuum;
            try (Cursor setting = db.rawQuery("PRAGMA auto_vacuum", null)) { setting.moveToFirst(); autoVacuum = setting.getInt(0); }
            db.execSQL("PRAGMA auto_vacuum=INCREMENTAL");
            // Android may already have created android_metadata before our schema.
            if (autoVacuum == 0) db.execSQL("VACUUM");
            db.enableWriteAheadLogging();
            pragma("PRAGMA wal_autocheckpoint=64");
            pragma("PRAGMA journal_size_limit=524288");
            db.execSQL("CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,owner TEXT NOT NULL,position INTEGER NOT NULL,payload BLOB NOT NULL,units INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 0,run_id TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,owner,position))");
            db.execSQL("CREATE INDEX IF NOT EXISTS running_messages ON records(active) WHERE active=1");
            db.execSQL("CREATE TABLE IF NOT EXISTS refs(kind TEXT NOT NULL,owner TEXT NOT NULL,position INTEGER NOT NULL,reference TEXT NOT NULL,PRIMARY KEY(kind,owner,position,reference))");
            db.execSQL("CREATE INDEX IF NOT EXISTS attachment_references ON refs(reference)");
            db.execSQL("CREATE TABLE IF NOT EXISTS garbage(reference TEXT PRIMARY KEY)");
            db.execSQL("CREATE TABLE IF NOT EXISTS flags(name TEXT PRIMARY KEY,value INTEGER NOT NULL)");
            db.execSQL("INSERT OR IGNORE INTO flags VALUES('units',0)");
            if (flag("migrated") != 1) {
                if (countRecords() != 0) throw new IOException("Unverified local chat database; stored data was preserved");
                JSONObject legacy = new CredentialStore(context, "local-chat-private").load();
                transaction(() -> { importLegacy(legacy); db.execSQL("INSERT OR REPLACE INTO flags VALUES('migrated',1)"); db.setVersion(2); return null; });
            }
            // The committed marker makes this cleanup restartable without importing old data again.
            try {
                if (context.getSharedPreferences("local-chat-private", Context.MODE_PRIVATE).contains("credential"))
                    new CredentialStore(context, "local-chat-private").clear();
            } catch (Exception error) { cleanupError = error; }
            maintain(false);
        } catch (Exception error) { db.close(); throw error; }
    }

    long flag(String name) {
        try (Cursor row = db.rawQuery("SELECT value FROM flags WHERE name=?", new String[]{name})) { return row.moveToFirst() ? row.getLong(0) : 0; }
    }

    int countRecords() {
        try (Cursor row = db.rawQuery("SELECT count(*) FROM records", null)) { row.moveToFirst(); return row.getInt(0); }
    }

    <T> T transaction(Work<T> work) throws Exception {
        try (AttachmentMaintenance.Write writing = AttachmentMaintenance.writing()) {
        db.beginTransaction();
        T result;
        try {
            result = work.run();
            if (flag("units") > LIMIT) throw new IOException("本机聊天存储已满，请删除旧会话 / Local storage limit reached; delete old conversations");
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        maintain(false);
        if (++transactions % 64 == 0) maintain(true);
        return result;
        }
    }

    private byte[] aad(String kind, String owner, int position) { return ("camellia.local.v2/" + kind + "/" + owner + "/" + position).getBytes(StandardCharsets.UTF_8); }

    private byte[] encrypt(String kind, String owner, int position, String text) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key); cipher.updateAAD(aad(kind, owner, position));
        byte[] body = cipher.doFinal(text.getBytes(StandardCharsets.UTF_8));
        byte[] result = Arrays.copyOf(cipher.getIV(), 12 + body.length); System.arraycopy(body, 0, result, 12, body.length);
        return result;
    }

    private JSONObject decrypt(String kind, String owner, int position, byte[] value) throws Exception {
        if (value.length < 28) throw new IOException("Invalid encrypted local chat record");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Arrays.copyOf(value, 12)));
        cipher.updateAAD(aad(kind, owner, position));
        return new JSONObject(new String(cipher.doFinal(value, 12, value.length - 12), StandardCharsets.UTF_8));
    }

    JSONObject get(String kind, String owner, int position) throws Exception {
        try (Cursor row = db.rawQuery("SELECT substr(payload,1," + BLOB_WINDOW + "),length(payload) FROM records WHERE kind=? AND owner=? AND position=?", new String[]{kind, owner, String.valueOf(position)})) {
            return row.moveToFirst() ? decrypt(kind, owner, position, payload(kind, owner, position, row.getBlob(0), row.getInt(1))) : null;
        }
    }

    // CursorWindow has a small per-row limit. Read a large encrypted record in bounded slices.
    private byte[] payload(String kind, String owner, int position, byte[] first, int length) throws IOException {
        if (length == first.length) return first;
        if (length < 28 || length > 3 * LIMIT + 28) throw new IOException("Invalid local chat record size");
        byte[] result = Arrays.copyOf(first, length);
        for (int offset = first.length; offset < length; offset += BLOB_WINDOW) {
            try (Cursor slice = db.rawQuery("SELECT substr(payload,?," + BLOB_WINDOW + ") FROM records WHERE kind=? AND owner=? AND position=?",
                    new String[]{String.valueOf(offset + 1), kind, owner, String.valueOf(position)})) {
                if (!slice.moveToFirst()) throw new IOException("Missing encrypted local chat record");
                byte[] bytes = slice.getBlob(0);
                if (bytes.length != Math.min(BLOB_WINDOW, length - offset)) throw new IOException("Incomplete encrypted local chat record");
                System.arraycopy(bytes, 0, result, offset, bytes.length);
            }
        }
        return result;
    }

    private Set<String> references(String kind, String owner, int position) {
        Set<String> result = new HashSet<>();
        try (Cursor rows = db.rawQuery("SELECT reference FROM refs WHERE kind=? AND owner=? AND position=?", new String[]{kind, owner, String.valueOf(position)})) {
            while (rows.moveToNext()) result.add(rows.getString(0));
        }
        return result;
    }

    void put(String kind, String owner, int position, JSONObject value, String run, long revision) throws Exception {
        long previous = 0; boolean exists;
        try (Cursor row = db.rawQuery("SELECT units FROM records WHERE kind=? AND owner=? AND position=?", new String[]{kind, owner, String.valueOf(position)})) { exists = row.moveToFirst(); if (exists) previous = row.getLong(0); }
        String text = value.toString();
        ContentValues values = new ContentValues();
        values.put("kind", kind); values.put("owner", owner); values.put("position", position); values.put("payload", encrypt(kind, owner, position, text));
        values.put("units", text.length()); values.put("active", kind.equals("message") && value.optString("state").equals("running") ? 1 : 0);
        values.put("run_id", run); values.put("revision", revision);
        if (exists) db.update("records", values, "kind=? AND owner=? AND position=?", new String[]{kind, owner, String.valueOf(position)});
        else db.insertOrThrow("records", null, values);
        db.execSQL("UPDATE flags SET value=value+? WHERE name='units'", new Object[]{text.length() - previous});
        Set<String> before = references(kind, owner, position), retained = AttachmentStore.references(value);
        if (before.equals(retained)) return;
        db.delete("refs", "kind=? AND owner=? AND position=?", new String[]{kind, owner, String.valueOf(position)});
        for (String reference : retained) {
            db.execSQL("INSERT INTO refs VALUES(?,?,?,?)", new Object[]{kind, owner, position, reference});
            db.delete("garbage", "reference=?", new String[]{reference});
        }
        for (String reference : before) if (!retained.contains(reference)) db.execSQL("INSERT OR IGNORE INTO garbage VALUES(?)", new Object[]{reference});
    }

    void remove(String kind, String owner, int position) {
        long units = 0;
        try (Cursor row = db.rawQuery("SELECT units FROM records WHERE kind=? AND owner=? AND position=?", new String[]{kind, owner, String.valueOf(position)})) { if (row.moveToFirst()) units = row.getLong(0); }
        for (String reference : references(kind, owner, position)) db.execSQL("INSERT OR IGNORE INTO garbage VALUES(?)", new Object[]{reference});
        String[] args = {kind, owner, String.valueOf(position)};
        db.delete("refs", "kind=? AND owner=? AND position=?", args);
        db.delete("records", "kind=? AND owner=? AND position=?", args);
        db.execSQL("UPDATE flags SET value=value-? WHERE name='units'", new Object[]{units});
    }

    JSONArray rows(String kind) throws Exception {
        JSONArray result = new JSONArray();
        try (Cursor rows = db.rawQuery("SELECT owner,position,substr(payload,1," + BLOB_WINDOW + "),length(payload) FROM records WHERE kind=? ORDER BY rowid", new String[]{kind})) {
            while (rows.moveToNext()) result.put(decrypt(kind, rows.getString(0), rows.getInt(1), payload(kind, rows.getString(0), rows.getInt(1), rows.getBlob(2), rows.getInt(3))));
        }
        return result;
    }

    JSONObject index() throws Exception {
        JSONObject config = get("config", "main", 0);
        if (config == null) throw new IOException("Missing local configuration record");
        return new JSONObject().put("config", config).put("workspaces", rows("workspace")).put("conversations", rows("conversation"));
    }

    JSONArray messages(String id, int before) throws Exception {
        JSONArray result = new JSONArray();
        try (Cursor rows = db.rawQuery("SELECT position,substr(payload,1," + BLOB_WINDOW + "),length(payload) FROM records WHERE kind='message' AND owner=? AND position<? ORDER BY position", new String[]{id, String.valueOf(before)})) {
            while (rows.moveToNext()) {
                if (rows.getInt(0) != result.length()) throw new IOException("Local chat history has a missing message");
                result.put(decrypt("message", id, rows.getInt(0), payload("message", id, rows.getInt(0), rows.getBlob(1), rows.getInt(2))));
            }
        }
        return result;
    }

    int messageCount(String id) {
        try (Cursor row = db.rawQuery("SELECT count(*) FROM records WHERE kind='message' AND owner=?", new String[]{id})) {
            row.moveToFirst(); return row.getInt(0);
        }
    }

    JSONObject conversation(String id) throws Exception {
        JSONObject result = get("conversation", id, 0); if (result == null) return null;
        JSONObject draft = get("draft", id, 0);
        if (draft == null) throw new IOException("Missing local draft record");
        var keys = draft.keys(); while (keys.hasNext()) { String key = keys.next(); result.put(key, draft.get(key)); }
        return result.put("messages", messages(id, Integer.MAX_VALUE));
    }

    JSONObject patch(String id, JSONObject changes) throws Exception {
        return transaction(() -> {
            JSONObject result = get("conversation", id, 0);
            if (result == null) throw new IOException("会话不存在 / Conversation not found");
            var keys = changes.keys(); while (keys.hasNext()) { String key = keys.next(); result.put(key, changes.get(key)); }
            put("conversation", id, 0, result, "", 0); return result;
        });
    }

    JSONObject tools(String id, boolean enabled) throws Exception {
        return transaction(() -> {
            JSONObject result = get("conversation", id, 0);
            if (result == null) throw new IOException("会话不存在 / Conversation not found");
            result.put("webTools", enabled); put("conversation", id, 0, result, "", 0);
            JSONObject extra = get("extra", "main", 0);
            if (extra != null && extra.has("webSearchKey")) {
                extra.remove("webSearchKey");
                if (extra.length() == 0) remove("extra", "main", 0); else put("extra", "main", 0, extra, "", 0);
            }
            return result;
        });
    }

    void cutMessages(String id, int from) {
        ArrayList<Integer> positions = new ArrayList<>();
        try (Cursor rows = db.rawQuery("SELECT position FROM records WHERE kind='message' AND owner=? AND position>=?", new String[]{id, String.valueOf(from)})) { while (rows.moveToNext()) positions.add(rows.getInt(0)); }
        for (int position : positions) remove("message", id, position);
    }

    void deleteConversations(Set<String> ids) throws Exception {
        transaction(() -> {
            for (String id : ids) { cutMessages(id, 0); remove("draft", id, 0); remove("conversation", id, 0); }
            return null;
        });
        try { pragma("PRAGMA incremental_vacuum"); checkpoint(); }
        catch (Exception error) { cleanupError = error; }
    }

    boolean reply(String id, int position, String run, long revision, JSONObject snapshot) throws Exception {
        return transaction(() -> {
            try (Cursor row = db.rawQuery("SELECT active,run_id,revision FROM records WHERE kind='message' AND owner=? AND position=?", new String[]{id, String.valueOf(position)})) {
                if (!row.moveToFirst() || row.getInt(0) != 1 || !run.equals(row.getString(1)) || revision <= row.getLong(2)) return false;
            }
            put("message", id, position, snapshot, run, revision); return true;
        });
    }

    void recover(String notice) throws Exception {
        ArrayList<String> owners = new ArrayList<>(); ArrayList<Integer> positions = new ArrayList<>();
        try (Cursor rows = db.rawQuery("SELECT owner,position FROM records WHERE active=1", null)) { while (rows.moveToNext()) { owners.add(rows.getString(0)); positions.add(rows.getInt(1)); } }
        if (owners.isEmpty()) return;
        transaction(() -> {
            for (int index = 0; index < owners.size(); index++) {
                String owner = owners.get(index); int position = positions.get(index);
                JSONObject message = get("message", owner, position); message.put("state", "interrupted").put("notice", notice);
                JSONArray process = message.optJSONArray("process");
                for (int step = 0; process != null && step < process.length(); step++) {
                    JSONObject entry = process.getJSONObject(step); if (entry.optString("status").equals("running")) entry.put("status", "cancelled");
                }
                put("message", owner, position, message, "", 0);
            }
            return null;
        });
    }

    // Called once for migration; verification stays inside the transaction.
    void importLegacy(JSONObject state) throws Exception {
        JSONArray workspaces = state.has("workspaces") ? state.getJSONArray("workspaces") : new JSONArray();
        JSONArray conversations = state.has("conversations") ? state.getJSONArray("conversations") : new JSONArray();
        JSONObject config = state.has("config") ? state.getJSONObject("config") : new JSONObject();
        putVerified("config", "main", 0, config);
        Set<String> workspaceIds = new HashSet<>(), conversationIds = new HashSet<>();
        for (int index = 0; index < workspaces.length(); index++) {
            JSONObject workspace = workspaces.getJSONObject(index); String id = workspace.getString("id");
            if (!workspaceIds.add(id)) throw new IOException("Duplicate local workspace");
            putVerified("workspace", id, 0, workspace);
        }
        for (int index = 0; index < conversations.length(); index++) {
            JSONObject conversation = conversations.getJSONObject(index); String id = conversation.getString("id");
            if (!conversationIds.add(id)) throw new IOException("Duplicate local conversation");
            putVerified("conversation", id, 0, LocalChatRecord.metadata(conversation));
            putVerified("draft", id, 0, LocalChatRecord.draft(conversation));
            JSONArray messages = conversation.getJSONArray("messages");
            for (int position = 0; position < messages.length(); position++) putVerified("message", id, position, messages.getJSONObject(position));
        }
        JSONObject extra = new JSONObject(); var keys = state.keys();
        while (keys.hasNext()) { String name = keys.next(); if (!Set.of("config", "workspaces", "conversations").contains(name)) extra.put(name, state.get(name)); }
        if (extra.length() > 0) putVerified("extra", "main", 0, extra);
    }

    private void putVerified(String kind, String owner, int position, JSONObject value) throws Exception {
        put(kind, owner, position, value, "", 0);
        if (!LocalChatRecord.same(value, get(kind, owner, position))) throw new IOException("Local chat migration verification failed");
    }

    private void collectGarbage() {
        ArrayList<String> references = new ArrayList<>();
        try (Cursor rows = db.rawQuery("SELECT reference FROM garbage WHERE NOT EXISTS(SELECT 1 FROM refs WHERE refs.reference=garbage.reference)", null)) { while (rows.moveToNext()) references.add(rows.getString(0)); }
        AttachmentMaintenance.release(context, references);
    }

    private void maintain(boolean checkpoint) {
        try { collectGarbage(); if (checkpoint) checkpoint(); }
        catch (Exception error) { cleanupError = error; }
    }

    private void pragma(String sql) { try (Cursor result = db.rawQuery(sql, null)) { while (result.moveToNext()) {} } }

    void checkpoint() { try (Cursor result = db.rawQuery("PRAGMA wal_checkpoint(TRUNCATE)", null)) { result.moveToFirst(); } }
    @Override public void close() { checkpoint(); db.close(); }
}
