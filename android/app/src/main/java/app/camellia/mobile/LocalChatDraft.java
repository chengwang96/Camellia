package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class LocalChatDraft {
    static int editIndex(JSONObject conversation) {
        int target = conversation.optInt("draftEditIndex", -1);
        JSONArray messages = conversation.optJSONArray("messages");
        if (messages == null || target < 0 || target >= messages.length()) return -1;
        for (int index = messages.length() - 1; index >= 0; index--) {
            JSONObject message = messages.optJSONObject(index);
            if (message != null && message.optString("role").equals("user")) return index == target ? target : -1;
        }
        return -1;
    }

    static void save(JSONObject conversation, String text, int editIndex) throws JSONException {
        conversation.put("draft", text);
        if (editIndex >= 0) conversation.put("draftEditIndex", editIndex);
        else conversation.remove("draftEditIndex");
    }

    static JSONArray images(JSONObject conversation) throws JSONException {
        JSONArray saved = conversation.optJSONArray("draftImages");
        if (saved != null) return new JSONArray(saved.toString());
        int target = editIndex(conversation);
        JSONArray original = target < 0 ? null : conversation.getJSONArray("messages").getJSONObject(target).optJSONArray("images");
        return original == null ? new JSONArray() : new JSONArray(original.toString());
    }

    static void save(JSONObject conversation, String text, int editIndex, java.util.List<String> images) throws JSONException {
        save(conversation, text, editIndex);
        conversation.put("draftImages", new JSONArray(images));
    }
}
