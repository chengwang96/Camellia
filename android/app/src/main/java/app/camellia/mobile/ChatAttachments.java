package app.camellia.mobile;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.List;

/** The phone uses one selection policy in both chat modes. Only remote has a transfer budget. */
final class ChatAttachments {
    static final int MAX_COUNT = 20;
    static final int IMAGE_MAX_BYTES = 4 * 1024 * 1024;
    static final int IMAGE_MAX_SIDE = 3072;
    static final int DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
    static final long REMOTE_MAX_BYTES = 32L * 1024 * 1024;
    private static final int LEGACY_REMOTE_COUNT = 9;
    private static final long LEGACY_REMOTE_BYTES = 8L * 1024 * 1024;

    private ChatAttachments() {}

    static String limits(boolean chinese, boolean remote) {
        return chinese ? "最多 20 个附件 · 图片 4 MiB/张 · 文档 10 MiB/个" + (remote ? " · 合计 32 MiB" : "")
            : "Up to 20 attachments · 4 MiB/image · 10 MiB/document" + (remote ? " · 32 MiB total" : "");
    }

    static void validate(Context context, List<String> images, List<JSONObject> documents, boolean remote) throws IOException {
        if (images.size() + documents.size() > MAX_COUNT) throw new IOException("每条消息最多 20 个附件 / Up to 20 attachments per message");
        long total = 0;
        for (String image : images) {
            long size = AttachmentStore.size(context, image);
            if (size > IMAGE_MAX_BYTES) throw new IOException("图片压缩后不能超过 4 MiB / Compressed image exceeds 4 MiB");
            total += size;
        }
        for (JSONObject document : documents) {
            long size = AttachmentStore.size(context, document.optString("data"));
            if (size > DOCUMENT_MAX_BYTES) throw new IOException("单个文档不能超过 10 MiB / Document exceeds 10 MiB");
            total += size;
        }
        if (remote && total > REMOTE_MAX_BYTES) throw new IOException("远程附件合计不能超过 32 MiB / Remote attachments exceed 32 MiB total");
    }

    static int remoteCount(boolean expanded, boolean files, boolean multiImage) {
        return expanded ? MAX_COUNT : files || multiImage ? LEGACY_REMOTE_COUNT : 1;
    }

    static void validateRemote(Context context, List<String> images, List<JSONObject> documents,
                               boolean expanded, boolean files, boolean multiImage) throws IOException {
        validate(context, images, documents, true);
        if (expanded) return;
        int count = remoteCount(false, files, multiImage);
        if (images.size() + documents.size() > count)
            throw new IOException("当前电脑最多 " + count + " 个附件，更新电脑端可提高限额 / This desktop supports " + count + " attachments; update it for higher limits");
        if (files) {
            long total = 0;
            for (String image : images) total += AttachmentStore.size(context, image);
            for (JSONObject document : documents) total += AttachmentStore.size(context, document.optString("data"));
            if (total > LEGACY_REMOTE_BYTES)
                throw new IOException("当前电脑附件合计最多 8 MiB，更新电脑端可提高至 32 MiB / This desktop supports 8 MiB total; update it for 32 MiB");
        } else {
            if (!documents.isEmpty()) throw new IOException("发送文档需要更新并重启电脑端 / Update and restart the desktop to send documents");
            for (String image : images) if (AttachmentStore.size(context, image) > 1024 * 1024)
                throw new IOException("当前电脑每张图片最多 1 MiB，更新电脑端可提高限额 / This desktop supports 1 MiB per image; update it for higher limits");
        }
    }

    static JSONArray remote(List<String> images, List<JSONObject> documents) throws Exception {
        JSONArray files = new JSONArray();
        for (int index = 0; index < images.size(); index++) files.put(new JSONObject()
            .put("name", "mobile-image-" + (index + 1) + ".jpg").put("data", images.get(index)).put("isImage", true));
        for (JSONObject document : documents) files.put(new JSONObject().put("name", document.getString("name"))
            .put("data", document.getString("data")).put("isImage", false));
        return files;
    }

    static void discard(Context context, List<String> images, List<JSONObject> documents) {
        AttachmentMaintenance.release(context, images, documents);
    }

    static void restore(JSONObject payload, List<String> images, List<JSONObject> documents) throws Exception {
        images.clear(); documents.clear();
        JSONArray files = payload.optJSONArray("attachments");
        if (files != null) {
            for (int index = 0; index < files.length(); index++) {
                JSONObject file = files.getJSONObject(index);
                if (file.optBoolean("isImage")) images.add(file.getString("data"));
                else documents.add(new JSONObject(file.toString()));
            }
        } else {
            JSONArray legacy = payload.optJSONArray("images");
            if (legacy != null) for (int index = 0; index < legacy.length(); index++) images.add(legacy.getString(index));
            else if (payload.has("image")) images.add(payload.getString("image"));
        }
    }
}
