package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

final class ConversationPreview {
    final String name;
    final boolean image;
    final int count;

    private ConversationPreview(String name, boolean image, int count) {
        this.name = name; this.image = image; this.count = count;
    }

    static ConversationPreview remote(JSONObject conversation) {
        JSONObject file = conversation.optJSONObject("filePreview");
        if (file == null || file.optString("name").isEmpty()) return null;
        String name = file.optString("name").replace('\\', '/');
        name = name.substring(name.lastIndexOf('/') + 1).replaceAll("[\\p{Cntrl}\\u202a-\\u202e\\u2066-\\u2069]", "");
        if (name.isEmpty()) return null;
        return new ConversationPreview(name.substring(0, Math.min(180, name.length())), file.optBoolean("isImage"), Math.max(1, Math.min(100, file.optInt("count", 1))));
    }

    static ConversationPreview local(JSONObject conversation, boolean chinese) {
        JSONArray messages = conversation.optJSONArray("messages");
        if (messages == null) return null;
        for (int index = messages.length() - 1; index >= 0; index--) {
            JSONObject message = messages.optJSONObject(index);
            if (message == null || !message.optString("role").equals("user")) continue;
            JSONArray files = message.optJSONArray("attachments");
            boolean documents = files == null;
            if (documents) files = message.optJSONArray("documents");
            JSONArray images = message.optJSONArray("images");
            if (files != null && files.length() > 0) {
                JSONObject first = files.optJSONObject(0);
                if (first != null && !first.optString("name").isEmpty()) {
                    try { return remote(new JSONObject().put("filePreview", new JSONObject().put("name", first.optString("name"))
                        .put("isImage", first.optBoolean("isImage")).put("count", files.length() + (documents && images != null ? images.length() : 0)))); } catch (Exception ignored) { }
                }
            }
            if (images != null && images.length() > 0) return new ConversationPreview(chinese ? "图片附件" : "Image attachment", true, images.length());
        }
        return null;
    }
}
