package app.camellia.mobile;

import java.io.IOException;
import java.io.InputStream;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicReference;

/** HTTP pulls a single reusable Java chunk; gomobile copies that chunk into Go. */
final class AttachmentUpload implements tailnet.UploadSource {
    private final AtomicReference<InputStream> input;
    private final byte[] buffer = new byte[JsonStreams.CHUNK];
    AttachmentUpload(AttachmentJson.Body body) { input = new AtomicReference<>(body.open()); }
    @Override public byte[] readChunk() throws IOException {
        InputStream current = input.get();
        if (current == null) throw new IOException("Request body closed");
        int count = current.read(buffer);
        if (count == -1) return null;
        return count == buffer.length ? buffer : Arrays.copyOf(buffer, count);
    }
    @Override public void close() {
        InputStream current = input.getAndSet(null);
        if (current != null) try { current.close(); }
        catch (IOException error) { android.util.Log.w("CamelliaAttachments", "Could not close upload stream", error); }
    }
}
