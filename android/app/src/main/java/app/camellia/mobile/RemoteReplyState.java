package app.camellia.mobile;

import android.content.SharedPreferences;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

final class RemoteReplyState {
    private final SharedPreferences preferences;

    RemoteReplyState(SharedPreferences preferences) { this.preferences = preferences; }

    private String key(JSONObject credentials, JSONObject conversation) {
        String scope = credentials.optString("address") + "\n" + credentials.optString("token") + "\n" + conversation.optString("id");
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(scope.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder("reply:");
            for (byte value : digest) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            return result.toString();
        } catch (java.security.NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }

    boolean unread(JSONObject credentials, JSONObject conversation) {
        return conversation.optLong("lastReplyAt", 0) > Math.max(conversation.optLong("replyReadAt", 0), preferences.getLong(key(credentials, conversation), 0));
    }

    void markRead(JSONObject credentials, JSONObject conversation) {
        long reply = conversation.optLong("lastReplyAt", 0);
        String key = key(credentials, conversation);
        if (reply > preferences.getLong(key, 0)) preferences.edit().putLong(key, reply).apply();
    }
}
