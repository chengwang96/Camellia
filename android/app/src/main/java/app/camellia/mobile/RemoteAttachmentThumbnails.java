package app.camellia.mobile;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class RemoteAttachmentThumbnails {
    private static final int MAX_PIXELS = 288;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ExecutorService WORKER = Executors.newFixedThreadPool(3, task -> {
        Thread thread = new Thread(task, "remote-attachment-previews");
        thread.setDaemon(true);
        return thread;
    });
    private static final android.util.LruCache<String, Bitmap> CACHE =
        new android.util.LruCache<>(24 * 1024 * 1024) {
            @Override protected int sizeOf(String key, Bitmap value) { return value.getAllocationByteCount(); }
        };
    private static final Map<String, List<MarkdownView.ImageCallback>> PENDING = new HashMap<>();

    private RemoteAttachmentThumbnails() {}

    static void load(String address, String token, String conversation, long seq, int index, long size,
                     MarkdownView.ImageCallback callback) {
        if (seq < 1 || index < 0 || size > ChatAttachments.IMAGE_MAX_BYTES
            || address == null || address.isEmpty() || token == null || conversation == null) {
            callback.failed();
            return;
        }
        String key = address + "\n" + conversation + "\n" + seq + "\n" + index + "\n" + size;
        synchronized (PENDING) {
            Bitmap cached = CACHE.get(key);
            if (cached != null) { callback.loaded(cached); return; }
            List<MarkdownView.ImageCallback> listeners = PENDING.get(key);
            if (listeners != null) { listeners.add(callback); return; }
            listeners = new ArrayList<>();
            listeners.add(callback);
            PENDING.put(key, listeners);
        }
        WORKER.execute(() -> {
            Bitmap bitmap = null;
            RemoteApi request = null;
            try {
                request = new RemoteApi(address);
                String path = "/v1/conversations/" + conversation + "/attachments/" + seq + "/" + index;
                if (size > 0) {
                    ByteArrayOutputStream output = new ByteArrayOutputStream((int) Math.min(size, 512 * 1024));
                    request.download(path, token, output, size, (received, total) -> { });
                    bitmap = decode(output.toByteArray());
                } else {
                    bitmap = decode(request.bytes(path, token, ChatAttachments.IMAGE_MAX_BYTES));
                }
            } catch (Exception ignored) {
            } finally {
                if (request != null) request.cancel();
            }
            Bitmap result = bitmap;
            MAIN.post(() -> finish(key, result));
        });
    }

    private static Bitmap decode(byte[] bytes) {
        if (bytes == null || bytes.length == 0) return null;
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / options.inSampleSize > MAX_PIXELS * 2)
            options.inSampleSize *= 2;
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
    }

    private static void finish(String key, Bitmap bitmap) {
        List<MarkdownView.ImageCallback> listeners;
        synchronized (PENDING) { listeners = PENDING.remove(key); }
        if (listeners == null) return;
        if (bitmap != null) CACHE.put(key, bitmap);
        for (MarkdownView.ImageCallback listener : listeners)
            if (bitmap == null) listener.failed(); else listener.loaded(bitmap);
    }
}
