package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;

public class RemoteApiResponseTest extends InstrumentationTestCase {
    public void testNativeUnicodeAtTheExactByteLimit() throws Exception {
        byte[] body = "{\"text\":\"中文 😀\"}".getBytes(StandardCharsets.UTF_8);
        assertEquals("中文 😀", RemoteApi.readJson(new ByteArrayInputStream(body), body.length, () -> false).getString("text"));
    }

    public void testHttpPrefetchRejectsLargeBodyAndNormalJsonStillLoadsIt() throws Exception {
        var context = getInstrumentation().getTargetContext(); EmbeddedNetwork.initialize(context);
        boolean old = EmbeddedNetwork.enabled(); EmbeddedNetwork.setEnabled(false);
        String text = "x".repeat(2 * 1024 * 1024); byte[] body = ("{\"text\":\"" + text + "\"}").getBytes(StandardCharsets.UTF_8);
        try {
            try (Server server = new Server(body)) {
                RemoteApi client = client(server);
                try { client.json("/v1/status", null, null, RemotePrefetch.RESPONSE_LIMIT); fail("Oversized prefetch should be skipped"); }
                catch (IOException expected) { assertTrue(expected.getMessage().contains("oversized")); }
                finally { client.cancel(); }
            }
            try (Server server = new Server(body)) {
                RemoteApi client = client(server);
                try { assertEquals(text.length(), client.json("/v1/status", null, null).getString("text").length()); }
                finally { client.cancel(); }
            }
        } finally { EmbeddedNetwork.setEnabled(old); }
    }

    private RemoteApi client(Server server) throws Exception {
        RemoteApi client = new RemoteApi("http://100.80.1.2:" + server.socket.getLocalPort());
        // This private fixture alone uses loopback; the production Endpoint validator remains unchanged.
        var endpoint = RemoteApi.class.getDeclaredField("endpoint"); endpoint.setAccessible(true);
        var origin = Endpoint.class.getDeclaredField("origin"); origin.setAccessible(true);
        origin.set(endpoint.get(client), "http://127.0.0.1:" + server.socket.getLocalPort()); return client;
    }
    private static final class Server implements AutoCloseable {
        final ServerSocket socket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
        final ExecutorService worker = Executors.newSingleThreadExecutor(); final Future<?> served;
        Server(byte[] body) throws IOException {
            served = worker.submit(() -> {
                try (Socket peer = socket.accept()) {
                    peer.setSoTimeout(5000);
                    BufferedReader input = new BufferedReader(new InputStreamReader(peer.getInputStream(), StandardCharsets.US_ASCII));
                    String line; while ((line = input.readLine()) != null && !line.isEmpty()) { }
                    OutputStream output = peer.getOutputStream();
                    output.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    output.write(body); output.flush();
                } catch (IOException expectedWhenClientStopsReading) { }
            });
        }
        @Override public void close() throws Exception {
            socket.close(); worker.shutdown(); served.get(5, TimeUnit.SECONDS); assertTrue(worker.awaitTermination(5, TimeUnit.SECONDS));
        }
    }
}
