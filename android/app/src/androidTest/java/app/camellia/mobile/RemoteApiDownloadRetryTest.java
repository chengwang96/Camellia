package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

public class RemoteApiDownloadRetryTest extends InstrumentationTestCase {
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
