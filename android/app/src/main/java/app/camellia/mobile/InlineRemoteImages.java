package app.camellia.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

final class InlineRemoteImages implements MarkdownView.ImageLoader {
    private static final long MAX_IMAGE_BYTES = 32L * 1024 * 1024;
    private static final long MAX_VIDEO_BYTES = 512L * 1024 * 1024;
    private static final java.util.regex.Pattern IMAGE_EXTENSION = java.util.regex.Pattern.compile("(?i).+\\.(?:png|jpe?g|gif|webp|bmp|avif|ico)");
    private static final java.util.regex.Pattern VIDEO_EXTENSION = java.util.regex.Pattern.compile("(?i).+\\.(?:mp4|m4v|mov|webm)");
    private static final java.util.regex.Pattern MEDIA_MARKDOWN = java.util.regex.Pattern.compile("!\\[[^\\]\\n]*\\]\\(<?((?:[^()\\n]|\\([^()\\n]*\\))+?)>?\\)");
    private static final ExecutorService WORKER = Executors.newFixedThreadPool(4, task -> {
        Thread thread = new Thread(task, "inline-images"); thread.setDaemon(true); return thread;
    });
    private static final OkHttpClient WEB = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(25, TimeUnit.SECONDS).build();
    private final Context context;
    private final String address, token, conversation;
    private final long seq;
    private final Function<String, RemoteApi> apiFactory;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final android.util.LruCache<String, Bitmap> cache = new android.util.LruCache<>(48 * 1024 * 1024) {
        @Override protected int sizeOf(String key, Bitmap value) { return value.getAllocationByteCount(); }
    };
    private final Map<String, List<MarkdownView.ImageCallback>> pending = new HashMap<>();
    private final Map<String, List<MarkdownView.VideoCallback>> videoPending = new HashMap<>();
    private final Map<String, File> videoFiles = new HashMap<>();
    private final Set<RemoteApi> requests = ConcurrentHashMap.newKeySet();
    private final Set<Call> webRequests = ConcurrentHashMap.newKeySet();
    private volatile boolean closed;

    InlineRemoteImages(Context context, String address, String token, String conversation, long seq) {
        this(context, address, token, conversation, seq, RemoteApi::new);
    }

    InlineRemoteImages(Context context, String address, String token, String conversation, long seq,
                       Function<String, RemoteApi> apiFactory) {
        this.context = context.getApplicationContext(); this.address = address; this.token = token;
        this.conversation = conversation; this.seq = seq; this.apiFactory = apiFactory;
    }

    private static String mediaPath(String reference) {
        if (reference == null || reference.isEmpty() || reference.length() > 4096 || reference.matches(".*[\\x00-\\x1f\\x7f].*")) return null;
        String path = reference;
        if (remote(reference) != null) {
            try { path = URI.create(reference).getPath(); }
            catch (Exception error) { return null; }
            if (path == null) return null;
        } else if (reference.matches("(?i)^[a-z][a-z\\d+.-]*:.*") && !reference.matches("(?i)^(?:file:|[a-z]:[\\\\/]).*")) return null;
        int query = path.indexOf('?'), anchor = path.indexOf('#');
        if (query >= 0) path = path.substring(0, query);
        if (anchor >= 0) path = path.substring(0, anchor);
        return path;
    }

    static boolean supportedImage(String reference) {
        String path = mediaPath(reference);
        return path != null && IMAGE_EXTENSION.matcher(path).matches();
    }

    static boolean supportedVideo(String reference) {
        String path = mediaPath(reference);
        return path != null && VIDEO_EXTENSION.matcher(path).matches();
    }

    static boolean supported(String reference) {
        return supportedImage(reference) || supportedVideo(reference);
    }

    static boolean hasSupportedImage(String text) {
        if (text == null || !text.contains("![")) return false;
        java.util.regex.Matcher matcher = MEDIA_MARKDOWN.matcher(text.replaceAll("(?s)```.*?(?:```|$)", ""));
        while (matcher.find()) if (supportedImage(matcher.group(1).replaceAll("\\s+\"[^\"]*\"$", "").trim())) return true;
        return false;
    }

    static boolean hasSupportedMedia(String text) {
        if (text == null || !text.contains("![")) return false;
        java.util.regex.Matcher matcher = MEDIA_MARKDOWN.matcher(text.replaceAll("(?s)```.*?(?:```|$)", ""));
        while (matcher.find()) if (supported(matcher.group(1).replaceAll("\\s+\"[^\"]*\"$", "").trim())) return true;
        return false;
    }

    private static URI remote(String reference) {
        try {
            URI uri = URI.create(reference);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(java.util.Locale.ROOT);
            return (scheme.equals("http") || scheme.equals("https")) && uri.getHost() != null && uri.getUserInfo() == null ? uri : null;
        } catch (Exception error) { return null; }
    }

    @Override public void load(String reference, MarkdownView.ImageCallback callback) {
        if (closed || !supportedImage(reference) || (remote(reference) == null && (seq < 1 || conversation == null || conversation.isEmpty()))) {
            callback.failed(); return;
        }
        Bitmap cached = cache.get(reference);
        if (cached != null) { callback.loaded(cached); return; }
        List<MarkdownView.ImageCallback> listeners = pending.get(reference);
        if (listeners != null) { listeners.add(callback); return; }
        listeners = new ArrayList<>(); listeners.add(callback); pending.put(reference, listeners);
        WORKER.execute(() -> {
            if (closed) return;
            Bitmap bitmap = null;
            try { bitmap = remote(reference) == null ? artifact(reference) : web(reference); }
            catch (Exception ignored) { }
            Bitmap result = bitmap;
            handler.post(() -> finish(reference, result));
        });
    }

    private void finish(String reference, Bitmap bitmap) {
        List<MarkdownView.ImageCallback> listeners = pending.remove(reference);
        if (listeners == null) return;
        if (closed) return;
        if (bitmap != null) cache.put(reference, bitmap);
        for (MarkdownView.ImageCallback listener : listeners) {
            if (bitmap == null) listener.failed(); else listener.loaded(bitmap);
        }
    }

    private Bitmap artifact(String reference) throws Exception {
        File temporary = File.createTempFile("camellia-inline-", ".image", context.getCacheDir());
        RemoteApi request = null;
        try {
            request = apiFactory.apply(address); requests.add(request);
            String route = "/v1/conversations/" + conversation + "/artifacts?offset=0&seq=" + seq + "&reference=" + ArtifactReferences.query(reference);
            JSONObject result = request.json(route, token, null);
            JSONArray files = result.getJSONArray("artifacts");
            JSONObject selected = null;
            for (int index = 0; index < files.length(); index++) {
                JSONObject file = files.optJSONObject(index);
                if (file == null || !supportedImage(file.optString("name")) || file.optLong("size") < 0 || file.optLong("size") > MAX_IMAGE_BYTES) continue;
                if (!file.optString("id").matches("[a-f0-9]{64}")) continue;
                selected = file; break;
            }
            if (selected == null) throw new IOException("Image unavailable");
            String download = "/v1/conversations/" + conversation + "/artifacts/" + selected.getString("id");
            try (var output = new FileOutputStream(temporary)) {
                request.download(download, token, output, selected.getLong("size"), (read, total) -> { });
            }
            return decode(temporary);
        } finally {
            if (request != null) { requests.remove(request); request.cancel(); }
            temporary.delete();
        }
    }

    private Bitmap web(String reference) throws Exception {
        File temporary = File.createTempFile("camellia-inline-web-", ".image", context.getCacheDir());
        Call call = null;
        try {
            call = WEB.newCall(new Request.Builder().url(reference).header("Accept", "image/*").build()); webRequests.add(call);
            try (Response response = call.execute()) {
                if (!response.isSuccessful()) throw new IOException("Image request failed");
                String scheme = response.request().url().scheme();
                if ((!scheme.equals("http") && !scheme.equals("https")) || !response.request().url().username().isEmpty()) throw new IOException("Unsafe image URL");
                ResponseBody body = response.body();
                if (body == null || body.contentLength() > MAX_IMAGE_BYTES) throw new IOException("Invalid image size");
                try (InputStream input = body.byteStream(); var output = new FileOutputStream(temporary)) {
                    byte[] buffer = new byte[64 * 1024]; long received = 0; int count;
                    while ((count = input.read(buffer)) != -1) {
                        received += count;
                        if (received > MAX_IMAGE_BYTES || closed || Thread.currentThread().isInterrupted()) throw new IOException("Image download cancelled or oversized");
                        output.write(buffer, 0, count);
                    }
                }
                return decode(temporary);
            }
        } finally {
            if (call != null) webRequests.remove(call);
            temporary.delete();
        }
    }

    private static Bitmap decode(File file) throws IOException {
        BitmapFactory.Options options = new BitmapFactory.Options(); options.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getPath(), options); options.inJustDecodeBounds = false; options.inSampleSize = 1;
        if (options.outWidth <= 0 || options.outHeight <= 0) throw new IOException("Unreadable image");
        while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > 2048) options.inSampleSize *= 2;
        Bitmap bitmap = BitmapFactory.decodeFile(file.getPath(), options);
        if (bitmap == null) throw new IOException("Unreadable image");
        return bitmap;
    }

    @Override public void loadVideo(String reference, MarkdownView.VideoCallback callback) {
        if (closed || !supportedVideo(reference) || (remote(reference) == null && (seq < 1 || conversation == null || conversation.isEmpty()))) {
            callback.failed(); return;
        }
        File cached = videoFiles.get(reference);
        if (cached != null && cached.isFile()) { callback.loaded(cached); return; }
        List<MarkdownView.VideoCallback> listeners = videoPending.get(reference);
        if (listeners != null) { listeners.add(callback); return; }
        listeners = new ArrayList<>(); listeners.add(callback); videoPending.put(reference, listeners);
        WORKER.execute(() -> {
            if (closed) return;
            File file = null;
            try { file = remote(reference) == null ? artifactVideo(reference) : webVideo(reference); }
            catch (Exception ignored) { }
            File result = file;
            handler.post(() -> finishVideo(reference, result));
        });
    }

    private void finishVideo(String reference, File file) {
        List<MarkdownView.VideoCallback> listeners = videoPending.remove(reference);
        if (listeners == null || closed) return;
        if (file != null) videoFiles.put(reference, file);
        for (MarkdownView.VideoCallback listener : listeners) {
            if (file == null) listener.failed(); else listener.loaded(file);
        }
    }

    private File artifactVideo(String reference) throws Exception {
        RemoteApi request = null;
        File temporary = null;
        try {
            request = apiFactory.apply(address); requests.add(request);
            String route = "/v1/conversations/" + conversation + "/artifacts?offset=0&seq=" + seq + "&reference=" + ArtifactReferences.query(reference);
            JSONObject result = request.json(route, token, null);
            JSONArray files = result.getJSONArray("artifacts");
            JSONObject selected = null;
            for (int index = 0; index < files.length(); index++) {
                JSONObject file = files.optJSONObject(index);
                if (file == null || !supportedVideo(file.optString("name")) || file.optLong("size") < 0 || file.optLong("size") > MAX_VIDEO_BYTES) continue;
                if (!file.optString("id").matches("[a-f0-9]{64}")) continue;
                selected = file; break;
            }
            if (selected == null) throw new IOException("Video unavailable");
            File target = videoTarget(selected.getString("id"), reference);
            long size = selected.getLong("size");
            if (target.isFile() && target.length() == size) return target;
            temporary = File.createTempFile("camellia-inline-video-", ".part", target.getParentFile());
            String download = "/v1/conversations/" + conversation + "/artifacts/" + selected.getString("id");
            try (var output = new FileOutputStream(temporary)) {
                request.download(download, token, output, size, (read, total) -> { });
            }
            if (temporary.length() != size) throw new IOException("Video changed during download");
            if (target.exists() && !target.delete()) throw new IOException("Cannot replace cached video");
            if (!temporary.renameTo(target)) throw new IOException("Cannot cache video");
            temporary = null;
            return target;
        } finally {
            if (request != null) { requests.remove(request); request.cancel(); }
            if (temporary != null) temporary.delete();
        }
    }

    private File webVideo(String reference) throws Exception {
        File target = videoTarget(digest(reference), reference);
        if (target.isFile() && target.length() > 0) return target;
        File temporary = File.createTempFile("camellia-inline-web-video-", ".part", target.getParentFile());
        Call call = null;
        try {
            call = WEB.newCall(new Request.Builder().url(reference).header("Accept", "video/*").build()); webRequests.add(call);
            try (Response response = call.execute()) {
                if (!response.isSuccessful()) throw new IOException("Video request failed");
                String scheme = response.request().url().scheme();
                if ((!scheme.equals("http") && !scheme.equals("https")) || !response.request().url().username().isEmpty()) throw new IOException("Unsafe video URL");
                ResponseBody body = response.body();
                if (body == null || body.contentLength() > MAX_VIDEO_BYTES) throw new IOException("Invalid video size");
                try (InputStream input = body.byteStream(); var output = new FileOutputStream(temporary)) {
                    byte[] buffer = new byte[64 * 1024]; long received = 0; int count;
                    while ((count = input.read(buffer)) != -1) {
                        received += count;
                        if (received > MAX_VIDEO_BYTES || closed || Thread.currentThread().isInterrupted()) throw new IOException("Video download cancelled or oversized");
                        output.write(buffer, 0, count);
                    }
                }
            }
            if (temporary.length() == 0) throw new IOException("Empty video");
            if (target.exists() && !target.delete()) throw new IOException("Cannot replace cached video");
            if (!temporary.renameTo(target)) throw new IOException("Cannot cache video");
            temporary = null;
            return target;
        } finally {
            if (call != null) webRequests.remove(call);
            temporary.delete();
        }
    }

    private File videoTarget(String identity, String reference) throws IOException {
        File directory = new File(context.getCacheDir(), "inline-videos");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create video cache");
        String path = mediaPath(reference);
        int dot = path == null ? -1 : path.lastIndexOf('.');
        String extension = dot < 0 ? "video" : path.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
        if (!extension.matches("[a-z0-9]{1,8}")) extension = "video";
        return new File(directory, identity + "." + extension);
    }

    private static String digest(String value) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
        return result.toString();
    }

    @Override public void close() {
        if (closed) return;
        closed = true; pending.clear(); videoPending.clear(); videoFiles.clear(); cache.evictAll();
        for (RemoteApi request : requests) request.cancel(); requests.clear();
        for (Call call : webRequests) call.cancel(); webRequests.clear();
    }
}
