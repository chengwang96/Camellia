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
        return ConnectionFailure.message(error, EmbeddedNetwork.online(), chinese);
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
    private final Set<HttpURLConnection> connections = ConcurrentHashMap.newKeySet();
    private volatile boolean cancelled;
    private final Set<tailnet.Response> embeddedResponses = ConcurrentHashMap.newKeySet();

    public RemoteApi(String address) { endpoint = new Endpoint(address); }

    private HttpURLConnection open(String path, String token) throws IOException {
        if (cancelled) throw new IOException("Cancelled");
        HttpURLConnection connection = (HttpURLConnection) endpoint.uri(path).toURL().openConnection(Proxy.NO_PROXY);
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
        if (EmbeddedNetwork.enabled()) {
            tailnet.Response response = embeddedOpen(path, token, null);
            try (InputStream source = input(response)) {
                if (!"application/octet-stream".equals(response.contentType())) throw new IOException("Unexpected file type");
                copyDownload(source, output, expectedSize, progress);
            } finally { release(response); }
        } else {
            HttpURLConnection connection = open(path, token);
            try {
                connection.setRequestProperty("Accept", "application/octet-stream");
                int status = connection.getResponseCode();
                if (status != 200) throw new Failure(status, readFailure(connection));
                if (!"application/octet-stream".equals(connection.getContentType())) throw new IOException("Unexpected file type");
                if (connection.getContentLengthLong() != expectedSize) throw new IOException("File size changed");
                try (InputStream source = connection.getInputStream()) { copyDownload(source, output, expectedSize, progress); }
            } finally { release(connection); }
        }
    }

    private void copyDownload(InputStream source, java.io.OutputStream output, long expectedSize, DownloadProgress progress) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        long received = 0, lastUpdate = 0;
        int count;
        while ((count = source.read(buffer)) != -1) {
            if (cancelled || Thread.currentThread().isInterrupted()) throw new IOException("Download cancelled");
            received += count;
            if (received > expectedSize) throw new IOException("File size changed");
            output.write(buffer, 0, count);
            long now = System.nanoTime();
            if (now - lastUpdate > 250_000_000L) { progress.update(received, expectedSize); lastUpdate = now; }
        }
        if (cancelled || received != expectedSize) throw new IOException("Incomplete download");
        progress.update(received, expectedSize);
    }

    public JSONObject json(String path, String token, JSONObject payload) throws IOException {
        if (EmbeddedNetwork.enabled()) return embeddedJson(path, token, payload);
        HttpURLConnection connection = open(path, token);
        try {
            if (payload != null) {
                byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (var output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            if (status != 200) throw new Failure(status, readFailure(connection));
            if (!String.valueOf(connection.getContentType()).toLowerCase(java.util.Locale.ROOT).startsWith("application/json")) throw new IOException("Unexpected response type");
            try (InputStream input = connection.getInputStream(); var output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > 8 * 1024 * 1024) throw new IOException("Response too large");
                    output.write(buffer, 0, count);
                }
                return new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
            } catch (JSONException error) { throw new IOException("Invalid server JSON", error); }
        } finally { release(connection); }
    }

    public void events(String id, String token, SnapshotListener listener) throws IOException {
        eventsAt("/v1/conversations/" + id + "/events", token, listener);
    }

    public void listEvents(String token, SnapshotListener listener) throws IOException {
        eventsAt("/v1/conversations/events", token, listener);
    }

    private void eventsAt(String path, String token, SnapshotListener listener) throws IOException {
        if (EmbeddedNetwork.enabled()) { embeddedEvents(path, token, listener); return; }
        HttpURLConnection connection = open(path, token);
        try {
            connection.setRequestProperty("Accept", "text/event-stream");
            int status = connection.getResponseCode();
            if (status != 200) throw new Failure(status, readFailure(connection));
            if (!String.valueOf(connection.getContentType()).toLowerCase(java.util.Locale.ROOT).startsWith("text/event-stream")) throw new IOException("Unexpected event stream");
            try (var reader = new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8)) {
                SseReader.read(reader, data -> {
                    if (cancelled) throw new IOException("Cancelled");
                    try { listener.onSnapshot(new JSONObject(data)); }
                    catch (JSONException error) { throw new IOException("Invalid snapshot", error); }
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
        if (cancelled) throw new IOException("Cancelled");
        if (token != null && !token.matches("[A-Za-z0-9_-]{43}")) throw new IOException("Invalid credential");
        try {
            tailnet.Response response = EmbeddedNetwork.node().prepare(payload == null ? "GET" : "POST", endpoint.uri(path).toString(), token == null ? "" : token, payload == null ? "" : payload.toString());
            embeddedResponses.add(response);
            if (cancelled) { release(response); throw new IOException("Cancelled"); }
            try { response.execute(); }
            catch (Exception error) { release(response); throw error; }
            if (cancelled) { release(response); throw new IOException("Cancelled"); }
            if (response.statusCode() != 200) {
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

    private JSONObject embeddedJson(String path, String token, JSONObject payload) throws IOException {
        tailnet.Response response = embeddedOpen(path, token, payload);
        try (InputStream input = input(response); var output = new ByteArrayOutputStream()) {
            if (!response.contentType().startsWith("application/json")) throw new IOException("Unexpected content type");
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (cancelled || output.size() + count > 8 * 1024 * 1024) throw new IOException("Cancelled or oversized response");
                output.write(buffer, 0, count);
            }
            return new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
        } catch (JSONException error) { throw new IOException("Invalid JSON", error); }
        finally { release(response); }
    }

    private void embeddedEvents(String path, String token, SnapshotListener listener) throws IOException {
        tailnet.Response response = embeddedOpen(path, token, null);
        try (var reader = new InputStreamReader(input(response), StandardCharsets.UTF_8)) {
            if (!response.contentType().startsWith("text/event-stream")) throw new IOException("Unexpected stream type");
            SseReader.read(reader, data -> {
                if (cancelled) throw new IOException("Cancelled");
                try { listener.onSnapshot(new JSONObject(data)); }
                catch (JSONException error) { throw new IOException("Invalid snapshot", error); }
            });
        } finally { release(response); }
    }
}
