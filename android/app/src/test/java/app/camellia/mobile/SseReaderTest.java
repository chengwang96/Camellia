package app.camellia.mobile;

import org.junit.Test;
import java.io.StringReader;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import static org.junit.Assert.*;

public class SseReaderTest {
    @Test public void acceptsHeartbeatsCrLfAndMultilineData() throws Exception {
        List<String> snapshots = new ArrayList<>();
        SseReader.read(new StringReader(": heartbeat\r\n\r\nid: server:1\r\nevent: snapshot\r\ndata: {\r\ndata: \"text\":\"你好\"}\r\n\r\n"), snapshots::add);
        assertEquals(List.of("{\n\"text\":\"你好\"}"), snapshots);
    }

    @Test public void dropsUnknownAndIncompleteEvents() throws Exception {
        List<String> snapshots = new ArrayList<>();
        SseReader.read(new StringReader("event: other\ndata: ignore\n\nevent: snapshot\ndata: complete\n\nevent: snapshot\ndata: truncated"), snapshots::add);
        assertEquals(List.of("complete"), snapshots);
    }

    @Test public void preservesLargeUnicodeSnapshotsAcrossReadBoundaries() throws Exception {
        List<String> snapshots = new ArrayList<>();
        String text = "回复🌺".repeat(100_000);
        SseReader.read(new StringReader("event: snapshot\ndata: " + text + "\n\n"), snapshots::add);
        assertEquals(text, snapshots.get(0));
    }

    @Test public void rejectsUnboundedDataAndPropagatesCancellation() {
        assertThrows(IOException.class, () -> SseReader.read(new StringReader("data: " + "x".repeat(8 * 1024 * 1024)), data -> {}));
        assertThrows(IOException.class, () -> SseReader.read(new StringReader("event: snapshot\ndata: {}\n\n"), data -> { throw new IOException("Cancelled"); }));
    }
}
