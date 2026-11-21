package app.camellia.mobile;

import android.content.Context;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** A long clipboard block becomes a text attachment, as it does on the desktop. */
final class LongPaste {
    static final int MIN_CHARS = 5000;

    private LongPaste() {}

    static boolean shouldAttach(CharSequence value) {
        if (value == null || value.toString().trim().isEmpty()) return false;
        return value.length() >= MIN_CHARS;
    }

    /**
     * Stores the text as the same kind of document the file picker produces.
     * Both the UTF-8 bytes and a sealed text copy are kept, so local chat can
     * show the text while remote chat sends the original bytes.
     */
    static JSONObject attach(Context context, CharSequence value) throws Exception {
        String text = value.toString();
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > ChatAttachments.DOCUMENT_MAX_BYTES)
            throw new java.io.IOException("粘贴的文本超过 10 MiB / Pasted text exceeds 10 MiB");
        String reference = AttachmentStore.save(context, bytes);
        String textReference = null;
        try {
            textReference = AttachmentStore.saveText(context, text);
            return new JSONObject()
                .put("name", "pasted-text-" + System.currentTimeMillis() + "-" + java.util.UUID.randomUUID() + ".txt")
                .put("data", reference)
                .put("size", bytes.length)
                .put("mimeType", "text/plain")
                .put("isImage", false)
                .put("text", textReference);
        } catch (Exception error) {
            AttachmentStore.remove(context, reference);
            AttachmentStore.remove(context, textReference);
            throw error;
        }
    }

    static String notice(int characters, boolean chinese) {
        return chinese
            ? String.format(Locale.ROOT, "粘贴的文本已转为 .txt 附件 · %d 个字符", characters)
            : String.format(Locale.ROOT, "Pasted text is now a .txt attachment · %d characters", characters);
    }
}
