package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.RandomAccessFile;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/** Real HTTP truncation and disk writes, with a payload matching the reported APK size. */
public class RemoteDownloadIntegrityTest extends InstrumentationTestCase {
    private static final long SIZE = 22_469_437;
    private static final String TOKEN = "t".repeat(43);
    private static final String PATH = "/v1/conversations/11111111-1111-1111-1111-111111111111/artifacts/" + "a".repeat(64);
    private boolean previousMode;

    @Override protected void setUp() throws Exception {
        super.setUp();
        EmbeddedNetwork.initialize(getInstrumentation().getTargetContext());
        previousMode = EmbeddedNetwork.enabled();
        EmbeddedNetwork.setEnabled(false).get(10, TimeUnit.SECONDS);
    }

    @Override protected void tearDown() throws Exception {
        EmbeddedNetwork.setEnabled(previousMode).get(10, TimeUnit.SECONDS);
        super.tearDown();
    }

    public void testLargeFileSurvivesTwoRealHttpDisconnectsWithExactRangeResume() throws Exception {
        complete(Mode.RANGE);
    }

    public void testLargeFileSurvivesTwoDisconnectsAgainstAnOlderFullResponseGateway() throws Exception {
        complete(Mode.LEGACY);
    }

    private void complete(Mode mode) throws Exception {
        File destination = temporary();
        try (Fixture fixture = new Fixture(mode)) {
            RemoteApi api = fixture.client();
            AtomicLong progress = new AtomicLong();
            try (var output = new FileOutputStream(destination)) {
                api.download(PATH, TOKEN, output, SIZE, (received, total) -> {
                    assertEquals(SIZE, total);
                    assertTrue("Progress moved backwards during recovery", received >= progress.getAndSet(received));
                });
            } finally { api.cancel(); }
            assertEquals(SIZE, destination.length());
            assertEquals("The recovered file differs from the source", sha256(fixture.source), sha256(destination));
            assertEquals(SIZE, progress.get());
            assertEquals(3, fixture.attempts.get());
            assertEquals(Long.valueOf(0), fixture.offsets.get(0));
            assertTrue(fixture.offsets.get(1) > 0);
            assertTrue(fixture.offsets.get(2) > fixture.offsets.get(1));
            assertEquals(0, fixture.invalid.get());
        } finally { destination.delete(); }
    }

    public void testWrongResumeRangeStopsBeforeAppendingAnyMoreBytes() throws Exception {
        rejectsResume(Mode.WRONG_RANGE);
    }

    public void testRevocationAfterDisconnectStopsWithoutAnotherRetry() throws Exception {
        rejectsResume(Mode.REVOKED);
    }

    private void rejectsResume(Mode mode) throws Exception {
        File destination = temporary();
        try (Fixture fixture = new Fixture(mode)) {
            RemoteApi api = fixture.client();
            try (var output = new FileOutputStream(destination)) {
                try { api.download(PATH, TOKEN, output, SIZE, (received, total) -> {}); fail("Invalid resume was accepted"); }
                catch (IOException expected) {
                    if (mode == Mode.REVOKED) {
                        assertTrue(expected instanceof RemoteApi.Failure);
                        assertEquals(401, ((RemoteApi.Failure) expected).status);
                    }
                }
            } finally { api.cancel(); }
            assertEquals(2, fixture.attempts.get());
            assertTrue(destination.length() > 0);
            assertEquals("An invalid response appended bytes", fixture.offsets.get(1).longValue(), destination.length());
            assertEquals(0, fixture.invalid.get());
        } finally { destination.delete(); }
    }

    public void testExplicitCancellationOfARealHttpTransferDoesNotResume() throws Exception {
        File destination = temporary();
        try (Fixture fixture = new Fixture(Mode.RANGE)) {
            RemoteApi api = fixture.client();
            try (var output = new FileOutputStream(destination)) {
                try { api.download(PATH, TOKEN, output, SIZE, (received, total) -> api.cancel()); fail("Cancellation was ignored"); }
                catch (IOException expected) { }
            } finally { api.cancel(); }
            assertEquals(1, fixture.attempts.get());
            assertTrue(destination.length() > 0 && destination.length() < SIZE);
        } finally { destination.delete(); }
    }

    private File temporary() throws IOException {
        return File.createTempFile("download-integrity-", ".apk", getInstrumentation().getTargetContext().getCacheDir());
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[64 * 1024];
        try (var input = new FileInputStream(file)) {
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        StringBuilder hex = new StringBuilder();
        for (byte value : digest.digest()) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return hex.toString();
    }

    private enum Mode { RANGE, LEGACY, WRONG_RANGE, REVOKED }

    private final class Fixture implements AutoCloseable {
        final Mode mode;
        final File source = temporary();
        final ServerSocket server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        final java.util.concurrent.ExecutorService workers = Executors.newCachedThreadPool();
        final Set<Socket> clients = ConcurrentHashMap.newKeySet();
        final AtomicInteger attempts = new AtomicInteger(), invalid = new AtomicInteger();
        final List<Long> offsets = Collections.synchronizedList(new ArrayList<>());
        volatile boolean closed;

        Fixture(Mode mode) throws Exception {
            this.mode = mode;
            byte[] buffer = new byte[64 * 1024];
            try (var output = new FileOutputStream(source)) {
                for (long offset = 0; offset < SIZE;) {
                    int count = (int) Math.min(buffer.length, SIZE - offset);
                    for (int i = 0; i < count; i++) { long position = offset + i; buffer[i] = (byte) (position * 31 + (position >>> 7)); }
                    output.write(buffer, 0, count); offset += count;
                }
            }
            workers.execute(() -> {
                while (!closed) try {
                    Socket client = server.accept(); clients.add(client); workers.execute(() -> serve(client));
                } catch (IOException error) { if (!closed) invalid.incrementAndGet(); }
            });
        }

        RemoteApi client() throws Exception {
            RemoteApi api = new RemoteApi(getInstrumentation().getTargetContext(), "http://100.64.0.11:43127");
            // Keep production address validation intact; redirect only this test instance.
            var endpoint = RemoteApi.class.getDeclaredField("endpoint"); endpoint.setAccessible(true);
            var origin = Endpoint.class.getDeclaredField("origin"); origin.setAccessible(true);
            origin.set(endpoint.get(api), "http://127.0.0.1:" + server.getLocalPort());
            return api;
        }

        private void serve(Socket client) {
            try (client) {
                client.setSoTimeout(5000);
                var reader = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
                String request = reader.readLine(), line;
                boolean authenticated = false;
                long requested = 0;
                while ((line = reader.readLine()) != null && !line.isEmpty()) {
                    if (line.equals("Authorization: Bearer " + TOKEN)) authenticated = true;
                    if (line.startsWith("Range: bytes=")) requested = Long.parseLong(line.substring(13, line.length() - 1));
                }
                if (!authenticated || !("GET " + PATH + " HTTP/1.1").equals(request)) { invalid.incrementAndGet(); return; }
                int attempt = attempts.incrementAndGet(); offsets.add(requested);
                var output = client.getOutputStream();
                if (mode == Mode.REVOKED && attempt > 1) {
                    output.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.UTF_8)); output.flush(); return;
                }
                long start = mode == Mode.LEGACY ? 0 : requested;
                boolean partial = start > 0;
                String header = "HTTP/1.1 " + (partial ? "206 Partial Content" : "200 OK")
                    + "\r\nContent-Type: application/octet-stream\r\nContent-Length: " + (SIZE - start) + "\r\nConnection: close\r\n";
                if (partial) header += "Content-Range: bytes " + (mode == Mode.WRONG_RANGE ? 0 : start) + "-" + (SIZE - 1) + "/" + SIZE + "\r\n";
                output.write((header + "\r\n").getBytes(StandardCharsets.UTF_8));
                // Advertise the complete body, then close early on the first two connections.
                long remaining = Math.min(SIZE - start, attempt == 1 ? 5_000_123 : attempt == 2 ? 13_000_037 : Long.MAX_VALUE);
                try (var input = new RandomAccessFile(source, "r")) {
                    input.seek(start); byte[] buffer = new byte[64 * 1024];
                    while (remaining > 0) {
                        int count = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                        if (count < 0) break;
                        output.write(buffer, 0, count); remaining -= count;
                    }
                }
                output.flush();
            } catch (IOException ignored) { /* Cancellation or rejected response closes the socket. */ }
            finally { clients.remove(client); }
        }

        @Override public void close() throws Exception {
            closed = true; server.close();
            for (Socket client : clients) client.close();
            workers.shutdownNow(); workers.awaitTermination(5, TimeUnit.SECONDS); source.delete();
        }
    }
}
