package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class RemoteHistoryLoadTest {
    @Test public void fastPagesExpandTheSmallProbeToThirtyVisibleMessages() {
        RemoteHistoryLoad load = new RemoteHistoryLoad();
        assertTrue(load.shouldLoad(1, 200, 1024, true));
        assertEquals(7, load.remainingMessages(1));
        load.received(120);
        assertEquals(22, load.remainingMessages(8));
        assertTrue(load.shouldLoad(29, 500, 1024, true));
        assertFalse(load.shouldLoad(30, 500, 1024, true));
    }

    @Test public void normalPagesStopAtTwelveAndSlowPagesDoNotKeepDownloading() {
        RemoteHistoryLoad load = new RemoteHistoryLoad();
        load.received(1100);
        assertEquals(4, load.remainingMessages(8));
        assertTrue(load.shouldLoad(11, 200, 1024, true));
        assertFalse(load.shouldLoad(12, 200, 1024, true));
        load.received(2100);
        assertFalse(load.shouldLoad(1, 200, 1024, true));
    }

    @Test public void laterLatencySpikesReduceTheTargetAndCannotBeErasedByTinyPages() {
        RemoteHistoryLoad load = new RemoteHistoryLoad();
        load.received(20); load.received(1200); load.received(10);
        assertFalse(load.shouldLoad(12, 200, 1024, true));
    }

    @Test public void processOnlyPagesAreBoundedByRequestsAndElapsedTime() {
        RemoteHistoryLoad load = new RemoteHistoryLoad();
        for (int page = 0; page < RemoteHistoryLoad.MAX_PAGES; page++) {
            assertTrue(load.shouldLoad(1, 200, 1024, true));
            load.received(10);
        }
        assertFalse(load.shouldLoad(1, 200, 1024, true));
        load = new RemoteHistoryLoad();
        for (int page = 0; page < 5; page++) load.received(1200);
        assertFalse(load.shouldLoad(1, 200, 1024, true));
    }

    @Test public void neverExceedsTheDisplayWindowOrRestartsAfterFailureOrManualLoading() {
        RemoteHistoryLoad load = new RemoteHistoryLoad();
        assertFalse(load.shouldLoad(1, 600, 1, true));
        assertFalse(load.shouldLoad(1, 20, RemoteHistoryPage.MAX_BYTES, true));
        assertFalse(load.shouldLoad(1, 20, 1, false));
        assertTrue(load.shouldLoad(1, 20, 1, true));
        load.stop();
        assertFalse(load.shouldLoad(1, 20, 1, true));
    }
}
