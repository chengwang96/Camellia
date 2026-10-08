package app.camellia.mobile;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.function.BooleanSupplier;

/** Attachment references stay small until a transport asks for the next body chunk. */
final class AttachmentJson {
    private AttachmentJson() {}

    static final class Body {
        final long length;
        private final Context context;
        private final JSONObject value;
        private final BooleanSupplier cancelled;
        private Body(Context context, JSONObject value, BooleanSupplier cancelled) throws IOException {
            this.context = context; this.value = value; this.cancelled = cancelled;
            length = measure(context, value, "", cancelled);
        }
        InputStream open() { return new JsonInput(context, value, cancelled); }
        void writeTo(OutputStream output) throws IOException {
            try (InputStream input = open()) { copy(input, output); }
        }
    }

    static Body prepare(Context context, JSONObject value, BooleanSupplier cancelled) throws IOException { return new Body(context, value, cancelled); }
    static long length(Context context, JSONObject value) throws IOException { return measure(context, value, "", JsonStreams.NEVER_CANCELLED); }
    static void write(Context context, Object value, OutputStream output) throws IOException {
        try (InputStream input = new JsonInput(context, value, JsonStreams.NEVER_CANCELLED)) { copy(input, output); }
    }
    private static void copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[JsonStreams.CHUNK]; int count;
        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
    }

    private static long measure(Context context, Object value, String key, BooleanSupplier cancelled) throws IOException {
        JsonStreams.check(cancelled);
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value; long count = 2; boolean first = true;
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String name = keys.next(); count += (first ? 0 : 1) + JsonStreams.quotedLength(name) + 1;
                count += measure(context, object.opt(name), name, cancelled); first = false;
            }
            return count;
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value; long count = 2;
            for (int index = 0; index < array.length(); index++) count += (index == 0 ? 0 : 1) + measure(context, array.opt(index), key, cancelled);
            return count;
        }
        if (value instanceof String) {
            String text = (String) value, prefix = prefix(text), reference = text.substring(prefix.length());
            if (binary(key, reference)) return 2 + prefix.length() + 4 * ((AttachmentStore.size(context, reference) + 2) / 3);
            if (text(key, text)) return AttachmentStore.textJsonLength(context, text, cancelled);
            return JsonStreams.quotedLength(text);
        }
        return literal(value).getBytes(StandardCharsets.UTF_8).length;
    }

    private static String literal(Object value) { return value == null || value == JSONObject.NULL ? "null" : value.toString(); }
    private static String prefix(String value) {
        return value.startsWith("data:image/jpeg;base64,") || value.startsWith("data:application/pdf;base64,") ? value.substring(0, value.indexOf(',') + 1) : "";
    }
    private static boolean binary(String key, String reference) {
        return (key.equals("data") || key.equals("file_data") || key.equals("url") || key.equals("images") || key.equals("image"))
            && reference.startsWith(AttachmentStore.PREFIX) && AttachmentStore.isReference(reference);
    }
    private static boolean text(String key, String value) { return key.equals("text") && value.startsWith(AttachmentStore.TEXT_PREFIX) && AttachmentStore.isReference(value); }

    private record Value(Object value, String key) {}
    private record Raw(String value) {}
    private static final class ObjectCursor {
        final JSONObject object;
        final Iterator<String> keys;
        boolean first = true;
        ObjectCursor(JSONObject object) { this.object = object; keys = object.keys(); }
    }
    private static final class ArrayCursor {
        final JSONArray array;
        final String key;
        int index;
        ArrayCursor(JSONArray array, String key) { this.array = array; this.key = key; }
    }

    private static final class JsonInput extends InputStream {
        final Context context;
        final BooleanSupplier cancelled;
        final ArrayDeque<Object> pending = new ArrayDeque<>();
        volatile InputStream active;
        volatile boolean closed;
        JsonInput(Context context, Object value, BooleanSupplier cancelled) {
            this.context = context; this.cancelled = cancelled; pending.push(new Value(value, ""));
        }
        @Override public int read() throws IOException {
            byte[] single = new byte[1]; int count = read(single, 0, 1); return count == -1 ? -1 : single[0] & 255;
        }
        @Override public int read(byte[] bytes, int offset, int length) throws IOException {
            JsonStreams.range(bytes, offset, length);
            if (length == 0) return 0;
            int received = 0;
            while (received < length) {
                JsonStreams.check(cancelled);
                if (closed) throw new IOException("Request body closed");
                if (active == null) {
                    InputStream next = next();
                    if (next == null) break;
                    active = next;
                    if (closed) { next.close(); throw new IOException("Request body closed"); }
                }
                int count = active.read(bytes, offset + received, length - received);
                if (count == -1) { active.close(); active = null; }
                else received += count;
            }
            return received == 0 ? -1 : received;
        }
        private InputStream next() throws IOException {
            while (!pending.isEmpty()) {
                JsonStreams.check(cancelled); Object item = pending.pop();
                if (item instanceof Raw) return raw(((Raw) item).value());
                if (item instanceof ObjectCursor) {
                    ObjectCursor cursor = (ObjectCursor) item;
                    if (!cursor.keys.hasNext()) return raw("}");
                    String name = cursor.keys.next(); pending.push(cursor);
                    pending.push(new Value(cursor.object.opt(name), name)); pending.push(new Raw(":")); pending.push(new Value(name, ""));
                    if (!cursor.first) pending.push(new Raw(",")); cursor.first = false; continue;
                }
                if (item instanceof ArrayCursor) {
                    ArrayCursor cursor = (ArrayCursor) item;
                    if (cursor.index == cursor.array.length()) return raw("]");
                    pending.push(cursor); pending.push(new Value(cursor.array.opt(cursor.index), cursor.key));
                    if (cursor.index++ > 0) pending.push(new Raw(",")); continue;
                }
                Value part = (Value) item; Object value = part.value();
                if (value instanceof JSONObject) { pending.push(new ObjectCursor((JSONObject) value)); return raw("{"); }
                if (value instanceof JSONArray) { pending.push(new ArrayCursor((JSONArray) value, part.key())); return raw("["); }
                if (value instanceof String) {
                    String string = (String) value, prefix = prefix(string), reference = string.substring(prefix.length());
                    if (binary(part.key(), reference)) return new BinaryInput(prefix, JsonStreams.base64(AttachmentStore.open(context, reference), cancelled));
                    if (text(part.key(), string)) {
                        if (AttachmentStore.size(context, string) > ChatAttachments.DOCUMENT_MAX_BYTES) throw new IOException("Attachment too large");
                        return JsonStreams.quote(AttachmentStore.open(context, string), cancelled);
                    }
                    return JsonStreams.quote(string, cancelled);
                }
                return raw(literal(value));
            }
            return null;
        }
        @Override public void close() throws IOException { closed = true; InputStream input = active; if (input != null) input.close(); }
    }

    private static InputStream raw(String value) { return new ByteArrayInputStream(value.getBytes(StandardCharsets.UTF_8)); }

    private static final class BinaryInput extends InputStream {
        final byte[] prefix;
        final InputStream data;
        int position;
        boolean ended, quoted;
        volatile boolean closed;
        BinaryInput(String prefix, InputStream data) { this.prefix = ("\"" + prefix).getBytes(StandardCharsets.US_ASCII); this.data = data; }
        @Override public int read() throws IOException {
            byte[] single = new byte[1]; return read(single, 0, 1) == -1 ? -1 : single[0] & 255;
        }
        @Override public int read(byte[] bytes, int offset, int length) throws IOException {
            JsonStreams.range(bytes, offset, length);
            if (length == 0) return 0;
            if (closed) throw new IOException("Request body closed");
            if (position < prefix.length) {
                int count = Math.min(length, prefix.length - position);
                System.arraycopy(prefix, position, bytes, offset, count); position += count; return count;
            }
            if (!ended) {
                int count = data.read(bytes, offset, length);
                if (count != -1) return count;
                ended = true;
            }
            if (!quoted) { quoted = true; bytes[offset] = '"'; return 1; }
            return -1;
        }
        @Override public void close() throws IOException { closed = true; data.close(); }
    }

}
