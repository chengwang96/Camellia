package app.camellia.mobile;

import android.content.Context;
import android.os.FileObserver;
import android.test.InstrumentationTestCase;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public final class AttachmentStreamingTest extends InstrumentationTestCase {
    private Context context;
    private final List<String> references = new ArrayList<>();
    private AttachmentMaintenance.Lease fixtures;

    @Override protected void setUp() throws Exception {
        super.setUp(); context = getInstrumentation().getTargetContext();
        LocalChatFixture.clear(context);
        new CredentialStore(context, "remote-private").clear();
        new CredentialStore(context, "remote-discussions-private").clear();
        fixtures = AttachmentMaintenance.protect(context, references);
    }
    @Override protected void tearDown() throws Exception {
        fixtures.close(); for (String reference : references) AttachmentStore.remove(context, reference);
        LocalChatFixture.clear(context); super.tearDown();
    }
    private String blob(byte[] bytes) throws Exception {
        String reference = AttachmentStore.save(context, bytes); references.add(reference); fixtures.replace(references); return reference;
    }
    private String text(String value) throws Exception {
        String reference = AttachmentStore.saveText(context, value); references.add(reference); fixtures.replace(references); return reference;
    }
    private File file(String reference) { return new File(new File(context.getNoBackupFilesDir(), "chat-attachments"), reference.substring(reference.indexOf(':') + 1)); }
    private static byte[] drain(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] bytes = new byte[113]; int count;
        while ((count = input.read(bytes)) != -1) output.write(bytes, 0, count); return output.toByteArray();
    }
    private byte[] sent(JSONObject value) throws IOException {
        AttachmentJson.Body body = AttachmentJson.prepare(context, value, JsonStreams.NEVER_CANCELLED);
        try (InputStream input = body.open()) { byte[] bytes = drain(input); assertEquals(bytes.length, body.length); return bytes; }
    }

    public void testQuotedBytesMatchAndroidJsonAcrossUnicodeAndBufferBoundaries() throws Exception {
        StringBuilder all = new StringBuilder(); for (int c = 0; c <= 0xffff; c++) all.append((char) c);
        for (String value : new String[]{"", "/中文😀\n\u0001\\\"", "a".repeat(4095) + "😀" + "b".repeat(32761) + "\ud800", all.toString()}) {
            byte[] expected = JSONObject.quote(value).getBytes(StandardCharsets.UTF_8);
            try (InputStream input = JsonStreams.quote(value, JsonStreams.NEVER_CANCELLED)) { assertTrue(Arrays.equals(expected, drain(input))); }
            assertEquals(expected.length, JsonStreams.quotedLength(value));
        }
    }

    public void testBinaryPaddingLengthAndAttachmentFieldCompatibility() throws Exception {
        Random random = new Random(43127);
        for (int size : new int[]{0, 1, 2, 3, 24575, 24576, 24577, 65537}) {
            byte[] bytes = new byte[size]; random.nextBytes(bytes); String reference = blob(bytes);
            JSONObject body = new JSONObject().put("data", reference).put("url", "data:image/jpeg;base64," + reference)
                .put("file_data", "data:application/pdf;base64," + reference).put("images", new JSONArray().put(reference)).put("content", reference);
            JSONObject result = new JSONObject(new String(sent(body), StandardCharsets.UTF_8));
            String expected = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);
            assertEquals(expected, result.getString("data")); assertEquals("data:image/jpeg;base64," + expected, result.getString("url"));
            assertEquals("data:application/pdf;base64," + expected, result.getString("file_data"));
            assertEquals(expected, result.getJSONArray("images").getString(0)); assertEquals(reference, result.getString("content"));
        }
    }

    public void testLengthDoesNotOpenBinaryAndActualOutputOpensOnce() throws Exception {
        String reference = blob(new byte[131071]); JSONObject payload = new JSONObject().put("data", reference);
        try (Opens opens = new Opens(file(reference))) {
            AttachmentJson.Body body = AttachmentJson.prepare(context, payload, JsonStreams.NEVER_CANCELLED);
            assertEquals(0, opens.count.get());
            Counter output = new Counter(); body.writeTo(output); opens.awaitClose(1);
            assertEquals(body.length, output.count); assertEquals(1, opens.count.get());
            body.writeTo(new Counter()); opens.awaitClose(2); assertEquals(2, opens.count.get());
        }
    }

    public void testNewTextMetadataAvoidsReadingTextForLength() throws Exception {
        String value = "中文 / 😀\n\"\\\u0001".repeat(9000), reference = text(value);
        assertEquals(56, new File(file(reference).getPath() + ".meta").length());
        try (Opens opens = new Opens(file(reference))) {
            JSONObject payload = new JSONObject().put("text", reference);
            long length = AttachmentJson.length(context, payload);
            assertEquals(length, AttachmentJson.length(context, new JSONObject(payload.toString())));
            assertEquals(0, opens.count.get());
            JSONObject result = new JSONObject(new String(sent(payload), StandardCharsets.UTF_8)); opens.awaitClose(1);
            assertEquals(value, result.getString("text")); assertEquals(1, opens.count.get());
        }
    }

    public void testLegacyTextMetadataIsRebuiltAndAuthenticatedForItsOwnFile() throws Exception {
        String value = "legacy 中文 😀 /\n".repeat(1000);
        String reference = blob(value.getBytes(StandardCharsets.UTF_8)).replace(AttachmentStore.PREFIX, AttachmentStore.TEXT_PREFIX);
        JSONObject payload = new JSONObject().put("text", reference);
        try (Opens opens = new Opens(file(reference))) {
            long expected = AttachmentJson.length(context, payload); opens.awaitClose(1); assertEquals(1, opens.count.get());
            assertEquals(expected, AttachmentJson.length(context, payload)); assertEquals(1, opens.count.get());
            String other = text("x".repeat(200));
            Files.copy(new File(file(other).getPath() + ".meta").toPath(), new File(file(reference).getPath() + ".meta").toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            assertEquals(expected, AttachmentJson.length(context, payload)); opens.awaitClose(2); assertEquals(2, opens.count.get());
            assertEquals(expected, AttachmentJson.length(context, payload)); assertEquals(2, opens.count.get());
            JSONObject result = new JSONObject(new String(sent(payload), StandardCharsets.UTF_8)); opens.awaitClose(3);
            assertEquals(value, result.getString("text")); assertEquals(3, opens.count.get());
        }
    }

    public void testCorruptCiphertextAbortsWithoutCompletingJsonAndMissingFilesFailPreparation() throws Exception {
        String reference = blob(new byte[65536]);
        try (RandomAccessFile data = new RandomAccessFile(file(reference), "rw")) {
            data.seek(data.length() - 1); int value = data.read(); data.seek(data.length() - 1); data.write(value ^ 1);
        }
        AttachmentJson.Body body = AttachmentJson.prepare(context, new JSONObject().put("data", reference), JsonStreams.NEVER_CANCELLED);
        Counter output = new Counter();
        try { body.writeTo(output); fail("Corrupt attachment was uploaded"); } catch (IOException expected) { }
        assertTrue(output.count < body.length);
        assertTrue(file(reference).delete());
        try { AttachmentJson.prepare(context, new JSONObject().put("data", reference), JsonStreams.NEVER_CANCELLED); fail("Missing attachment accepted"); }
        catch (IOException expected) { }
    }

    public void testUploadPullIsLazyCancellationClosesFileAndRetryReopensIt() throws Exception {
        String reference = blob(new byte[131071]); AtomicBoolean cancelled = new AtomicBoolean();
        JSONObject payload = new JSONObject().put("data", reference);
        try (Opens opens = new Opens(file(reference))) {
            AttachmentUpload upload = new AttachmentUpload(AttachmentJson.prepare(context, payload, cancelled::get));
            assertEquals(0, opens.count.get()); assertTrue(upload.readChunk().length <= JsonStreams.CHUNK);
            cancelled.set(true);
            try { upload.readChunk(); fail(); } catch (IOException expected) { assertEquals("Cancelled", expected.getMessage()); }
            upload.close(); upload.close(); opens.awaitClose(1);
            assertEquals(1, opens.count.get()); assertTrue(file(reference).isFile());
            Counter output = new Counter(); AttachmentJson.prepare(context, payload, JsonStreams.NEVER_CANCELLED).writeTo(output);
            opens.awaitClose(2); assertEquals(2, opens.count.get());
        }
    }

    public void testTextMetadataAndInterruptedMetadataWritesFollowReferenceCleanup() throws Exception {
        String reference = AttachmentStore.saveText(context, "cleanup 中文 / 😀"); File data = file(reference), metadata = new File(data.getPath() + ".meta");
        Files.copy(metadata.toPath(), new File(data.getPath() + ".meta.new").toPath());
        AttachmentMaintenance.Lease retained = AttachmentMaintenance.protect(context, reference);
        try {
            AttachmentMaintenance.release(context, reference);
            AttachmentMaintenance.Result result = AttachmentMaintenance.get(context).collectNow(false).get(10, TimeUnit.SECONDS);
            assertNull(result.error); assertTrue(data.isFile()); assertTrue(metadata.isFile());
        } finally { retained.close(); }
        AttachmentMaintenance.Result result = AttachmentMaintenance.get(context).collectNow(false).get(10, TimeUnit.SECONDS);
        assertNull(result.error);
        for (String suffix : AttachmentStore.SUFFIXES) assertFalse(new File(data.getPath() + suffix).exists());
    }

    public void testOldMetadataOnlyOrphansAreSweptWithTheirGracePeriod() throws Exception {
        File directory = new File(context.getNoBackupFilesDir(), "chat-attachments"); assertTrue(directory.isDirectory() || directory.mkdirs());
        String old = UUID.randomUUID().toString(), recent = UUID.randomUUID().toString();
        File metadata = new File(directory, old + ".meta"), temporary = new File(directory, old + ".meta.new"), fresh = new File(directory, recent + ".meta");
        try {
            Files.write(metadata.toPath(), new byte[56]); Files.write(temporary.toPath(), new byte[56]); Files.write(fresh.toPath(), new byte[56]);
            long beforeGrace = System.currentTimeMillis() - AttachmentMaintenance.GRACE_MS - 10000;
            assertTrue(metadata.setLastModified(beforeGrace)); assertTrue(temporary.setLastModified(beforeGrace));
            AttachmentMaintenance.Result result = AttachmentMaintenance.get(context).collectNow(true).get(10, TimeUnit.SECONDS);
            assertNull(result.error); assertFalse(metadata.exists()); assertFalse(temporary.exists()); assertTrue(fresh.exists());
        } finally { metadata.delete(); temporary.delete(); fresh.delete(); }
    }

    public void testLocalProviderWireContentAndApiKeyRetryUseTheSameAttachments() throws Exception {
        String image = blob(new byte[]{1, 2, 3, 4}), pdf = blob("%PDF-1.7\nfixture".getBytes(StandardCharsets.UTF_8)), text = text("中文 😀 /\n\"notes\"");
        JSONArray documents = new JSONArray().put(new JSONObject().put("name", "review.pdf").put("mimeType", "application/pdf").put("data", pdf))
            .put(new JSONObject().put("name", "notes.txt").put("mimeType", "text/plain").put("text", text));
        JSONArray history = new JSONArray().put(new JSONObject().put("role", "user").put("content", "review 中文")
            .put("images", new JSONArray().put(image)).put("documents", documents));
        String response = "{\"choices\":[{\"message\":{\"content\":\"reply\"}}]}";
        try (LocalServer server = new LocalServer(new Reply(401, "{\"error\":{\"message\":\"invalid api key\"}}"), new Reply(200, response))) {
            LocalChatConfig.Route route = new LocalChatConfig.Route("fixture", "fixture", "fixture-model", "openai", server.origin() + "/v1", List.of("fixture-alpha", "fixture-beta"));
            JSONObject body = LocalChatClient.request(route, history); AtomicReference<String> reply = new AtomicReference<>();
            assertEquals("reply", new LocalChatClient(context).chat(route, body, reply::set)); server.await(); assertEquals("reply", reply.get());
            assertEquals(2, server.requests.size()); assertEquals(server.requests.get(0).body.toString(), server.requests.get(1).body.toString());
            assertEquals("Bearer fixture-alpha", server.requests.get(0).headers.get("authorization")); assertEquals("Bearer fixture-beta", server.requests.get(1).headers.get("authorization"));
            JSONArray parts = server.requests.get(0).body.getJSONArray("messages").getJSONObject(0).getJSONArray("content");
            assertEquals("data:image/jpeg;base64,AQIDBA==", parts.getJSONObject(1).getJSONObject("image_url").getString("url"));
            assertTrue(parts.getJSONObject(2).getJSONObject("file").getString("file_data").startsWith("data:application/pdf;base64,"));
            assertEquals("中文 😀 /\n\"notes\"", parts.getJSONObject(4).getString("text"));
        }
        try (LocalServer server = new LocalServer(new Reply(200, "{\"content\":[{\"type\":\"text\",\"text\":\"reply\"}]}"))) {
            LocalChatConfig.Route route = new LocalChatConfig.Route("fixture", "fixture", "fixture-model", "anthropic", server.origin() + "/v1", "fixture-key");
            assertEquals("reply", new LocalChatClient(context).chat(route, LocalChatClient.request(route, history), value -> {})); server.await();
            JSONArray parts = server.requests.get(0).body.getJSONArray("messages").getJSONObject(0).getJSONArray("content");
            assertEquals("AQIDBA==", parts.getJSONObject(1).getJSONObject("source").getString("data"));
            assertEquals("application/pdf", parts.getJSONObject(2).getJSONObject("source").getString("media_type"));
            assertEquals("中文 😀 /\n\"notes\"", parts.getJSONObject(4).getString("text"));
        }
    }

    public void testRemoteHttpProtectsAttachmentUntilResponseAndKeepsRequestIdentity() throws Exception {
        String reference = blob(new byte[]{1, 2, 3, 4}); String requestId = UUID.randomUUID().toString();
        boolean original = context.getSharedPreferences("network-mode", 0).getBoolean("embedded", true);
        context.getSharedPreferences("network-mode", 0).edit().putBoolean("embedded", false).commit();
        ExecutorService sender = Executors.newSingleThreadExecutor();
        try (LocalServer server = new LocalServer(true, new Reply(200, "{\"accepted\":true}"))) {
            RemoteApi api = new RemoteApi(context, "http://100.80.1.2:" + server.socket.getLocalPort());
            // Only this fixture's endpoint is redirected; production target validation stays intact.
            var endpoint = RemoteApi.class.getDeclaredField("endpoint"); endpoint.setAccessible(true);
            var origin = Endpoint.class.getDeclaredField("origin"); origin.setAccessible(true); origin.set(endpoint.get(api), server.origin());
            JSONObject payload = new JSONObject().put("requestId", requestId).put("attachments", new JSONArray().put(new JSONObject().put("data", reference)));
            Future<JSONObject> response = sender.submit(() -> api.json("/v1/commands", null, payload));
            assertTrue(server.received.await(10, TimeUnit.SECONDS));
            references.remove(reference); fixtures.replace(references); AttachmentMaintenance.release(context, reference);
            AttachmentMaintenance.Result protectedResult = AttachmentMaintenance.get(context).collectNow(false).get(10, TimeUnit.SECONDS);
            assertNull(protectedResult.error); assertTrue("In-flight upload lost its file", file(reference).isFile());
            server.allowReply.countDown(); assertTrue(response.get(10, TimeUnit.SECONDS).getBoolean("accepted")); server.await();
            assertEquals(requestId, server.requests.get(0).body.getString("requestId"));
            assertEquals("AQIDBA==", server.requests.get(0).body.getJSONArray("attachments").getJSONObject(0).getString("data"));
            AttachmentMaintenance.Result released = AttachmentMaintenance.get(context).collectNow(false).get(10, TimeUnit.SECONDS);
            assertNull(released.error); assertFalse(file(reference).exists());
        } finally {
            sender.shutdownNow(); context.getSharedPreferences("network-mode", 0).edit().putBoolean("embedded", original).commit();
        }
    }

    public void testNativeBridgeClosesPreparedJavaSourcesOnRequestAndNodeClose() throws Exception {
        EmbeddedNetwork.registerInterfaces(); Map<String, String> state = new ConcurrentHashMap<>();
        tailnet.Storage storage = new tailnet.Storage() {
            @Override public String read(String key) { return state.getOrDefault(key, ""); }
            @Override public void write(String key, String value) { state.put(key, value); }
        };
        File directory = new File(context.getNoBackupFilesDir(), "tailnet-upload-fixture"); assertTrue(directory.isDirectory() || directory.mkdirs());
        tailnet.Node node = tailnet.Tailnet.newNode(directory.getPath(), storage);
        try {
            AttachmentJson.Body body = AttachmentJson.prepare(context, new JSONObject().put("text", "fixture"), JsonStreams.NEVER_CANCELLED);
            AttachmentUpload first = new AttachmentUpload(body);
            tailnet.Response response = node.prepareStream("POST", "http://100.80.1.2:43127/v1/commands", "", body.length, first);
            response.close();
            try { first.readChunk(); fail("Prepared source remained open"); } catch (IOException expected) { }
            AttachmentUpload second = new AttachmentUpload(body);
            node.prepareStream("POST", "http://100.80.1.2:43127/v1/commands", "", body.length, second); node.close();
            try { second.readChunk(); fail("Node close did not release source"); } catch (IOException expected) { }
        } finally { node.close(); }
    }

    public void testMemoryPeaksFor32MiBAndSingleFileDecryption() throws Exception {
        JSONArray attachments = new JSONArray(); String largest = null;
        for (int size : new int[]{10 * 1024 * 1024, 10 * 1024 * 1024, 10 * 1024 * 1024, 2 * 1024 * 1024}) {
            String reference = blob(new byte[size]); if (largest == null) largest = reference;
            attachments.put(new JSONObject().put("name", "fixture.pdf").put("data", reference).put("size", size));
        }
        JSONObject payload = new JSONObject().put("attachments", attachments);
        AttachmentJson.Body body = AttachmentJson.prepare(context, payload, JsonStreams.NEVER_CANCELLED);
        Counter discarded = new Counter(); Memory streamed = new Memory();
        try (streamed) { body.writeTo(new OutputStream() {
            @Override public void write(int value) { discarded.write(value); streamed.sample(); }
            @Override public void write(byte[] bytes, int offset, int length) { discarded.write(bytes, offset, length); streamed.sample(); }
        }); }
        assertEquals(body.length, discarded.count); assertTrue(discarded.chunk <= JsonStreams.CHUNK);
        Memory decrypt = new Memory(); long decoded = 0;
        try (decrypt; InputStream input = AttachmentStore.open(context, largest)) {
            byte[] buffer = new byte[JsonStreams.CHUNK]; int count;
            while ((count = input.read(buffer)) != -1) { decoded += count; decrypt.sample(); }
        }
        assertEquals(10 * 1024 * 1024, decoded);
        Memory legacyDecrypt = new Memory(); long legacyDecoded = 0;
        FileInputStream oldFile = new FileInputStream(file(largest));
        byte[] iv = new byte[12]; new DataInputStream(oldFile).readFully(iv);
        javax.crypto.Cipher oldCipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
        oldCipher.init(javax.crypto.Cipher.DECRYPT_MODE, CredentialStore.key(), new javax.crypto.spec.GCMParameterSpec(128, iv));
        oldCipher.updateAAD("camellia.attachments.v1".getBytes(StandardCharsets.UTF_8));
        try (legacyDecrypt; InputStream input = new javax.crypto.CipherInputStream(oldFile, oldCipher)) {
            byte[] buffer = new byte[JsonStreams.CHUNK]; int count;
            while ((count = input.read(buffer)) != -1) { legacyDecoded += count; legacyDecrypt.sample(); }
        }
        assertEquals(decoded, legacyDecoded);
        Memory materialized = new Memory();
        try (materialized) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            body.writeTo(new FilterOutputStream(output) {
                @Override public void write(byte[] bytes, int offset, int length) throws IOException { out.write(bytes, offset, length); materialized.sample(); }
            });
            String expanded = output.toString(StandardCharsets.UTF_8.name()); materialized.sample();
            assertEquals(body.length, expanded.length()); assertEquals('}', expanded.charAt(expanded.length() - 1));
        }
        JSONObject metrics = new JSONObject().put("rawAttachmentBytes", 32 * 1024 * 1024).put("encodedRequestBytes", body.length).put("maxWriteChunkBytes", discarded.chunk)
            .put("streamJavaHeapPeakDelta", streamed.heapDelta()).put("expandedJavaHeapPeakDelta", materialized.heapDelta())
            .put("decrypt10MiBJavaHeapPeakDelta", decrypt.heapDelta()).put("streamPssPeakDeltaKiB", streamed.pssDelta())
            .put("expandedPssPeakDeltaKiB", materialized.pssDelta()).put("decrypt10MiBPssPeakDeltaKiB", decrypt.pssDelta())
            .put("streamJavaAllocatedBytes", streamed.allocated()).put("decrypt10MiBJavaAllocatedBytes", decrypt.allocated())
            .put("legacyDecrypt10MiBJavaAllocatedBytes", legacyDecrypt.allocated()).put("legacyDecrypt10MiBJavaHeapPeakDelta", legacyDecrypt.heapDelta())
            .put("streamMillis", streamed.elapsedMillis).put("decrypt10MiBMillis", decrypt.elapsedMillis).put("legacyDecrypt10MiBMillis", legacyDecrypt.elapsedMillis);
        Log.i("CamelliaUploadTest", "CAMELLIA_ANDROID_UPLOAD_MEMORY " + metrics);
    }

    private record Reply(int status, String body) {}
    private record Request(JSONObject body, Map<String, String> headers) {}
    private static final class LocalServer implements AutoCloseable {
        final ServerSocket socket = new ServerSocket(0, 2, InetAddress.getByName("127.0.0.1"));
        final ExecutorService worker = Executors.newSingleThreadExecutor();
        final List<Request> requests = Collections.synchronizedList(new ArrayList<>());
        final CountDownLatch received = new CountDownLatch(1), allowReply = new CountDownLatch(1);
        final Future<?> served;
        LocalServer(Reply... replies) throws IOException { this(false, replies); }
        LocalServer(boolean hold, Reply... replies) throws IOException {
            served = worker.submit(() -> {
                try {
                    for (Reply reply : replies) try (Socket client = socket.accept()) {
                        client.setSoTimeout(10000); InputStream input = new BufferedInputStream(client.getInputStream());
                        line(input); Map<String, String> headers = new HashMap<>(); String header;
                        while (!(header = line(input)).isEmpty()) { int separator = header.indexOf(':'); headers.put(header.substring(0, separator).toLowerCase(Locale.ROOT), header.substring(separator + 1).trim()); }
                        assertFalse(headers.containsKey("transfer-encoding")); int length = Integer.parseInt(headers.get("content-length")); assertTrue(length < 1024 * 1024);
                        byte[] body = new byte[length]; new DataInputStream(input).readFully(body);
                        requests.add(new Request(new JSONObject(new String(body, StandardCharsets.UTF_8)), headers)); received.countDown();
                        if (hold) assertTrue(allowReply.await(20, TimeUnit.SECONDS));
                        byte[] result = reply.body().getBytes(StandardCharsets.UTF_8);
                        OutputStream output = client.getOutputStream();
                        output.write(("HTTP/1.1 " + reply.status() + " OK\r\nContent-Type: application/json\r\nContent-Length: " + result.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                        output.write(result); output.flush();
                    }
                } catch (Exception error) { throw new RuntimeException(error); }
            });
        }
        String origin() { return "http://127.0.0.1:" + socket.getLocalPort(); }
        void await() throws Exception { served.get(10, TimeUnit.SECONDS); }
        private static String line(InputStream input) throws IOException {
            ByteArrayOutputStream output = new ByteArrayOutputStream(); int value;
            while ((value = input.read()) != -1 && value != '\n') { output.write(value); if (output.size() > 32768) throw new IOException("Fixture header too large"); }
            if (value == -1) throw new EOFException("Fixture request ended");
            return output.toString(StandardCharsets.US_ASCII.name()).replace("\r", "");
        }
        @Override public void close() throws IOException { allowReply.countDown(); socket.close(); worker.shutdownNow(); }
    }

    private static final class Memory implements AutoCloseable {
        final long baseline, baselinePss, allocatedBaseline, started;
        long allocatedBytes, elapsedMillis;
        final AtomicLong heap = new AtomicLong(), pss = new AtomicLong();
        final ScheduledExecutorService sampling = Executors.newSingleThreadScheduledExecutor();
        Memory() throws InterruptedException {
            System.gc(); System.runFinalization(); Thread.sleep(100);
            baseline = used(); baselinePss = android.os.Debug.getPss(); heap.set(baseline); pss.set(baselinePss);
            allocatedBaseline = Long.parseLong(android.os.Debug.getRuntimeStat("art.gc.bytes-allocated"));
            started = android.os.SystemClock.elapsedRealtime();
            sampling.scheduleAtFixedRate(this::sampleAll, 0, 25, TimeUnit.MILLISECONDS);
        }
        void sample() { heap.accumulateAndGet(used(), Math::max); }
        void sampleAll() { sample(); pss.accumulateAndGet(android.os.Debug.getPss(), Math::max); }
        static long used() {
            Runtime runtime = Runtime.getRuntime(); long total = runtime.totalMemory(), free = runtime.freeMemory();
            return total == runtime.totalMemory() ? total - free : 0;
        }
        long allocated() { return allocatedBytes; }
        long heapDelta() { return Math.max(0, heap.get() - baseline); }
        long pssDelta() { return Math.max(0, pss.get() - baselinePss); }
        @Override public void close() {
            sampleAll(); sampling.shutdownNow();
            allocatedBytes = Long.parseLong(android.os.Debug.getRuntimeStat("art.gc.bytes-allocated")) - allocatedBaseline;
            elapsedMillis = android.os.SystemClock.elapsedRealtime() - started;
        }
    }

    private static final class Opens extends FileObserver implements AutoCloseable {
        final String name;
        final AtomicInteger count = new AtomicInteger(), closes = new AtomicInteger();
        Opens(File file) { super(file.getParent(), OPEN | CLOSE_NOWRITE); name = file.getName(); startWatching(); }
        @Override public void onEvent(int event, String path) {
            if (!name.equals(path)) return;
            if ((event & OPEN) != 0) count.incrementAndGet(); if ((event & CLOSE_NOWRITE) != 0) closes.incrementAndGet();
        }
        void awaitClose(int count) throws Exception {
            long until = android.os.SystemClock.uptimeMillis() + 3000;
            while (closes.get() < count && android.os.SystemClock.uptimeMillis() < until) Thread.sleep(10);
            assertTrue("File close event missing", closes.get() >= count); Thread.sleep(80);
        }
        @Override public void close() { stopWatching(); }
    }
    private static class Counter extends OutputStream {
        long count; int chunk;
        @Override public void write(int value) { count++; chunk = Math.max(chunk, 1); }
        @Override public void write(byte[] bytes, int offset, int length) { count += length; chunk = Math.max(chunk, length); }
    }
}
