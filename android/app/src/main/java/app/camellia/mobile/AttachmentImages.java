package app.camellia.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import android.util.LruCache;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Function;

/** Sent-image previews and larger gallery images share bounded, credential-scoped resources. */
final class AttachmentImages {
    private static final int MIB = 1024 * 1024;
    private static final int FULL_BUDGET = (int) Math.max(4L * MIB, Math.min(32L * MIB, Runtime.getRuntime().maxMemory() / 8));
    private static final int FULL_SIDE = Math.min(2048, (int) Math.sqrt(FULL_BUDGET / 4));
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ExecutorService PREVIEWS = Executors.newFixedThreadPool(3, task -> thread(task, "attachment-previews"));
    private static final ExecutorService GALLERY = Executors.newSingleThreadExecutor(task -> thread(task, "attachment-gallery"));
    private static final LruCache<String, Bitmap> THUMBNAILS = bitmaps(24 * MIB), IMAGES = bitmaps(FULL_BUDGET);
    private static final LruCache<String, byte[]> BYTES = new LruCache<>(8 * MIB) {
        @Override protected int sizeOf(String key, byte[] value) { return value.length; }
    };
    private static final Map<String, List<MarkdownView.ImageCallback>> PENDING = new HashMap<>();
    private static final Map<String, Object> READS = new ConcurrentHashMap<>();
    private interface Reader { byte[] read() throws Exception; }

    static final class Source {
        private final String key;
        private final Reader reader, preview;
        private Source(String identity, Reader reader, Reader preview) {
            key = key(identity); this.reader = reader; this.preview = preview;
        }
        Bitmap bitmap() { return IMAGES.get(key); }
        void preview(MarkdownView.ImageCallback callback) { load(false, callback); }
        void load(MarkdownView.ImageCallback callback) { load(true, callback); }
        private byte[] bytes() throws Exception {
            Object lock = READS.computeIfAbsent(key, ignored -> new Object());
            try {
                synchronized (lock) {
                    byte[] bytes = BYTES.get(key);
                    if (bytes == null) {
                        bytes = reader.read();
                        if (bytes.length > ChatAttachments.IMAGE_MAX_BYTES) throw new IOException("Image exceeds attachment limit");
                        BYTES.put(key, bytes);
                    }
                    return bytes;
                }
            } finally { READS.remove(key, lock); }
        }
        private void load(boolean full, MarkdownView.ImageCallback callback) {
            LruCache<String, Bitmap> cache = full ? IMAGES : THUMBNAILS;
            Bitmap cached = cache.get(key);
            if (cached != null) { callback.loaded(cached); return; }
            String pendingKey = (full ? "full:" : "preview:") + key;
            synchronized (PENDING) {
                List<MarkdownView.ImageCallback> waiting = PENDING.get(pendingKey);
                if (waiting != null) { waiting.add(callback); return; }
                waiting = new ArrayList<>(); waiting.add(callback); PENDING.put(pendingKey, waiting);
            }
            (full ? GALLERY : PREVIEWS).execute(() -> {
                Bitmap bitmap = null;
                try { bitmap = decode(!full && preview != null ? preview.read() : bytes(), full ? FULL_SIDE : 288); }
                catch (Exception ignored) { }
                Bitmap result = bitmap;
                MAIN.post(() -> {
                    List<MarkdownView.ImageCallback> waiting;
                    synchronized (PENDING) { waiting = PENDING.remove(pendingKey); }
                    if (result != null) cache.put(key, result);
                    if (waiting != null) for (MarkdownView.ImageCallback listener : waiting)
                        if (result == null) listener.failed(); else listener.loaded(result);
                });
            });
        }
    }

    static Source local(Context context, String reference) {
        Context application = context.getApplicationContext();
        return new Source("local\n" + application.getNoBackupFilesDir() + "\n" + reference,
            () -> {
                if (AttachmentStore.size(application, reference) > ChatAttachments.IMAGE_MAX_BYTES) throw new IOException("Image exceeds attachment limit");
                return AttachmentStore.read(application, reference);
            }, () -> AttachmentStore.preview(application, reference));
    }

    static Source remote(String address, String token, String conversation, long seq, int index, long size, Function<String, RemoteApi> clients) {
        return new Source("remote\n" + address + "\n" + token + "\n" + conversation + "\n" + seq + "\n" + index + "\n" + size, () -> {
            if (seq < 1 || index < 0 || index >= ChatAttachments.MAX_COUNT || size > ChatAttachments.IMAGE_MAX_BYTES
                    || address == null || address.isEmpty() || token == null || conversation == null)
                throw new IOException("Invalid image attachment");
            RemoteApi request = clients.apply(address);
            try {
                String path = "/v1/conversations/" + conversation + "/attachments/" + seq + "/" + index;
                if (size <= 0) return request.bytes(path, token, ChatAttachments.IMAGE_MAX_BYTES);
                ByteArrayOutputStream output = new ByteArrayOutputStream((int) Math.min(size, 512 * 1024));
                request.download(path, token, output, size, (received, total) -> { });
                return output.toByteArray();
            } finally { request.cancel(); }
        }, null);
    }

    private static Bitmap decode(byte[] bytes, int side) {
        if (bytes == null || bytes.length == 0 || bytes.length > ChatAttachments.IMAGE_MAX_BYTES) return null;
        BitmapFactory.Options options = new BitmapFactory.Options(); options.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        if (options.outWidth <= 0 || options.outHeight <= 0) return null;
        options.inJustDecodeBounds = false; options.inSampleSize = 1;
        while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > side) options.inSampleSize *= 2;
        Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        if (bitmap == null) return null;
        float scale = Math.min(1f, (float) side / Math.max(bitmap.getWidth(), bitmap.getHeight()));
        if (scale == 1f) return bitmap;
        Bitmap scaled = Bitmap.createScaledBitmap(bitmap, Math.max(1, Math.round(bitmap.getWidth() * scale)), Math.max(1, Math.round(bitmap.getHeight() * scale)), true);
        if (scaled != bitmap) bitmap.recycle();
        return scaled;
    }

    private static LruCache<String, Bitmap> bitmaps(int budget) {
        return new LruCache<>(budget) {
            @Override protected int sizeOf(String key, Bitmap value) { return value.getAllocationByteCount(); }
        };
    }
    private static String key(String identity) {
        try {
            return android.util.Base64.encodeToString(java.security.MessageDigest.getInstance("SHA-256")
                .digest(identity.getBytes(java.nio.charset.StandardCharsets.UTF_8)), android.util.Base64.NO_WRAP);
        } catch (java.security.NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }
    private static Thread thread(Runnable task, String name) { Thread thread = new Thread(task, name); thread.setDaemon(true); return thread; }
    private AttachmentImages() { }
}
