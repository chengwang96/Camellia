package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.Collection;
import java.util.HashSet;
import java.util.Set;
import java.util.TreeMap;

/** Collect a bounded batch of older records independently of the current display window. */
final class RemoteHistoryPage {
    static final int MAX_RECORDS = 600;
    static final long MAX_BYTES = 4L * 1024 * 1024;
    private static final int MAX_PAGES = 8;
    final TreeMap<Long, JSONObject> rows = new TreeMap<>();
    private final Set<Long> known;
    private long bytes;
    private int pages, visible;
    private boolean limited;
    Long nextBefore;

    RemoteHistoryPage(Collection<Long> cached, long before) {
        known = new HashSet<>(cached); nextBefore = before;
    }

    void append(JSONObject snapshot, long before) throws IOException {
        JSONArray incoming = snapshot.optJSONArray("messages");
        if (incoming == null || !snapshot.has("nextBefore")) throw new IOException("Invalid earlier-message page");
        Object cursor = snapshot.opt("nextBefore");
        Long next = snapshot.isNull("nextBefore") ? null : cursor instanceof Number ? ((Number) cursor).longValue() : null;
        if (!snapshot.isNull("nextBefore") && (next == null || next <= 0 || next >= before)
                || next != null && incoming.length() == 0) throw new IOException("Earlier-message pagination did not advance");
        // The batch has its own budget. A full display window must still be able
        // to move backwards by replacing its newer end with the requested rows.
        for (int index = incoming.length() - 1; index >= 0; index--) {
            JSONObject row = incoming.optJSONObject(index);
            long seq = row == null ? 0 : row.optLong("seq");
            if (seq <= 0 || seq >= before) throw new IOException("Invalid earlier-message sequence");
            if (known.contains(seq)) continue;
            long weight = weight(row);
            if (weight > MAX_BYTES) throw new IOException("Earlier-message record exceeds the display budget");
            if (atLimit(rows.size(), bytes) || bytes + weight > MAX_BYTES) { limited = true; break; }
            known.add(seq); rows.put(seq, row); bytes += weight;
            if (visible(row)) visible++;
        }
        pages++;
        // A partial page resumes at the earliest admitted row, including when
        // the server said this was the final page. Never skip its unread rows.
        nextBefore = limited ? rows.firstKey() : next;
        if (nextBefore != null && atLimit(rows.size(), bytes)) limited = true;
    }

    boolean needsNext() { return visible == 0 && nextBefore != null && !limited && pages < MAX_PAGES; }
    boolean limited() { return limited; }
    static boolean atLimit(int records, long bytes) { return records >= MAX_RECORDS || bytes >= MAX_BYTES; }
    static boolean visible(JSONObject row) { return Set.of("user", "assistant", "notice").contains(row.optString("role")); }

    static final class Window {
        final long bytes;
        final boolean trimmed;
        Window(long bytes, boolean trimmed) { this.bytes = bytes; this.trimmed = trimmed; }
    }

    static Window trim(TreeMap<Long, JSONObject> rows, long bytes, boolean keepOlder) {
        boolean trimmed = false;
        while (rows.size() > MAX_RECORDS || bytes > MAX_BYTES && rows.size() > 1) {
            JSONObject removed = (keepOlder ? rows.pollLastEntry() : rows.pollFirstEntry()).getValue();
            bytes -= weight(removed); trimmed = true;
        }
        return new Window(Math.max(0, bytes), trimmed);
    }

    static long weight(JSONObject row) {
        long size = 48 + row.optString("text", "").length();
        JSONArray process = row.optJSONArray("process");
        for (int index = 0; process != null && index < process.length(); index++) {
            JSONObject entry = process.optJSONObject(index);
            if (entry != null) size += 32 + entry.optString("text", "").length() + entry.optString("input", "").length();
        }
        return size;
    }
}
