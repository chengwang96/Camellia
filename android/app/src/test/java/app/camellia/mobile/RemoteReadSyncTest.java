package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class RemoteReadSyncTest {
    @Test public void coalescesSnapshotsIntoTheLatestPendingMarker() {
        RemoteReadSync sync = new RemoteReadSync();
        RemoteReadSync.Request first = sync.observe("computer/chat", 100, 0);
        assertEquals(100, first.at);
        assertNull(sync.observe("computer/chat", 100, 0));
        assertNull(sync.observe("computer/chat", 200, 0));
        assertNull(sync.observe("computer/chat", 300, 0));
        assertTrue(sync.acknowledge(first, 100));
        RemoteReadSync.Request latest = sync.next(); assertEquals(300, latest.at);
        assertTrue(sync.acknowledge(latest, 300));
        assertNull(sync.observe("computer/chat", 300, 0));
    }

    @Test public void failureWaitsForRefreshRatherThanEverySnapshot() {
        RemoteReadSync sync = new RemoteReadSync();
        RemoteReadSync.Request request = sync.observe("computer/chat", 100, 0);
        assertTrue(sync.failed(request));
        assertNull(sync.observe("computer/chat", 100, 0));
        sync.retry();
        RemoteReadSync.Request retry = sync.observe("computer/chat", 100, 0);
        assertEquals(request.at, retry.at);
        assertTrue(sync.acknowledge(retry, 100));
        sync.retry(); assertNull(sync.observe("computer/chat", 100, 0));
    }

    @Test public void trustsTheReturnedMarkerWithoutLoopingOnPartialAcknowledgement() {
        RemoteReadSync sync = new RemoteReadSync();
        RemoteReadSync.Request request = sync.observe("computer/chat", 100, 0);
        assertTrue(sync.acknowledge(request, 50));
        assertNull(sync.next());
        sync.retry(); assertEquals(100, sync.observe("computer/chat", 100, 0).at);
    }

    @Test public void anAlreadyReadSnapshotDoesNotNeedAnotherPost() {
        RemoteReadSync sync = new RemoteReadSync();
        assertNull(sync.observe("computer/chat", 100, 100));
        assertNull(sync.observe("computer/chat", 100, 0));
        assertEquals(101, sync.observe("computer/chat", 101, 100).at);
    }

    @Test public void switchingComputerOrConversationRejectsOldAcknowledgements() {
        RemoteReadSync sync = new RemoteReadSync();
        RemoteReadSync.Request old = sync.observe("first/chat", 1000, 0);
        RemoteReadSync.Request current = sync.observe("second/chat", 100, 0);
        assertFalse(sync.acknowledge(old, 1000)); assertFalse(sync.failed(old));
        assertTrue(sync.acknowledge(current, 100));
        assertEquals(200, sync.observe("second/chat", 200, 0).at);
        assertEquals(50, sync.observe("second/another-chat", 50, 0).at);
    }

    @Test public void reconnectInvalidatesEvenAnIdenticalOldRequest() {
        RemoteReadSync sync = new RemoteReadSync();
        RemoteReadSync.Request old = sync.observe("computer/chat", 100, 0);
        sync.reset();
        RemoteReadSync.Request current = sync.observe("computer/chat", 100, 0);
        assertFalse(sync.acknowledge(old, 100));
        assertTrue(sync.acknowledge(current, 100)); assertNull(sync.next());
    }

    @Test public void refreshDuringAnUploadStillKeepsOneRequestInFlight() {
        RemoteReadSync sync = new RemoteReadSync();
        RemoteReadSync.Request request = sync.observe("computer/chat", 100, 0);
        sync.retry(); assertNull(sync.observe("computer/chat", 100, 0));
        assertTrue(sync.acknowledge(request, 100)); assertNull(sync.next());
    }
}
