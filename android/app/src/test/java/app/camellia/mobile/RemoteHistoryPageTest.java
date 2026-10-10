package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeMap;
import static org.junit.Assert.*;

public class RemoteHistoryPageTest {
    private JSONObject row(long seq, String role) throws Exception {
        return new JSONObject().put("seq", seq).put("role", role).put("text", "History " + seq);
    }

    private JSONObject page(Long next, JSONObject... rows) throws Exception {
        JSONArray messages = new JSONArray();
        for (JSONObject row : rows) messages.put(row);
        return new JSONObject().put("messages", messages).put("nextBefore", next == null ? JSONObject.NULL : next);
    }

    @Test public void continuesThroughProcessOnlyPagesUntilAChatMessageAppears() throws Exception {
        RemoteHistoryPage history = new RemoteHistoryPage(List.of(10L), 10);
        history.append(page(9L, row(9, "tool")), 10);
        assertTrue(history.needsNext());
        history.append(page(8L, row(8, "assistant")), 9);
        assertFalse(history.needsNext());
        assertEquals(List.of(8L, 9L), new ArrayList<>(history.rows.keySet()));
        assertEquals(Long.valueOf(8), history.nextBefore);
    }

    @Test public void cachedMessagesDoNotCountAsNewMessagesOrConsumeTheRemainingBudget() throws Exception {
        RemoteHistoryPage history = new RemoteHistoryPage(List.of(9L, 10L), 10);
        history.append(page(9L, row(9, "assistant")), 10);
        assertTrue(history.needsNext()); assertTrue(history.rows.isEmpty());
        history.append(page(null, row(8, "user")), 9);
        assertFalse(history.needsNext()); assertEquals(1, history.rows.size());
    }

    @Test public void aFullDisplayWindowCanFetchAndRetainAnEntireEarlierPage() throws Exception {
        TreeMap<Long, JSONObject> cached = new TreeMap<>();
        for (long seq = 401; seq <= 1000; seq++) cached.put(seq, row(seq, "tool"));
        RemoteHistoryPage history = new RemoteHistoryPage(cached.keySet(), 401);
        JSONArray messages = new JSONArray();
        for (long seq = 361; seq <= 400; seq++) messages.put(row(seq, "assistant"));
        history.append(new JSONObject().put("messages", messages).put("nextBefore", 361), 401);
        assertFalse(history.limited()); assertEquals(40, history.rows.size());
        cached.putAll(history.rows);
        RemoteHistoryPage.Window window = RemoteHistoryPage.trim(cached, weight(cached), true);
        assertTrue(window.trimmed); assertEquals(600, cached.size());
        assertEquals(Long.valueOf(361), cached.firstKey()); assertEquals(Long.valueOf(960), cached.lastKey());
        assertEquals(Long.valueOf(361), history.nextBefore);
        assertEquals(weight(cached), window.bytes);
    }

    @Test public void aPartialTerminalPageResumesAtItsUnreadRecords() throws Exception {
        JSONArray incoming = new JSONArray();
        for (long seq = 1; seq <= 700; seq++) incoming.put(row(seq, "tool"));
        RemoteHistoryPage history = new RemoteHistoryPage(List.of(701L), 701);
        history.append(new JSONObject().put("messages", incoming).put("nextBefore", JSONObject.NULL), 701);
        assertTrue(history.limited()); assertFalse(history.needsNext()); assertEquals(600, history.rows.size());
        assertEquals(Long.valueOf(101), history.nextBefore);
        assertEquals(Long.valueOf(101), history.rows.firstKey());
        RemoteHistoryPage next = new RemoteHistoryPage(history.rows.keySet(), history.nextBefore);
        JSONArray remainder = new JSONArray();
        for (long seq = 1; seq <= 100; seq++) remainder.put(row(seq, "tool"));
        next.append(new JSONObject().put("messages", remainder).put("nextBefore", JSONObject.NULL), history.nextBefore);
        assertNull(next.nextBefore); assertEquals(100, next.rows.size());
    }

    @Test public void textAndProcessBudgetBoundsTheBatchWithoutSkippingTheRemainingPage() throws Exception {
        JSONObject older = row(8, "tool").put("process", new JSONArray().put(
            new JSONObject().put("input", "x".repeat(3 * 1024 * 1024))));
        JSONObject newer = row(9, "tool").put("text", "y".repeat(2 * 1024 * 1024));
        RemoteHistoryPage history = new RemoteHistoryPage(List.of(10L), 10);
        history.append(page(null, older, newer), 10);
        assertTrue(history.limited()); assertEquals(List.of(9L), new ArrayList<>(history.rows.keySet()));
        assertEquals(Long.valueOf(9), history.nextBefore);
        TreeMap<Long, JSONObject> cached = new TreeMap<>(); cached.put(10L, older); cached.putAll(history.rows);
        RemoteHistoryPage.Window window = RemoteHistoryPage.trim(cached, weight(cached), true);
        assertEquals(List.of(9L), new ArrayList<>(cached.keySet())); assertTrue(window.bytes <= RemoteHistoryPage.MAX_BYTES);
    }

    @Test public void aSingleOversizedRecordFailsWithoutClosingTheCursor() throws Exception {
        RemoteHistoryPage history = new RemoteHistoryPage(List.of(10L), 10);
        assertThrows(IOException.class, () -> history.append(page(null, row(9, "tool").put("text", "x".repeat((int) RemoteHistoryPage.MAX_BYTES))), 10));
        assertTrue(history.rows.isEmpty()); assertEquals(Long.valueOf(10), history.nextBefore);
    }

    @Test public void rejectsARepeatedOrForwardCursorWithoutPretendingThePageLoaded() throws Exception {
        for (long cursor : new long[]{10, 11, 0}) {
            RemoteHistoryPage history = new RemoteHistoryPage(List.of(10L), 10);
            assertThrows(IOException.class, () -> history.append(page(cursor, row(9, "assistant")), 10));
            assertTrue(history.rows.isEmpty()); assertEquals(Long.valueOf(10), history.nextBefore);
        }
    }

    @Test public void rejectsMissingPagesAndSequencesOutsideTheRequestedWindow() throws Exception {
        RemoteHistoryPage history = new RemoteHistoryPage(List.of(10L), 10);
        assertThrows(IOException.class, () -> history.append(new JSONObject().put("nextBefore", JSONObject.NULL), 10));
        assertThrows(IOException.class, () -> history.append(new JSONObject().put("messages", new JSONArray()), 10));
        assertThrows(IOException.class, () -> history.append(page(null, row(10, "assistant")), 10));
        assertThrows(IOException.class, () -> history.append(page(9L), 10));
    }

    @Test public void anEmptyTerminalPageIsTruthfulAndStopsLoading() throws Exception {
        RemoteHistoryPage history = new RemoteHistoryPage(List.of(10L), 10);
        history.append(page(null), 10);
        assertFalse(history.needsNext()); assertFalse(history.limited()); assertTrue(history.rows.isEmpty());
    }

    @Test public void boundsAutomaticReadsEvenWhenEveryReturnedMessageIsAlreadyCached() throws Exception {
        RemoteHistoryPage history = new RemoteHistoryPage(List.of(2L, 3L, 4L, 5L, 6L, 7L, 8L, 9L, 10L), 11);
        for (long before = 11; before >= 4; before--) history.append(page(before - 1, row(before - 1, "assistant")), before);
        assertFalse(history.needsNext()); assertFalse(history.limited()); assertTrue(history.rows.isEmpty());
        assertEquals(Long.valueOf(3), history.nextBefore);
    }

    @Test public void latestSnapshotsTrimTheOldestEndSoItCanBeFetchedAgain() throws Exception {
        TreeMap<Long, JSONObject> cached = new TreeMap<>();
        for (long seq = 1; seq <= 640; seq++) cached.put(seq, row(seq, "tool"));
        RemoteHistoryPage.Window window = RemoteHistoryPage.trim(cached, weight(cached), false);
        assertTrue(window.trimmed); assertEquals(600, cached.size());
        assertEquals(Long.valueOf(41), cached.firstKey()); assertEquals(Long.valueOf(640), cached.lastKey());
        assertEquals(weight(cached), window.bytes);
    }

    @Test public void aToolHeavyTranscriptCanBeTraversedBeyondTheDisplayBudgetWithoutGaps() throws Exception {
        TreeMap<Long, JSONObject> all = new TreeMap<>(), cached = new TreeMap<>();
        for (long seq = 1; seq <= 3000; seq++) all.put(seq, row(seq, seq % 500 == 0 ? "assistant" : "tool"));
        cached.putAll(all.tailMap(2401L)); Set<Long> seen = new HashSet<>(cached.keySet());
        Long cursor = 2401L; int requests = 0;
        while (cursor != null) {
            long previous = cursor;
            RemoteHistoryPage history = new RemoteHistoryPage(cached.keySet(), cursor);
            do {
                List<JSONObject> source = new ArrayList<>(all.headMap(history.nextBefore).values());
                JSONArray incoming = new JSONArray(source.subList(Math.max(0, source.size() - 200), source.size()));
                Long next = source.size() > 200 ? incoming.getJSONObject(0).getLong("seq") : null;
                history.append(new JSONObject().put("messages", incoming).put("nextBefore", next == null ? JSONObject.NULL : next), history.nextBefore);
                assertTrue(++requests < 40);
            } while (history.needsNext());
            seen.addAll(history.rows.keySet()); cached.putAll(history.rows);
            RemoteHistoryPage.Window window = RemoteHistoryPage.trim(cached, weight(cached), true);
            assertTrue(cached.size() <= 600); assertTrue(window.bytes <= RemoteHistoryPage.MAX_BYTES);
            cursor = history.nextBefore; assertTrue(cursor == null || cursor < previous);
        }
        assertEquals(all.keySet(), seen); assertEquals(Long.valueOf(1), cached.firstKey());
    }

    private long weight(TreeMap<Long, JSONObject> rows) { return rows.values().stream().mapToLong(RemoteHistoryPage::weight).sum(); }
}
