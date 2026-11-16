package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

public class RemoteApiDownloadRetryTest extends InstrumentationTestCase {
    public void testInterruptedDownloadAppendsOnlyTheRemainingBytes() throws Exception {
        java.util.List<Long> offsets = new java.util.ArrayList<>();
        RemoteApi api = new RemoteApi("http://100.64.0.1:43127") {
            @Override void downloadOnce(String path, String token, java.io.OutputStream output, long size, DownloadProgress progress) throws IOException {
                output.write("abc".getBytes(StandardCharsets.UTF_8)); throw new IOException("Embedded stream disconnected");
            }
            @Override void downloadAt(String path, String token, java.io.OutputStream output, long size, long offset, DownloadProgress progress) throws IOException {
                offsets.add(offset);
                if (offset == 3) { output.write("de".getBytes(StandardCharsets.UTF_8)); throw new IOException("Read timed out"); }
                assertEquals(5, offset); output.write("fgh".getBytes(StandardCharsets.UTF_8)); progress.update(size, size);
            }
        };
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        api.download("/v1/conversations/example/artifacts/file", "t".repeat(43), output, 8, (received, total) -> { });
        assertEquals("abcdefgh", output.toString(StandardCharsets.UTF_8.name()));
        assertEquals(java.util.List.of(3L, 5L), offsets);
    }

    public void testExplicitCancellationNeverRestartsADownload() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        RemoteApi api = new RemoteApi("http://100.64.0.1:43127") {
            @Override void downloadOnce(String path, String token, java.io.OutputStream output, long size, DownloadProgress progress) throws IOException {
                attempts.incrementAndGet(); cancel(); throw new IOException("Cancelled");
            }
        };
        try { api.download("/file", "t".repeat(43), new ByteArrayOutputStream(), 8, (received, total) -> { }); fail("Cancellation must escape"); }
        catch (IOException expected) { assertEquals(1, attempts.get()); }
    }

    public void testDestinationWriteFailuresDoNotRetryTheNetwork() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        RemoteApi api = new RemoteApi("http://100.64.0.1:43127") {
            @Override void downloadOnce(String path, String token, java.io.OutputStream output, long size, DownloadProgress progress) throws IOException {
                attempts.incrementAndGet(); output.write(1);
            }
        };
        try {
            api.download("/file", "t".repeat(43), new java.io.OutputStream() {
                @Override public void write(int value) throws IOException { throw new IOException("Disk full"); }
            }, 8, (received, total) -> { }); fail("Disk error must escape");
        } catch (IOException expected) { assertEquals(1, attempts.get()); }
    }

    public void testResumeRequiresExactSizeAndRange() throws Exception {
        RemoteApi.validateDownload(206, "application/octet-stream", 5, "bytes 3-7/8", 8, 3);
        RemoteApi.validateDownload(200, "application/octet-stream", 8, null, 8, 3);
        for (String range : new String[] { "bytes 0-4/8", "bytes 3-7/9", "", "bytes 3-6/8" }) {
            try { RemoteApi.validateDownload(206, "application/octet-stream", 5, range, 8, 3); fail("Wrong range accepted"); }
            catch (IOException expected) { }
        }
    }

    public void testDownloadRetries429AndReturnsBytes() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        RemoteApi api = new RemoteApi("http://100.64.0.1:43127") {
            @Override void downloadOnce(String path, String token, java.io.OutputStream output, long expectedSize, DownloadProgress progress) throws IOException {
                if (attempts.incrementAndGet() < 3) throw new Failure(429);
                output.write("image".getBytes(StandardCharsets.UTF_8)); progress.update(expectedSize, expectedSize);
            }
        };
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        api.download("/v1/conversations/example/artifacts/image", "t".repeat(43), output, 5, (received, total) -> { });
        assertEquals("image", output.toString(StandardCharsets.UTF_8.name())); assertEquals(3, attempts.get());
    }

    public void testDownloadDoesNotRetryOtherFailures() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        RemoteApi api = new RemoteApi("http://100.64.0.1:43127") {
            @Override void downloadOnce(String path, String token, java.io.OutputStream output, long expectedSize, DownloadProgress progress) throws IOException {
                attempts.incrementAndGet(); throw new Failure(500);
            }
        };
        try {
            api.download("/v1/conversations/example/artifacts/image", "t".repeat(43), new ByteArrayOutputStream(), 5, (received, total) -> { });
            fail("HTTP 500 must escape immediately");
        } catch (RemoteApi.Failure expected) { assertEquals(500, expected.status); }
        assertEquals(1, attempts.get());
    }

    public void testDownloadStopsAfterSix429Attempts() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        RemoteApi api = new RemoteApi("http://100.64.0.1:43127") {
            @Override void downloadOnce(String path, String token, java.io.OutputStream output, long expectedSize, DownloadProgress progress) throws IOException {
                attempts.incrementAndGet(); throw new Failure(429);
            }
        };
        try {
            api.download("/v1/conversations/example/artifacts/image", "t".repeat(43), new ByteArrayOutputStream(), 5, (received, total) -> { });
            fail("Persistent HTTP 429 must stop retrying");
        } catch (RemoteApi.Failure expected) { assertEquals(429, expected.status); }
        assertEquals(6, attempts.get());
    }
}
