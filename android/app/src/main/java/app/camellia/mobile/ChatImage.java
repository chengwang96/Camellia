package app.camellia.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import java.io.ByteArrayOutputStream;
import java.io.IOException;

// Both chat modes attach pictures the same way: downscale, re-encode as JPEG and
// keep base64 without the data URL prefix. Limits differ because the desktop
// accepts larger uploads than the phone's direct API request cap.
final class ChatImage {
    static final String MEDIA_TYPE = "image/jpeg";
    static final int DESKTOP_MAX_SIDE = 1600, DESKTOP_MAX_BYTES = 1024 * 1024;
    static final int PHONE_MAX_SIDE = 1024, PHONE_MAX_BYTES = 384 * 1024;
    static final int PHONE_MAX_IMAGES = 4;
    static final long PHONE_MAX_CHARS = 1_500_000;

    private ChatImage() {}

    static String encode(Context context, Uri uri, int maxSide, int maxBytes) throws Exception {
        BitmapFactory.Options options = new BitmapFactory.Options(); options.inJustDecodeBounds = true;
        try (var input = context.getContentResolver().openInputStream(uri)) { BitmapFactory.decodeStream(input, null, options); }
        if (options.outWidth <= 0 || options.outHeight <= 0) throw new IOException("Unreadable image");
        options.inJustDecodeBounds = false; options.inSampleSize = 1;
        while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > maxSide) options.inSampleSize *= 2;
        Bitmap bitmap;
        try (var input = context.getContentResolver().openInputStream(uri)) { bitmap = BitmapFactory.decodeStream(input, null, options); }
        if (bitmap == null) throw new IOException("Unreadable image");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try { bitmap.compress(Bitmap.CompressFormat.JPEG, 82, bytes); } finally { bitmap.recycle(); }
        if (bytes.size() > maxBytes) throw new IOException("Image too large");
        return android.util.Base64.encodeToString(bytes.toByteArray(), android.util.Base64.NO_WRAP);
    }

    static String dataUrl(String encoded) { return "data:" + MEDIA_TYPE + ";base64," + encoded; }
}
