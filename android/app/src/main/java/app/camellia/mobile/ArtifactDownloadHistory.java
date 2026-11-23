package app.camellia.mobile;

import android.content.Context;
import android.net.Uri;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Completed artifact destinations kept for reopening details and managing saved files. */
final class ArtifactDownloadHistory {
    private static final String PREFERENCES = "artifact-downloads";
    private static final String COMPLETED = "completed";
    private static final Object LOCK = new Object();

    static final class Entry {
        final String id;
        final String key;
        final String name;
        final Uri destination;
        final long completedAt;
        final long size;

        Entry(String id, String key, String name, Uri destination, long completedAt, long size) {
            this.id = id;
            this.key = key;
            this.name = name;
            this.destination = destination;
            this.completedAt = completedAt;
            this.size = size;
        }
    }

    static Entry find(Context context, String address, String conversation, boolean discussion, String artifact) {
        if (context == null || empty(address) || empty(conversation) || empty(artifact)) return null;
        String key = key(address, conversation, discussion, artifact);
        JSONArray entries = read(context);
        Entry latest = null;
        for (int index = 0; index < entries.length(); index++) {
            Entry entry = entry(entries.optJSONObject(index));
            if (entry == null || !key.equals(entry.key)) continue;
            if (latest == null || entry.completedAt > latest.completedAt) latest = entry;
        }
        return latest;
    }

    /** Every distinct saved file, newest first. A destination is listed once. */
    static List<Entry> all(Context context) {
        if (context == null) return new ArrayList<>();
        JSONArray entries = read(context);
        Map<String, Entry> unique = new LinkedHashMap<>();
        for (int index = 0; index < entries.length(); index++) {
            Entry entry = entry(entries.optJSONObject(index));
            if (entry == null) continue;
            String destination = entry.destination.toString();
            Entry previous = unique.get(destination);
            if (previous == null || entry.completedAt >= previous.completedAt) unique.put(destination, entry);
        }
        List<Entry> result = new ArrayList<>(unique.values());
        result.sort((left, right) -> Long.compare(right.completedAt, left.completedAt));
        return result;
    }

    static void complete(Context context, String address, String conversation, boolean discussion,
                         String artifact, String name, Uri destination) {
        complete(context, address, conversation, discussion, artifact, name, destination, -1);
    }

    static void complete(Context context, String address, String conversation, boolean discussion,
                         String artifact, String name, Uri destination, long size) {
        if (context == null || empty(address) || empty(conversation) || empty(artifact) || destination == null) return;
        Uri safe = contentUri(destination.toString());
        if (safe == null) return;
        String key = key(address, conversation, discussion, artifact);
        synchronized (LOCK) {
            JSONArray previous = read(context);
            JSONArray next = new JSONArray();
            try {
                long completedAt = System.currentTimeMillis();
                JSONObject saved = new JSONObject().put("key", key).put("name", name == null ? "" : name)
                    .put("destination", safe.toString()).put("completedAt", completedAt);
                if (size >= 0) saved.put("size", size);
                next.put(saved);
                for (int index = 0; index < previous.length(); index++) {
                    JSONObject entry = previous.optJSONObject(index);
                    if (entry == null) continue;
                    Uri existing = contentUri(entry.optString("destination"));
                    if (existing == null || !safe.equals(existing)) next.put(entry);
                }
            } catch (Exception ignored) {
                return;
            }
            write(context, next);
        }
    }

    /** Removes records by their stable per-download id; files are handled by the caller. */
    static void remove(Context context, Collection<String> ids) {
        if (context == null || ids == null || ids.isEmpty()) return;
        Set<String> targets = new HashSet<>(ids);
        synchronized (LOCK) {
            JSONArray previous = read(context);
            JSONArray next = new JSONArray();
            for (int index = 0; index < previous.length(); index++) {
                JSONObject raw = previous.optJSONObject(index);
                Entry entry = entry(raw);
                if (entry != null && targets.contains(entry.id)) continue;
                if (raw != null) next.put(raw);
            }
            write(context, next);
        }
    }

    static void clear(Context context) {
        if (context == null) return;
        synchronized (LOCK) {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().remove(COMPLETED).apply();
        }
    }

    private static String key(String address, String conversation, boolean discussion, String artifact) {
        return (discussion ? "discussion:" : "conversation:") + conversation + "\n" + address + "\n" + artifact;
    }

    private static JSONArray read(Context context) {
        try {
            return new JSONArray(context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                .getString(COMPLETED, "[]"));
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }

    private static void write(Context context, JSONArray entries) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
            .putString(COMPLETED, entries.toString()).apply();
    }

    private static Entry entry(JSONObject saved) {
        if (saved == null) return null;
        Uri destination = contentUri(saved.optString("destination"));
        if (destination == null) return null;
        long completedAt = saved.optLong("completedAt", 0);
        String id = saved.optString("recordId", "");
        if (empty(id)) id = destination + "\n" + completedAt;
        return new Entry(id, saved.optString("key"), saved.optString("name"), destination,
            completedAt, saved.optLong("size", -1));
    }

    private static Uri contentUri(String value) {
        if (empty(value)) return null;
        try {
            Uri uri = Uri.parse(value);
            return "content".equals(uri.getScheme()) ? uri : null;
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static boolean empty(String value) {
        return value == null || value.trim().isEmpty();
    }

    private ArtifactDownloadHistory() {}
}
