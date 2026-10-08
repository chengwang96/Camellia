package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public final class JsonStreamsTest {
    @Test public void base64MatchesStandardEncoderAcrossShortReadsAndPadding() throws Exception {
        Random random = new Random(43127);
        for (int size : new int[]{0, 1, 2, 3, 7, 24575, 24576, 24577, 32768, 65537}) {
            byte[] bytes = new byte[size]; random.nextBytes(bytes);
            for (int step : new int[]{1, 7, 511, 8192}) {
                InputStream shortReads = new ByteArrayInputStream(bytes) {
                    @Override public synchronized int read(byte[] target, int offset, int count) { return super.read(target, offset, Math.min(step, count)); }
                };
                try (InputStream input = JsonStreams.base64(shortReads, JsonStreams.NEVER_CANCELLED)) {
                    assertArrayEquals(Base64.getEncoder().encode(bytes), drain(input, 113));
                }
            }
        }
    }

    @Test public void quotesRoundTripControlsBmpAndUnpairedSurrogates() throws Exception {
        StringBuilder all = new StringBuilder();
        for (int c = 0; c <= 0xffff; c++) all.append((char) c);
        assertQuoted(all.toString());
        assertQuoted("\"\\/\b\f\n\r\t\u0001中文 😀 \ud800x\udc00\ud800");
        assertQuoted("");
        assertQuoted("a".repeat(4095) + "😀" + "b".repeat(32761) + "\ud800");
    }

    private static void assertQuoted(String value) throws Exception {
        byte[] quoted;
        try (InputStream input = JsonStreams.quote(value, JsonStreams.NEVER_CANCELLED)) { quoted = drain(input, 19); }
        String wire = new String(quoted, StandardCharsets.UTF_8);
        assertEquals(new String(value.getBytes(StandardCharsets.UTF_8), StandardCharsets.UTF_8), new JSONObject("{\"v\":" + wire + "}").getString("v"));
        assertEquals(quoted.length, JsonStreams.quotedLength(value));
        Reader oneCharacter = new StringReader(value) {
            @Override public int read(char[] target, int offset, int length) throws IOException { return super.read(target, offset, Math.min(1, length)); }
        };
        try (InputStream input = JsonStreams.quote(oneCharacter, JsonStreams.NEVER_CANCELLED)) { assertArrayEquals(quoted, drain(input, 97)); }
        assertEquals(quoted.length, JsonStreams.quotedLength(new StringReader(value), JsonStreams.NEVER_CANCELLED));
    }

    @Test public void regularJsonBodyPreservesTypesAndCanBeReopened() throws Exception {
        JSONObject value = new JSONObject().put("a/\"中文", "😀\n\\test").put("number", 1.75).put("null", JSONObject.NULL)
            .put("array", new JSONArray().put(false).put(new JSONArray()).put(new JSONObject().put("content", "camellia-blob:00000000-0000-0000-0000-000000000000")));
        AttachmentJson.Body body = AttachmentJson.prepare(null, value, JsonStreams.NEVER_CANCELLED);
        byte[] first; try (InputStream input = body.open()) { first = drain(input, 7); }
        byte[] second; try (InputStream input = body.open()) { second = drain(input, 65536); }
        assertArrayEquals(first, second); assertEquals(first.length, body.length);
        JSONObject sent = new JSONObject(new String(first, StandardCharsets.UTF_8));
        assertEquals(value.toString(), sent.toString());
    }

    @Test public void openingAndReadingOneChunkDoesNotConsumeTheWholeSource() throws Exception {
        AtomicLong read = new AtomicLong(); AtomicBoolean closed = new AtomicBoolean();
        InputStream generated = new InputStream() {
            @Override public int read() { read.incrementAndGet(); return 1; }
            @Override public int read(byte[] bytes, int offset, int length) { Arrays.fill(bytes, offset, offset + length, (byte) 1); read.addAndGet(length); return length; }
            @Override public void close() { closed.set(true); }
        };
        try (InputStream input = JsonStreams.base64(generated, JsonStreams.NEVER_CANCELLED)) {
            assertEquals(0, read.get()); assertTrue(input.read(new byte[JsonStreams.CHUNK]) > 0);
            assertEquals(24576, read.get());
        }
        assertTrue(closed.get());
    }

    @Test public void cancellationStopsReadingAndCloseReleasesTheSource() throws Exception {
        AtomicBoolean cancelled = new AtomicBoolean(), closed = new AtomicBoolean(); AtomicInteger reads = new AtomicInteger();
        InputStream source = new ByteArrayInputStream(new byte[65536]) {
            @Override public synchronized int read(byte[] bytes, int offset, int length) { reads.incrementAndGet(); return super.read(bytes, offset, length); }
            @Override public void close() { closed.set(true); }
        };
        try (InputStream input = JsonStreams.base64(source, cancelled::get)) {
            input.read(new byte[32768]); int before = reads.get(); cancelled.set(true);
            try { input.read(); fail("Cancelled stream was read"); } catch (IOException expected) { assertEquals("Cancelled", expected.getMessage()); }
            assertEquals(before, reads.get());
        }
        assertTrue(closed.get());
    }

    @Test public void closeInterruptsABlockedReadWithoutTakingItsLock() throws Exception {
        blockedClose(false);
        blockedClose(true);
    }
    private static void blockedClose(boolean text) throws Exception {
        CountDownLatch reading = new CountDownLatch(1), released = new CountDownLatch(1);
        InputStream source = new InputStream() {
            @Override public int read() throws IOException { throw new IOException("bulk only"); }
            @Override public int read(byte[] bytes, int offset, int length) throws IOException {
                reading.countDown();
                try { if (!released.await(3, TimeUnit.SECONDS)) throw new IOException("Read was not interrupted"); }
                catch (InterruptedException error) { throw new IOException(error); }
                throw new IOException("closed");
            }
            @Override public void close() { released.countDown(); }
        };
        InputStream input = text ? JsonStreams.quote(source, JsonStreams.NEVER_CANCELLED) : JsonStreams.base64(source, JsonStreams.NEVER_CANCELLED);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<?> read = worker.submit(() -> { try { input.read(); fail(); } catch (IOException expected) { assertEquals("closed", expected.getMessage()); } });
            assertTrue(reading.await(1, TimeUnit.SECONDS)); input.close(); read.get(1, TimeUnit.SECONDS);
        } finally { input.close(); worker.shutdownNow(); }
    }

    @Test public void emptyReadsAndBoundsFollowInputStreamContract() throws Exception {
        try (InputStream input = JsonStreams.quote("", JsonStreams.NEVER_CANCELLED)) {
            assertEquals(0, input.read(new byte[1], 1, 0));
            try { input.read(new byte[1], 1, 1); fail(); } catch (IndexOutOfBoundsException expected) { }
            assertArrayEquals(new byte[]{'"', '"'}, drain(input, 1)); assertEquals(-1, input.read());
        }
    }

    private static byte[] drain(InputStream input, int chunk) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] bytes = new byte[chunk]; int count;
        while ((count = input.read(bytes)) != -1) output.write(bytes, 0, count);
        return output.toByteArray();
    }
}
