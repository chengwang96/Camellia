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

public final class RemoteApi {
    public static final class Failure extends IOException {
        public final int status;
        Failure(int status) { super("Remote HTTP " + status); this.status = status; }
    }
    public interface SnapshotListener { void onSnapshot(JSONObject snapshot) throws IOException; }
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
            if (status != 200) throw new Failure(status);
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
            if (status != 200) throw new Failure(status);
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
            tailnet.Response response = EmbeddedNetwork.node().open(payload == null ? "GET" : "POST", endpoint.uri(path).toString(), token == null ? "" : token, payload == null ? "" : payload.toString());
            embeddedResponses.add(response);
            if (cancelled) { release(response); throw new IOException("Cancelled"); }
            if (response.statusCode() != 200) { int code = (int) response.statusCode(); release(response); throw new Failure(code); }
            return response;
        } catch (IOException error) { throw error; }
        catch (Exception error) { throw new IOException("Embedded connection failed", error); }
    }

    private void release(tailnet.Response response) { embeddedResponses.remove(response); response.close(); }

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
