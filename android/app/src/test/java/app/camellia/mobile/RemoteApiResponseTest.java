package app.camellia.mobile;

import static org.junit.Assert.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class RemoteApiResponseTest {
    @Test public void exactLimitAndUnicodeAreAccepted() throws Exception {
        byte[] bytes = "{\"text\":\"中文 😀\"}".getBytes(StandardCharsets.UTF_8);
        assertEquals("中文 😀", RemoteApi.readJson(new ByteArrayInputStream(bytes), bytes.length, () -> false).getString("text"));
    }
    @Test public void oversizedReadStopsBeforeTheRestOfTheResponse() throws Exception {
        byte[] bytes = ("{\"text\":\"" + "x".repeat(2 * 1024 * 1024) + "\"}").getBytes(StandardCharsets.UTF_8);
        ByteArrayInputStream input = new ByteArrayInputStream(bytes);
        try { RemoteApi.readJson(input, RemotePrefetch.RESPONSE_LIMIT, () -> false); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("oversized")); }
        assertTrue(input.available() > 900_000);
    }
    @Test public void normalResponseLimitStillAcceptsLargerConversations() throws Exception {
        String text = "x".repeat(2 * 1024 * 1024); byte[] bytes = ("{\"text\":\"" + text + "\"}").getBytes(StandardCharsets.UTF_8);
        assertEquals(text.length(), RemoteApi.readJson(new ByteArrayInputStream(bytes), 8 * 1024 * 1024, () -> false).getString("text").length());
    }
    @Test public void cancellationIsReportedBeforeParsing() throws Exception {
        try { RemoteApi.readJson(new ByteArrayInputStream("{}".getBytes(StandardCharsets.UTF_8)), 100, () -> true); fail(); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("Cancelled")); }
    }
    @Test public void malformedJsonIsReportedAsIoFailure() throws Exception {
        try { RemoteApi.readJson(new ByteArrayInputStream("not-json".getBytes(StandardCharsets.UTF_8)), 100, () -> false); fail(); }
        catch (IOException expected) { assertEquals("Invalid server JSON", expected.getMessage()); }
    }
}
