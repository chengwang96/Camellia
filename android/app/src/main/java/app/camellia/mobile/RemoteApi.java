package app.camellia.mobile;

import org.json.JSONException;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import javax.net.ssl.HttpsURLConnection;

public class RemoteApi {
    static String failureMessage(Exception error, boolean chinese) {
        if (error instanceof Failure) {
            int code = ((Failure) error).status;
            String message = switch (code) {
                case 401 -> chinese ? "电脑配对凭据无效或已撤销，请重新配对。" : "Computer pairing is invalid or revoked. Pair again.";
                case 403 -> chinese ? "电脑拒绝访问，请检查设备权限和工作区授权。" : "Desktop denied access. Check device and workspace permissions.";
                case 404 -> chinese ? "会话或接口不可用，请确认授权并更新电脑端。" : "Conversation or endpoint unavailable. Check authorization and update the desktop.";
                case 409 -> chinese ? "会话状态已变化，请刷新核对后再操作。" : "Conversation state changed. Refresh and check before operating.";
                case 429 -> chinese ? "请求过于频繁，请一分钟后重试。" : "Too many requests. Retry in one minute.";
                case 502, 503, 504 -> chinese ? "已到达远程网关，但电脑服务暂不可用，请检查电脑端。" : "Remote gateway reached, but desktop service is unavailable. Check the desktop app.";
                default -> chinese ? "电脑返回请求错误，请刷新；持续失败请检查电脑端。" : "Desktop returned a request error. Refresh; check the desktop if it persists.";
            };
            String detail = ((Failure) error).detail;
            return message + " [HTTP " + code + "]" + (detail.isEmpty() ? "" : "\n" + (chinese ? "电脑返回详情：" : "Desktop detail: ") + detail);
        }
        return ConnectionFailure.message(error, !EmbeddedNetwork.enabled() || EmbeddedNetwork.online(), chinese);
    }

    public static final class Failure extends IOException {
        public final int status;
        public final String detail;
        Failure(int status) { this(status, ""); }
        Failure(int status, String detail) {
            super("Remote HTTP " + status + (detail.isEmpty() ? "" : ": " + detail));
            this.status = status; this.detail = detail;
        }
    }
    public interface SnapshotListener { void onSnapshot(JSONObject snapshot) throws IOException; }
    public interface DownloadProgress { void update(long received, long total); }
    private final Endpoint endpoint;
    private final String fingerprint;
    private final android.content.Context context;
    private final Set<HttpURLConnection> connections = ConcurrentHashMap.newKeySet();
    private volatile boolean cancelled;
    private volatile boolean incremental;
    private volatile boolean liveDelta;
    private volatile String historyVersion = "";
    void incremental(boolean enabled) { incremental = enabled; }
    boolean incremental() { return incremental; }
    void liveDelta(boolean enabled) { liveDelta = enabled; }
    boolean liveDelta() { return liveDelta; }
    void historyVersion(String version) { historyVersion = version == null ? "" : version; }
    String historyVersion() { return historyVersion; }
    boolean embeddedCapable() { return context != null; }
    private final Set<tailnet.Response> embeddedResponses = ConcurrentHashMap.newKeySet();

    public RemoteApi(String address) { this((android.content.Context) null, address, null); }
    public RemoteApi(android.content.Context context, String address) { this(context, address, null); }
    public RemoteApi(android.content.Context context, String address, String explicitFingerprint) {
        this.context = context == null ? null : context.getApplicationContext();
        ComputerRoutes.Route route = ComputerRoutes.route(address);
        if ((explicitFingerprint == null || explicitFingerprint.isEmpty()) && route.fingerprint.isEmpty()
                && route.isLan() && this.context != null) {
            try {
                ComputerRoutes.configure(new ComputerStore(new CredentialStore(this.context)).all());
                route = ComputerRoutes.route(address);
            } catch (Exception ignored) { /* The caller will receive the clear fingerprint error below. */ }
        }
        endpoint = new Endpoint(route.url);
        String selected = explicitFingerprint == null || explicitFingerprint.isEmpty() ? route.fingerprint : explicitFingerprint;
        fingerprint = endpoint.isLan() ? LanTls.normalize(selected) : "";
    }

    private RemoteApi(android.content.Context context, Endpoint explicitEndpoint, String explicitFingerprint) {
        this.context = context == null ? null : context.getApplicationContext();
        endpoint = explicitEndpoint;
        fingerprint = endpoint.isLan() ? LanTls.normalize(explicitFingerprint) : "";
    }

    static RemoteApi explicit(android.content.Context context, String url) {
        return explicit(context, url, "");
    }

    static RemoteApi explicit(android.content.Context context, String url, String fingerprint) {
        return new RemoteApi(context, new Endpoint(url), fingerprint);
    }

    private HttpURLConnection open(String path, String token) throws IOException {
        if (cancelled) throw new IOException("Cancelled");
        HttpURLConnection connection = (HttpURLConnection) endpoint.uri(path).toURL().openConnection(Proxy.NO_PROXY);
        if (endpoint.isLan()) {
            HttpsURLConnection secure = (HttpsURLConnection) connection;
            secure.setSSLSocketFactory(LanTls.socketFactory(fingerprint));
            secure.setHostnameVerifier((host, session) -> true);
        }
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(25_000);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        if (token != null) {
            if (!token.matches("[A-Za-z0-9_-]{43}")) throw new IOException("Invalid device credential");
            connection.setRequestProperty("Authorization", "Bearer " + token);
        }
        connections.add(connection);
        if (cancelled) { release(connection); throw new IOException("Cancelled"); }
        return connection;
    }

    public void download(String path, String token, java.io.OutputStream output, long expectedSize, DownloadProgress progress) throws IOException {
        if (expectedSize < 0) throw new IOException("Invalid file size");
        long[] received = { 0 };
        boolean embedded = !endpoint.isLan() && EmbeddedNetwork.enabled();
        java.io.OutputStream counted = new java.io.OutputStream() {
            @Override public void write(int value) throws IOException {
                try { output.write(value); received[0]++; }
                catch (IOException error) { throw new DownloadWriteFailure(error); }
            }
            @Override public void write(byte[] bytes, int offset, int length) throws IOException {
                try { output.write(bytes, offset, length); received[0] += length; }
                catch (IOException error) { throw new DownloadWriteFailure(error); }
            }
        };
        int retries = 0;
        while (true) {
            try {
                if (received[0] == 0) downloadOnce(path, token, counted, expectedSize, progress);
                else downloadAt(path, token, counted, expectedSize, received[0], progress);
                return;
            } catch (IOException error) {
                if (cancelled || Thread.currentThread().isInterrupted() || embedded && embedded != EmbeddedNetwork.enabled()
                        || error instanceof DownloadValidationFailure || error instanceof DownloadWriteFailure || retries >= 5) throw error;
                if (error instanceof Failure failure && failure.status != 429 && failure.status != 502
                        && failure.status != 503 && failure.status != 504) throw error;
                if (received[0] > 0 && received[0] == expectedSize) { progress.update(expectedSize, expectedSize); return; }
                retryPause(retries++);
            }
        }
    }

    private static final class DownloadValidationFailure extends IOException {
        DownloadValidationFailure(String message) { super(message); }
    }
    private static final class DownloadWriteFailure extends IOException {
        DownloadWriteFailure(IOException cause) { super(cause.getMessage(), cause); }
    }

    private void retryPause(int retry) throws IOException {
        long delay = 200L * (1L << retry) + java.util.concurrent.ThreadLocalRandom.current().nextLong(100);
        try { Thread.sleep(delay); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException("Download retry interrupted", error); }
        if (cancelled) throw new IOException("Download cancelled");
    }

    void downloadOnce(String path, String token, java.io.OutputStream output, long expectedSize, DownloadProgress progress) throws IOException {
        downloadAt(path, token, output, expectedSize, 0, progress);
    }

    void downloadAt(String path, String token, java.io.OutputStream output, long expectedSize, long offset, DownloadProgress progress) throws IOException {
        if (!endpoint.isLan() && EmbeddedNetwork.enabled()) {
            tailnet.Response response = embeddedOpen(path, token, null, offset);
            try (InputStream source = input(response)) {
                validateDownload(response.statusCode(), response.contentType(), response.contentLength(), response.contentRange(), expectedSize, offset);
                if (offset > 0 && response.statusCode() == 200) skipDownloadPrefix(source, offset);
                copyDownload(source, output, expectedSize, offset, progress);
            } finally { release(response); }
        } else {
            HttpURLConnection connection = open(path, token);
            try {
                connection.setRequestProperty("Accept", "application/octet-stream");
                if (offset > 0) connection.setRequestProperty("Range", "bytes=" + offset + "-");
                int status = connection.getResponseCode();
                if (status != 200 && !(offset > 0 && status == 206)) throw new Failure(status, readFailure(connection));
                validateDownload(status, connection.getContentType(), connection.getContentLengthLong(), connection.getHeaderField("Content-Range"), expectedSize, offset);
                try (InputStream source = connection.getInputStream()) {
                    if (offset > 0 && status == 200) skipDownloadPrefix(source, offset);
                    copyDownload(source, output, expectedSize, offset, progress);
                }
            } finally { release(connection); }
        }
    }

    static void validateDownload(long status, String type, long length, String range, long expectedSize, long offset) throws IOException {
        if (!"application/octet-stream".equals(type)) throw new DownloadValidationFailure("Unexpected file type");
        if (status == 206) {
            if (offset <= 0 || length != expectedSize - offset
                    || !("bytes " + offset + "-" + (expectedSize - 1) + "/" + expectedSize).equals(range))
                throw new DownloadValidationFailure("Invalid resumed download");
        } else if (status != 200 || length != expectedSize) throw new DownloadValidationFailure("File size changed");
    }

    private void skipDownloadPrefix(InputStream source, long offset) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        while (offset > 0) {
            if (cancelled || Thread.currentThread().isInterrupted()) throw new IOException("Download cancelled");
            int count = source.read(buffer, 0, (int) Math.min(buffer.length, offset));
            if (count < 0) throw new IOException("Incomplete download");
            offset -= count;
        }
    }

    private void copyDownload(InputStream source, java.io.OutputStream output, long expectedSize, long offset, DownloadProgress progress) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        long received = offset, lastUpdate = 0;
        int count;
        while ((count = source.read(buffer)) != -1) {
            if (cancelled || Thread.currentThread().isInterrupted()) throw new IOException("Download cancelled");
            received += count;
            if (received > expectedSize) throw new DownloadValidationFailure("File size changed");
            output.write(buffer, 0, count);
            long now = System.nanoTime();
            if (now - lastUpdate > 250_000_000L) { progress.update(received, expectedSize); lastUpdate = now; }
        }
        if (cancelled || received != expectedSize) throw new IOException("Incomplete download");
        progress.update(received, expectedSize);
    }

    public JSONObject json(String path, String token, JSONObject payload) throws IOException {
        return json(path, token, payload, 8 * 1024 * 1024);
    }

    JSONObject json(String path, String token, JSONObject payload, int responseLimit) throws IOException {
        try (AttachmentMaintenance.Lease uploading = context == null ? null : AttachmentMaintenance.protect(context, payload)) {
        if (!endpoint.isLan() && EmbeddedNetwork.enabled()) return embeddedJson(path, token, payload, responseLimit);
        HttpURLConnection connection = open(path, token);
        try {
            if (payload != null) {
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                AttachmentJson.Body body = AttachmentJson.prepare(context, payload, () -> cancelled);
                connection.setFixedLengthStreamingMode(body.length);
                if (cancelled) throw new IOException("Cancelled");
                try (var output = new java.io.BufferedOutputStream(connection.getOutputStream())) { body.writeTo(output); }
            }
            int status = connection.getResponseCode();
            if (status != 200) throw new Failure(status, readFailure(connection));
            if (!String.valueOf(connection.getContentType()).toLowerCase(java.util.Locale.ROOT).startsWith("application/json")) throw new IOException("Unexpected response type");
            try (InputStream input = connection.getInputStream()) {
                return readJson(input, responseLimit, () -> cancelled);
            }
        } finally { release(connection); }
        }
    }

    public byte[] bytes(String path, String token, int limit) throws IOException {
        if (limit < 1) throw new IOException("Invalid response limit");
        if (!endpoint.isLan() && EmbeddedNetwork.enabled()) {
            tailnet.Response response = embeddedOpen(path, token, null);
            try (InputStream input = input(response)) {
                if (!"application/octet-stream".equals(response.contentType())) throw new IOException("Unexpected response type");
                return readBytes(input, limit, () -> cancelled);
            } finally { release(response); }
        }
        HttpURLConnection connection = open(path, token);
        try {
            connection.setRequestProperty("Accept", "application/octet-stream");
            int status = connection.getResponseCode();
            if (status != 200) throw new Failure(status, readFailure(connection));
            if (!"application/octet-stream".equals(connection.getContentType())) throw new IOException("Unexpected response type");
            if (connection.getContentLengthLong() > limit) throw new IOException("Oversized response");
            try (InputStream input = connection.getInputStream()) {
                return readBytes(input, limit, () -> cancelled);
            }
        } finally { release(connection); }
    }

    private static byte[] readBytes(InputStream input, int limit, java.util.function.BooleanSupplier cancelled) throws IOException {
        try (var output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (cancelled.getAsBoolean() || output.size() + count > limit) throw new IOException("Cancelled or oversized response");
                output.write(buffer, 0, count);
            }
            if (cancelled.getAsBoolean()) throw new IOException("Cancelled");
            return output.toByteArray();
        }
    }

    static JSONObject readJson(InputStream input, int limit, java.util.function.BooleanSupplier cancelled) throws IOException {
        try (var output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (cancelled.getAsBoolean() || output.size() + count > limit) throw new IOException("Cancelled or oversized response");
                output.write(buffer, 0, count);
            }
            if (cancelled.getAsBoolean()) throw new IOException("Cancelled");
            return new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
        } catch (JSONException error) { throw new IOException("Invalid server JSON", error); }
    }

    public void events(String id, String token, SnapshotListener listener) throws IOException {
        events(id, token, listener, null);
    }

    void events(String id, String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws IOException {
        String version = historyVersion;
        String query = incremental ? "?incremental=1" + (liveDelta ? "&delta=live-v1" : "") + (version.isEmpty() ? "" : "&historyVersion=" + version) : "";
        eventsAt("/v1/conversations/" + id + "/events" + query, token, listener, heartbeat);
    }

    public void listEvents(String token, SnapshotListener listener) throws IOException {
        eventsAt("/v1/conversations/events", token, listener);
    }

    public void listEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws IOException {
        eventsAt("/v1/conversations/events", token, listener, heartbeat);
    }

    void workbenchEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws IOException {
        eventsAt("/v1/workbench/events", token, listener, heartbeat);
    }

    public void discussionEvents(String id, String token, SnapshotListener listener) throws IOException {
        eventsAt("/v1/discussions" + (id == null ? "" : "/" + id) + "/events", token, listener);
    }

    private void eventsAt(String path, String token, SnapshotListener listener) throws IOException {
        eventsAt(path, token, listener, null);
    }

    private void eventsAt(String path, String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws IOException {
        if (!endpoint.isLan() && EmbeddedNetwork.enabled()) { embeddedEvents(path, token, listener, heartbeat); return; }
        HttpURLConnection connection = open(path, token);
        try {
            connection.setRequestProperty("Accept", "text/event-stream");
            int status = connection.getResponseCode();
            if (status != 200) throw new Failure(status, readFailure(connection));
            if (!String.valueOf(connection.getContentType()).toLowerCase(java.util.Locale.ROOT).startsWith("text/event-stream")) throw new IOException("Unexpected event stream");
            try (var reader = new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8)) {
                final JSONObject[] previous = { null };
            SseReader.read(reader, data -> {
                    if (cancelled) throw new IOException("Cancelled");
                    try { previous[0] = RemoteDelta.merge(previous[0], new JSONObject(data)); listener.onSnapshot(previous[0]); }
                    catch (JSONException error) { throw new IOException("Invalid snapshot", error); }
                }, heartbeat == null ? null : () -> {
                    if (cancelled) throw new IOException("Cancelled");
                    heartbeat.onHeartbeat();
                });
            }
        } finally { release(connection); }
    }

    private void release(HttpURLConnection connection) { connections.remove(connection); connection.disconnect(); }
    public void cancel() {
        cancelled = true;
        for (tailnet.Response response : embeddedResponses) response.close();
        embeddedResponses.clear();
        for (HttpURLConnection connection : connections) connection.disconnect();
        connections.clear();
    }

    private tailnet.Response embeddedOpen(String path, String token, JSONObject payload) throws IOException {
        return embeddedOpen(path, token, payload, 0);
    }

    private tailnet.Response embeddedOpen(String path, String token, JSONObject payload, long offset) throws IOException {
        if (cancelled) throw new IOException("Cancelled");
        if (token != null && !token.matches("[A-Za-z0-9_-]{43}")) throw new IOException("Invalid credential");
        try {
            tailnet.Node node = EmbeddedNetwork.node(() -> cancelled || Thread.currentThread().isInterrupted());
            tailnet.Response response;
            if (payload == null) response = node.prepare("GET", endpoint.uri(path).toString(), token == null ? "" : token, "");
            else {
                AttachmentJson.Body body = AttachmentJson.prepare(context, payload, () -> cancelled);
                AttachmentUpload upload = new AttachmentUpload(body);
                try { response = node.prepareStream("POST", endpoint.uri(path).toString(), token == null ? "" : token, body.length, upload); }
                catch (Exception error) { upload.close(); throw error; }
            }
            embeddedResponses.add(response);
            if (offset > 0) response.setRangeStart(offset);
            if (cancelled) { release(response); throw new IOException("Cancelled"); }
            try { response.execute(); }
            catch (Exception error) { release(response); throw error; }
            if (cancelled) { release(response); throw new IOException("Cancelled"); }
            if (response.statusCode() != 200 && !(offset > 0 && response.statusCode() == 206)) {
                int code = (int) response.statusCode();
                String detail = "";
                try (InputStream body = input(response)) { detail = readLimited(body); }
                catch (Exception ignored) { }
                finally { release(response); }
                throw new Failure(code, clean(detail));
            }
            return response;
        } catch (IOException error) { throw error; }
        catch (Exception error) { throw new IOException("Embedded connection failed", error); }
    }

    private void release(tailnet.Response response) { embeddedResponses.remove(response); response.close(); }

    private static String readFailure(HttpURLConnection connection) {
        try {
            InputStream body = connection.getErrorStream();
            return body == null ? "" : clean(readLimited(body));
        } catch (Exception error) {
            return clean(error.getMessage());
        }
    }

    private static String readLimited(InputStream input) throws IOException {
        StringBuilder source = new StringBuilder();
        byte[] buffer = new byte[2048];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (source.length() + count > 16 * 1024) break;
            source.append(new String(buffer, 0, count, StandardCharsets.UTF_8));
        }
        return source.toString();
    }

    static String clean(String value) {
        if (value == null) return "";
        String text = value
            .replaceAll("(?i)Bearer\\s+[^\\s\"',;]+", "Bearer [redacted]")
            .replaceAll("(?i)\\bsk-[A-Za-z0-9_-]+", "[redacted]")
            .replaceAll("\\b[A-Za-z0-9_-]{43}\\b", "[redacted]")
            .replaceAll("\\s+", " ").trim();
        return text.length() > 4096 ? text.substring(0, 4096) + "…" : text;
    }

    private static InputStream input(tailnet.Response response) {
        return new InputStream() {
            private byte[] chunk = new byte[0];
            private int offset;
            @Override public int read() throws IOException {
                byte[] single = new byte[1]; return read(single, 0, 1) < 0 ? -1 : single[0] & 255;
            }
            @Override public int read(byte[] buffer, int start, int length) throws IOException {
                if (length == 0) return 0;
                if (offset >= chunk.length) {
                    try { chunk = response.readChunk(); offset = 0; }
                    catch (Exception error) { throw new IOException("Embedded stream disconnected", error); }
                    if (chunk == null || chunk.length == 0) return -1;
                }
                int count = Math.min(length, chunk.length - offset);
                System.arraycopy(chunk, offset, buffer, start, count); offset += count; return count;
            }
            @Override public void close() { response.close(); }
        };
    }

    private JSONObject embeddedJson(String path, String token, JSONObject payload, int responseLimit) throws IOException {
        tailnet.Response response = embeddedOpen(path, token, payload);
        try (InputStream input = input(response)) {
            if (!response.contentType().startsWith("application/json")) throw new IOException("Unexpected content type");
            return readJson(input, responseLimit, () -> cancelled);
        }
        finally { release(response); }
    }

    private void embeddedEvents(String path, String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws IOException {
        tailnet.Response response = embeddedOpen(path, token, null);
        try (var reader = new InputStreamReader(input(response), StandardCharsets.UTF_8)) {
            if (!response.contentType().startsWith("text/event-stream")) throw new IOException("Unexpected stream type");
            final JSONObject[] previous = { null };
            SseReader.read(reader, data -> {
                if (cancelled) throw new IOException("Cancelled");
                try { previous[0] = RemoteDelta.merge(previous[0], new JSONObject(data)); listener.onSnapshot(previous[0]); }
                catch (JSONException error) { throw new IOException("Invalid snapshot", error); }
            }, heartbeat == null ? null : () -> {
                if (cancelled) throw new IOException("Cancelled");
                heartbeat.onHeartbeat();
            });
        } finally { release(response); }
    }
}
