package app.camellia.mobile;

import java.io.*;
import javax.crypto.Cipher;
import java.security.GeneralSecurityException;

/** Authenticate one existing AES-GCM file before exposing its plaintext. */
final class AuthenticatedInputStream extends InputStream {
    private final InputStream source;
    private final Cipher cipher;
    private final int expected;
    private byte[] plain;
    private int position, limit;
    private boolean authenticated;
    private volatile boolean closed;

    AuthenticatedInputStream(InputStream source, Cipher cipher, int expected) { this.source = source; this.cipher = cipher; this.expected = expected; }

    private void authenticate() throws IOException {
        if (closed) throw new IOException("Attachment stream closed");
        if (authenticated) return;
        // Do not ask CipherInputStream to size an output array for every small
        // read. KeyStore normally returns all authenticated output at doFinal;
        // reuse that array. Providers with early output need one bounded buffer.
        byte[] bytes = null, input = new byte[64 * 1024];
        int produced = 0, received = 0;
        try {
            int count;
            while ((count = source.read(input)) != -1) {
                if (closed) throw new IOException("Attachment stream closed");
                received += count;
                if (received > expected + 16) throw new IOException("Attachment changed while reading");
                byte[] output = cipher.update(input, 0, count);
                if (output != null && output.length > 0) {
                    if (produced + output.length > expected) throw new IOException("Attachment length changed");
                    if (bytes == null) bytes = new byte[expected];
                    System.arraycopy(output, 0, bytes, produced, output.length); produced += output.length;
                }
            }
            if (closed) throw new IOException("Attachment stream closed");
            byte[] output = cipher.doFinal();
            if (closed) throw new IOException("Attachment stream closed");
            if (bytes == null) { bytes = output; produced = output.length; }
            else {
                if (produced + output.length > expected) throw new IOException("Attachment length changed");
                System.arraycopy(output, 0, bytes, produced, output.length); produced += output.length;
            }
            if (produced != expected) throw new IOException("Attachment length changed");
            plain = bytes; limit = produced; authenticated = true;
        } catch (GeneralSecurityException error) {
            throw new IOException("Cannot authenticate encrypted attachment", error);
        } finally { if (!authenticated) closed = true; source.close(); }
    }

    @Override public int read() throws IOException {
        authenticate();
        if (position == limit) return -1;
        int value = plain[position++] & 255;
        if (position == limit) plain = null;
        return value;
    }
    @Override public int read(byte[] bytes, int offset, int length) throws IOException {
        JsonStreams.range(bytes, offset, length);
        if (length == 0) return 0;
        authenticate();
        if (position == limit) return -1;
        int count = Math.min(length, limit - position);
        System.arraycopy(plain, position, bytes, offset, count); position += count;
        if (position == limit) plain = null;
        return count;
    }
    @Override public void close() throws IOException { closed = true; source.close(); }
}
