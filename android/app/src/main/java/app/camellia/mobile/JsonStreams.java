package app.camellia.mobile;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.function.BooleanSupplier;

/** Bounded UTF-8 JSON quoting and Base64 encoding, shared by all request transports. */
final class JsonStreams {
    static final int CHUNK = 32 * 1024;
    static final BooleanSupplier NEVER_CANCELLED = () -> false;
    private static final byte[] BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] HEX = "0123456789abcdef".getBytes(StandardCharsets.US_ASCII);
    private JsonStreams() {}

    static void check(BooleanSupplier cancelled) throws IOException {
        if (cancelled.getAsBoolean()) throw new IOException("Cancelled");
    }

    static void range(byte[] bytes, int offset, int length) {
        if (offset < 0 || length < 0 || offset > bytes.length - length) throw new IndexOutOfBoundsException();
    }

    static long quotedLength(String value) {
        long length = 2;
        for (int index = 0; index < value.length(); index++) {
            char c = value.charAt(index);
            if (c == '"' || c == '\\' || c == '/' || c == '\b' || c == '\f' || c == '\n' || c == '\r' || c == '\t') length += 2;
            else if (c < 0x20) length += 6;
            else if (c < 0x80) length++;
            else if (c < 0x800) length += 2;
            else if (Character.isHighSurrogate(c) && index + 1 < value.length() && Character.isLowSurrogate(value.charAt(index + 1))) { length += 4; index++; }
            else if (Character.isSurrogate(c)) length++;
            else length += 3;
        }
        return length;
    }

    static long quotedLength(Reader value, BooleanSupplier cancelled) throws IOException {
        try (InputStream input = quote(value, cancelled)) {
            byte[] buffer = new byte[CHUNK]; long count = 0; int read;
            while ((read = input.read(buffer)) != -1) count += read;
            return count;
        }
    }

    static InputStream quote(String value, BooleanSupplier cancelled) {
        int capacity = (int) Math.min(CHUNK, Math.max(8L, 6L * value.length() + 2));
        return new Quoted(new StringReader(value), cancelled, capacity, Math.max(1, Math.min(4096, value.length())));
    }
    static InputStream quote(Reader value, BooleanSupplier cancelled) { return new Quoted(value, cancelled); }
    static InputStream quote(InputStream value, BooleanSupplier cancelled) { return quote(new Utf8(value), cancelled); }
    static InputStream base64(InputStream value, BooleanSupplier cancelled) { return new Encoded(value, cancelled); }

    private abstract static class Chunked extends InputStream {
        final byte[] buffer;
        final BooleanSupplier cancelled;
        int position, limit;
        volatile boolean closed;
        Chunked(BooleanSupplier cancelled) { this(cancelled, CHUNK); }
        Chunked(BooleanSupplier cancelled, int capacity) { this.cancelled = cancelled; buffer = new byte[capacity]; }
        abstract int fill() throws IOException;
        @Override public int read() throws IOException {
            if (!availableChunk()) return -1;
            return buffer[position++] & 255;
        }
        @Override public int read(byte[] target, int offset, int length) throws IOException {
            range(target, offset, length);
            if (length == 0) return 0;
            if (!availableChunk()) return -1;
            int count = Math.min(length, limit - position);
            System.arraycopy(buffer, position, target, offset, count); position += count; return count;
        }
        private boolean availableChunk() throws IOException {
            check(cancelled);
            if (closed) throw new IOException("Request body closed");
            if (position == limit) { limit = fill(); position = 0; }
            return limit > 0;
        }
    }

    private static final class Quoted extends Chunked {
        final Reader source;
        final char[] characters;
        int cursor, count, pending = -1;
        boolean started, finished;
        Quoted(Reader source, BooleanSupplier cancelled) { this(source, cancelled, CHUNK, 4096); }
        Quoted(Reader source, BooleanSupplier cancelled, int capacity, int characters) {
            super(cancelled, capacity); this.source = source; this.characters = new char[characters];
        }
        private int character() throws IOException {
            if (pending != -1) { int value = pending; pending = -1; return value; }
            while (cursor == count) {
                check(cancelled); count = source.read(characters); cursor = 0;
                if (count == -1) { count = 0; return -1; }
            }
            return characters[cursor++];
        }
        @Override int fill() throws IOException {
            if (finished) return 0;
            int end = 0;
            if (!started) { buffer[end++] = '"'; started = true; }
            while (end <= buffer.length - 6) {
                int c = character();
                if (c == -1) { buffer[end++] = '"'; finished = true; break; }
                int escaped = switch (c) { case '"', '\\', '/' -> c; case '\b' -> 'b'; case '\f' -> 'f'; case '\n' -> 'n'; case '\r' -> 'r'; case '\t' -> 't'; default -> -1; };
                if (escaped != -1) { buffer[end++] = '\\'; buffer[end++] = (byte) escaped; }
                else if (c < 0x20) {
                    buffer[end++] = '\\'; buffer[end++] = 'u'; buffer[end++] = '0'; buffer[end++] = '0';
                    buffer[end++] = HEX[c >> 4]; buffer[end++] = HEX[c & 15];
                } else {
                    if (Character.isHighSurrogate((char) c)) {
                        int next = character();
                        if (next != -1 && Character.isLowSurrogate((char) next)) c = Character.toCodePoint((char) c, (char) next);
                        else { pending = next; c = '?'; }
                    } else if (Character.isLowSurrogate((char) c)) c = '?';
                    if (c < 0x80) buffer[end++] = (byte) c;
                    else if (c < 0x800) { buffer[end++] = (byte) (0xc0 | c >> 6); buffer[end++] = (byte) (0x80 | c & 63); }
                    else if (c < 0x10000) {
                        buffer[end++] = (byte) (0xe0 | c >> 12); buffer[end++] = (byte) (0x80 | c >> 6 & 63); buffer[end++] = (byte) (0x80 | c & 63);
                    } else {
                        buffer[end++] = (byte) (0xf0 | c >> 18); buffer[end++] = (byte) (0x80 | c >> 12 & 63);
                        buffer[end++] = (byte) (0x80 | c >> 6 & 63); buffer[end++] = (byte) (0x80 | c & 63);
                    }
                }
            }
            return end;
        }
        @Override public void close() throws IOException { closed = true; source.close(); }
    }

    private static final class Utf8 extends Reader {
        final InputStream source;
        final Reader reader;
        Utf8(InputStream source) { this.source = source; reader = new InputStreamReader(source, StandardCharsets.UTF_8); }
        @Override public int read(char[] bytes, int offset, int length) throws IOException { return reader.read(bytes, offset, length); }
        @Override public void close() throws IOException {
            // Interrupt the file read before waiting for InputStreamReader's lock.
            try { source.close(); } finally { reader.close(); }
        }
    }

    private static final class Encoded extends Chunked {
        final InputStream source;
        final byte[] plain = new byte[CHUNK / 4 * 3];
        boolean finished;
        Encoded(InputStream source, BooleanSupplier cancelled) { super(cancelled); this.source = source; }
        @Override int fill() throws IOException {
            if (finished) return 0;
            int count = 0;
            while (count < plain.length) {
                check(cancelled);
                int read = source.read(plain, count, plain.length - count);
                if (read == -1) { finished = true; break; }
                count += read;
            }
            int end = 0, index = 0;
            while (index + 2 < count) {
                int value = (plain[index++] & 255) << 16 | (plain[index++] & 255) << 8 | plain[index++] & 255;
                buffer[end++] = BASE64[value >>> 18]; buffer[end++] = BASE64[value >>> 12 & 63];
                buffer[end++] = BASE64[value >>> 6 & 63]; buffer[end++] = BASE64[value & 63];
            }
            if (index < count) {
                int value = plain[index++] & 255;
                buffer[end++] = BASE64[value >>> 2];
                if (index < count) {
                    int second = plain[index] & 255;
                    buffer[end++] = BASE64[(value & 3) << 4 | second >>> 4]; buffer[end++] = BASE64[(second & 15) << 2];
                } else { buffer[end++] = BASE64[(value & 3) << 4]; buffer[end++] = '='; }
                buffer[end++] = '=';
            }
            return end;
        }
        @Override public void close() throws IOException { closed = true; source.close(); }
    }
}
