package app.camellia.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import java.io.ByteArrayOutputStream;
import java.io.IOException;

// Both chat modes use the same resolution, quality and compressed size limit.
final class ChatImage {
    static final String MEDIA_TYPE = "image/jpeg";
    static final int DESKTOP_MAX_SIDE = ChatAttachments.IMAGE_MAX_SIDE, DESKTOP_MAX_BYTES = ChatAttachments.IMAGE_MAX_BYTES;
    static final int PHONE_MAX_SIDE = DESKTOP_MAX_SIDE, PHONE_MAX_BYTES = DESKTOP_MAX_BYTES;
    static final int PHONE_MAX_IMAGES = ChatAttachments.MAX_COUNT;

    private ChatImage() {}

    static String encode(Context context, Uri uri, int maxSide, int maxBytes) throws Exception {
        BitmapFactory.Options options = new BitmapFactory.Options(); options.inJustDecodeBounds = true;
        try (var input = context.getContentResolver().openInputStream(uri)) { BitmapFactory.decodeStream(input, null, options); }
        if (options.outWidth <= 0 || options.outHeight <= 0) throw new IOException("Unreadable image");
        options.inJustDecodeBounds = false; options.inSampleSize = 1;
        while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > maxSide * 2) options.inSampleSize *= 2;
        Bitmap bitmap;
        try (var input = context.getContentResolver().openInputStream(uri)) { bitmap = BitmapFactory.decodeStream(input, null, options); }
        if (bitmap == null) throw new IOException("Unreadable image");
        int longest = Math.max(bitmap.getWidth(), bitmap.getHeight());
        if (longest > maxSide) {
            Bitmap scaled = Bitmap.createScaledBitmap(bitmap, Math.max(1, Math.round(bitmap.getWidth() * (float) maxSide / longest)),
                Math.max(1, Math.round(bitmap.getHeight() * (float) maxSide / longest)), true);
            if (scaled != bitmap) bitmap.recycle(); bitmap = scaled;
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        ByteArrayOutputStream previewBytes = new ByteArrayOutputStream();
        try {
            for (int quality = 90; quality >= 60; quality -= 5) {
                bytes.reset(); bitmap.compress(Bitmap.CompressFormat.JPEG, quality, bytes);
                if (bytes.size() <= maxBytes) break;
            }
            float scale = Math.min(1f, 384f / Math.max(bitmap.getWidth(), bitmap.getHeight()));
            Bitmap thumbnail = Bitmap.createScaledBitmap(bitmap, Math.max(1, Math.round(bitmap.getWidth() * scale)), Math.max(1, Math.round(bitmap.getHeight() * scale)), true);
            try { thumbnail.compress(Bitmap.CompressFormat.JPEG, 82, previewBytes); } finally { if (thumbnail != bitmap) thumbnail.recycle(); }
        } finally { bitmap.recycle(); }
        if (bytes.size() > maxBytes) throw new IOException("Image too large");
        String reference = AttachmentStore.save(context, bytes.toByteArray());
        try { AttachmentStore.savePreview(context, reference, previewBytes.toByteArray()); }
        catch (Exception error) { AttachmentStore.remove(context, reference); throw error; }
        return reference;
    }

    static String dataUrl(String encoded) { return "data:" + MEDIA_TYPE + ";base64," + encoded; }
}
