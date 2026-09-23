package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class RemoteListCache {
    private final CredentialStore storage;
    private final ExecutorService writer = Executors.newSingleThreadExecutor();
    private final JSONObject entries;

    RemoteListCache(CredentialStore storage) {
        this.storage = storage;
        JSONObject loaded;
        try { loaded = storage.load(); } catch (Exception error) { loaded = new JSONObject(); }
        entries = loaded;
    }

    private String key(JSONObject credentials) {
        return credentials.optString("address") + "/" + credentials.optString("token");
    }

    JSONObject get(JSONObject credentials) {
        JSONObject entry = entries.optJSONObject(key(credentials));
        try { return entry == null ? null : new JSONObject(entry.toString()); }
        catch (Exception error) { return null; }
    }

    void put(JSONObject credentials, JSONArray conversations, int nextOffset, JSONArray workspaces, boolean independent) {
        if (!credentials.has("token")) return;
        try {
            JSONArray bounded = new JSONArray();
            for (int index = 0; index < Math.min(1000, conversations.length()); index++) bounded.put(conversations.get(index));
            entries.put(key(credentials), new JSONObject().put("conversations", bounded)
                .put("nextOffset", conversations.length() > 1000 ? 1000 : nextOffset)
                .put("workspaces", workspaces).put("includeUnassigned", independent));
            while (entries.length() > 20) {
                var keys = entries.keys();
                String evicted = keys.next();
                if (evicted.equals(key(credentials))) evicted = keys.next();
                entries.remove(evicted);
            }
            persist();
        } catch (Exception ignored) { }
    }

    void remove(JSONObject credentials) {
        entries.remove(key(credentials));
        persist();
    }

    private void persist() {
        String snapshot = entries.toString();
        writer.submit(() -> { try { storage.save(new JSONObject(snapshot)); } catch (Exception ignored) { } });
    }

    void close() { writer.shutdown(); }
}
