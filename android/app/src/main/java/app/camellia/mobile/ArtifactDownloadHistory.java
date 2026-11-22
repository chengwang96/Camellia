package app.camellia.mobile;

import android.content.Context;
import android.net.Uri;
import org.json.JSONArray;
import org.json.JSONObject;

/** Completed artifact destinations kept so reopened file details offer Open. */
final class ArtifactDownloadHistory {
    private static final String PREFERENCES = "artifact-downloads";
    private static final String COMPLETED = "completed";
    private static final int LIMIT = 40;
    private static final Object LOCK = new Object();

    static final class Entry {
        final String name;
        final Uri destination;

        Entry(String name, Uri destination) {
            this.name = name;
            this.destination = destination;
        }
    }

    static Entry find(Context context, String address, String conversation, boolean discussion, String artifact) {
        if (context == null || empty(address) || empty(conversation) || empty(artifact)) return null;
        String key = key(address, conversation, discussion, artifact);
        JSONArray entries = read(context);
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.optJSONObject(index);
            if (entry == null || !key.equals(entry.optString("key"))) continue;
            Uri destination = contentUri(entry.optString("destination"));
            return destination == null ? null : new Entry(entry.optString("name"), destination);
        }
        return null;
    }

    static void complete(Context context, String address, String conversation, boolean discussion,
                         String artifact, String name, Uri destination) {
        if (context == null || empty(address) || empty(conversation) || empty(artifact) || destination == null) return;
        Uri safe = contentUri(destination.toString());
        if (safe == null) return;
        String key = key(address, conversation, discussion, artifact);
        synchronized (LOCK) {
            JSONArray previous = read(context);
            JSONArray next = new JSONArray();
            try {
                next.put(new JSONObject().put("key", key).put("name", name == null ? "" : name)
                    .put("destination", safe.toString()).put("completedAt", System.currentTimeMillis()));
                for (int index = 0; index < previous.length() && next.length() < LIMIT; index++) {
                    JSONObject entry = previous.optJSONObject(index);
                    if (entry != null && !key.equals(entry.optString("key"))) next.put(entry);
                }
            } catch (Exception ignored) {
                return;
            }
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
                .putString(COMPLETED, next.toString()).apply();
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
