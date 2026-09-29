package app.camellia.mobile;

import android.content.Context;
import android.util.Base64;
import android.util.Base64OutputStream;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;

/** Resolve private file references only in attachment fields, while streaming the request. */
final class AttachmentJson {
    private AttachmentJson() {}

    static void write(Context context, Object value, OutputStream output) throws IOException { write(context, value, output, ""); }

    static long length(Context context, JSONObject value) throws IOException {
        class Counter extends OutputStream {
            long count;
            @Override public void write(int value) { count++; }
            @Override public void write(byte[] bytes, int offset, int length) { count += length; }
        }
        Counter counter = new Counter(); write(context, value, counter); return counter.count;
    }

    private static void raw(OutputStream output, String value) throws IOException { output.write(value.getBytes(StandardCharsets.UTF_8)); }

    private static void write(Context context, Object value, OutputStream output, String key) throws IOException {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value; output.write('{'); boolean first = true;
            java.util.Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String name = keys.next(); if (!first) output.write(','); first = false;
                raw(output, JSONObject.quote(name)); output.write(':'); write(context, object.opt(name), output, name);
            }
            output.write('}');
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value; output.write('[');
            for (int index = 0; index < array.length(); index++) {
                if (index > 0) output.write(','); write(context, array.opt(index), output, key);
            }
            output.write(']');
        } else if (value instanceof String) {
            String text = (String) value, prefix = "", reference = text;
            if (text.startsWith("data:image/jpeg;base64,") || text.startsWith("data:application/pdf;base64,")) {
                int separator = text.indexOf(',') + 1; prefix = text.substring(0, separator); reference = text.substring(separator);
            }
            boolean binaryField = key.equals("data") || key.equals("file_data") || key.equals("url") || key.equals("images") || key.equals("image");
            if (binaryField && reference.startsWith(AttachmentStore.PREFIX) && AttachmentStore.isReference(reference)) {
                output.write('"'); raw(output, prefix);
                try (InputStream input = AttachmentStore.open(context, reference);
                     Base64OutputStream encoded = new Base64OutputStream(output, Base64.NO_WRAP | Base64.NO_CLOSE)) {
                    byte[] buffer = new byte[32 * 1024]; int count;
                    while ((count = input.read(buffer)) != -1) encoded.write(buffer, 0, count);
                }
                output.write('"');
            } else if (key.equals("text") && text.startsWith(AttachmentStore.TEXT_PREFIX) && AttachmentStore.isReference(text)) {
                raw(output, JSONObject.quote(new String(AttachmentStore.read(context, text), StandardCharsets.UTF_8)));
            } else raw(output, JSONObject.quote(text));
        } else raw(output, value == null || value == JSONObject.NULL ? "null" : value.toString());
    }

    static String string(Context context, JSONObject value) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(); write(context, value, output);
        return output.toString(StandardCharsets.UTF_8.name());
    }
}
