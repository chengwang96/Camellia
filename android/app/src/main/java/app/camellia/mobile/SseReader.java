package app.camellia.mobile;

import java.io.IOException;
import java.io.Reader;

public final class SseReader {
    public interface Listener { void onSnapshot(String data) throws IOException; }
    private static final int LIMIT = 8 * 1024 * 1024;

    public static void read(Reader reader, Listener listener) throws IOException {
        StringBuilder line = new StringBuilder();
        StringBuilder data = new StringBuilder();
        String type = "";
        char[] buffer = new char[8192];
        int count;
        while ((count = reader.read(buffer)) != -1) {
            for (int index = 0; index < count; index++) {
                char character = buffer[index];
                if (character != '\n') {
                    line.append(character);
                    if (line.length() > LIMIT) throw new IOException("Event exceeds the size limit");
                    continue;
                }
                String value = line.toString();
                if (value.endsWith("\r")) value = value.substring(0, value.length() - 1);
                line.setLength(0);
                if (value.isEmpty()) {
                    if (type.equals("snapshot") && data.length() > 0) listener.onSnapshot(data.substring(0, data.length() - 1));
                    data.setLength(0);
                    type = "";
                } else if (value.startsWith("event:")) {
                    type = field(value.substring(6));
                } else if (value.startsWith("data:")) {
                    data.append(field(value.substring(5))).append('\n');
                    if (data.length() > LIMIT) throw new IOException("Event exceeds the size limit");
                }
            }
        }
    }

    private static String field(String value) { return value.startsWith(" ") ? value.substring(1) : value; }
    private SseReader() {}
}
