package app.camellia.mobile;

import org.json.JSONObject;
import org.junit.Test;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

public class ConnectionStabilityCheckTest {
    private static final String FIRST = "12345678-1234-1234-1234-123456789abc", SECOND = "12345678-1234-1234-1234-123456789abd";
    private ConnectionStabilityCheck.State state() { return new ConnectionStabilityCheck.State(ConnectionStabilityCheck.DEFAULT, 0); }
    private JSONObject reply(String id) throws Exception { return new JSONObject().put("protocol", 1).put("instanceId", id); }

    @Test public void healthyRequestsAndQuietDesktopHeartbeatsCompleteWithLatencyAndJitter() throws Exception {
        var state = state(); state.frame(reply(FIRST), 0);
        state.beginRequest(0); state.reply(reply(FIRST), 80);
        state.beginRequest(2000); state.reply(reply(FIRST), 2050);
        state.beginRequest(4000); state.reply(reply(FIRST), 4010);
        state.heartbeat(10000); state.heartbeat(20000); state.inspect(30000);
        var result = state.snapshot(30000);
        assertTrue(result.finished); assertNull(result.issue); assertTrue(result.streamConnected);
        assertEquals(3, result.successes); assertEquals(0, result.failures); assertEquals(2, result.heartbeats);
        assertEquals(10, result.minimum); assertEquals(47, result.average); assertEquals(80, result.maximum); assertEquals(35, result.jitter);
    }
    @Test public void stalledRequestsFailWithoutWaitingForTheUnderlyingSocketTimeoutAndIgnoreLateReplies() throws Exception {
        var state = state(); state.frame(reply(FIRST), 0); state.beginRequest(0); state.inspect(5000);
        assertEquals(ConnectionStabilityCheck.Issue.REQUEST_TIMEOUT, state.issue);
        state.reply(reply(FIRST), 5001);
        assertEquals(0, state.successes); assertEquals(1, state.failures);
    }
    @Test public void successfulHttpDoesNotHideAnUnopenedLiveConnection() throws Exception {
        var state = state(); state.beginRequest(0); state.reply(reply(FIRST), 10); state.inspect(10000);
        assertEquals(ConnectionStabilityCheck.Issue.STREAM_TIMEOUT, state.issue);
    }
    @Test public void silentStreamFailsDespiteSuccessfulRequests() throws Exception {
        var state = state(); state.frame(reply(FIRST), 0); state.heartbeat(10000);
        state.beginRequest(24000); state.reply(reply(FIRST), 24010); state.inspect(25000);
        assertEquals(ConnectionStabilityCheck.Issue.HEARTBEAT_TIMEOUT, state.issue);
    }
    @Test public void serviceChangesAcrossHttpAndStreamStopTheTest() throws Exception {
        var state = state(); state.beginRequest(0); state.reply(reply(FIRST), 10); state.frame(reply(SECOND), 20);
        assertEquals(ConnectionStabilityCheck.Issue.DESKTOP_CHANGED, state.issue);
        var reverse = state(); reverse.frame(reply(FIRST), 0); reverse.beginRequest(0); reverse.reply(reply(SECOND), 10);
        assertEquals(ConnectionStabilityCheck.Issue.DESKTOP_CHANGED, reverse.issue);
    }
    @Test public void aSingleSlowWarmupIsAllowedButRepeatedSlowRequestsAreReported() throws Exception {
        var state = state(); state.frame(reply(FIRST), 0);
        state.beginRequest(0); state.reply(reply(FIRST), 2100);
        state.beginRequest(4000); state.reply(reply(FIRST), 4010); assertNull(state.issue);
        state.beginRequest(6000); state.reply(reply(FIRST), 8100); assertNull(state.issue);
        state.beginRequest(10000); state.reply(reply(FIRST), 12100);
        assertEquals(ConnectionStabilityCheck.Issue.HIGH_LATENCY, state.issue); assertEquals(3, state.slowRequests);
        assertEquals(4, state.successes); assertEquals(0, state.failures);
    }
    @Test public void oldDesktopWithoutServiceStampsStillTestsItsTransport() throws Exception {
        var state = state(); JSONObject value = new JSONObject().put("protocol", 1);
        state.frame(value, 0); state.beginRequest(0); state.reply(value, 10);
        state.beginRequest(2000); state.reply(value, 2010); state.heartbeat(20000); state.inspect(30000);
        assertTrue(state.finished); assertNull(state.issue);
    }
    @Test public void invalidProtocolAndInvalidServiceStampsCannotProduceAHealthyResult() throws Exception {
        var state = state(); state.beginRequest(0); state.reply(new JSONObject().put("protocol", 2), 10);
        assertEquals(ConnectionStabilityCheck.Issue.INVALID_RESPONSE, state.issue);
        var invalid = state(); invalid.frame(reply("not-an-id"), 0);
        assertEquals(ConnectionStabilityCheck.Issue.INVALID_RESPONSE, invalid.issue);
    }
    @Test public void completionWaitsForTheLastRequestAndPreservesTheFirstFailure() throws Exception {
        var state = state(); state.frame(reply(FIRST), 0); state.beginRequest(0); state.reply(reply(FIRST), 10);
        state.heartbeat(28000); state.beginRequest(29500); state.inspect(30000); assertFalse(state.finished);
        state.reply(reply(FIRST), 31000); state.inspect(31000); assertTrue(state.finished); assertNull(state.issue);
        var broken = state(); IOException original = new IOException("original disconnect");
        broken.fail(ConnectionStabilityCheck.Issue.STREAM_ERROR, original);
        broken.fail(ConnectionStabilityCheck.Issue.REQUEST_ERROR, new IOException("later cancel"));
        assertSame(original, broken.error); assertEquals(ConnectionStabilityCheck.Issue.STREAM_ERROR, broken.issue);
    }
    @Test public void cancellingClosesBothWorkersOnceAndDoesNotReportAnError() throws Exception {
        CountDownLatch entered = new CountDownLatch(2), release = new CountDownLatch(1), cleaned = new CountDownLatch(1);
        AtomicInteger closes = new AtomicInteger(), completed = new AtomicInteger();
        var transport = new ConnectionStabilityCheck.Transport() {
            @Override public JSONObject status() throws Exception { entered.countDown(); release.await(); return reply(FIRST); }
            @Override public void events(ConnectionStabilityCheck.Events listener) throws Exception { entered.countDown(); release.await(); }
            @Override public void close() { closes.incrementAndGet(); release.countDown(); cleaned.countDown(); }
        };
        var check = new ConnectionStabilityCheck(transport, ConnectionStabilityCheck.DEFAULT, new ConnectionStabilityCheck.Listener() {
            @Override public void progress(ConnectionStabilityCheck.Snapshot value) { }
            @Override public void complete(ConnectionStabilityCheck.Snapshot value) { completed.incrementAndGet(); }
        });
        try { check.start(); assertTrue(entered.await(3, TimeUnit.SECONDS)); check.close(); check.close();
            assertTrue(cleaned.await(3, TimeUnit.SECONDS)); assertEquals(1, closes.get()); assertEquals(0, completed.get()); }
        finally { check.close(); }
    }
    @Test public void prematureStreamEofAutomaticallyCompletesWithAnErrorAndClosesTheTransport() throws Exception {
        CountDownLatch finished = new CountDownLatch(1), cleaned = new CountDownLatch(1);
        AtomicReference<ConnectionStabilityCheck.Snapshot> result = new AtomicReference<>();
        var transport = new ConnectionStabilityCheck.Transport() {
            @Override public JSONObject status() throws Exception { return reply(FIRST); }
            @Override public void events(ConnectionStabilityCheck.Events listener) { }
            @Override public void close() { cleaned.countDown(); }
        };
        var check = new ConnectionStabilityCheck(transport, ConnectionStabilityCheck.DEFAULT, new ConnectionStabilityCheck.Listener() {
            @Override public void progress(ConnectionStabilityCheck.Snapshot value) { }
            @Override public void complete(ConnectionStabilityCheck.Snapshot value) { result.set(value); finished.countDown(); }
        });
        try { check.start(); assertTrue(finished.await(3, TimeUnit.SECONDS)); assertTrue(cleaned.await(3, TimeUnit.SECONDS));
            assertEquals(ConnectionStabilityCheck.Issue.STREAM_ERROR, result.get().issue); }
        finally { check.close(); }
    }

    @Test public void pathSamplesPreserveChangesWithoutAffectingTheConnectionVerdict() throws Exception {
        var state = state();
        JSONObject direct = new JSONObject().put("path", "direct").put("endpoint", "203.0.113.4:41641").put("latencyMs", 533);
        state.path(direct, 1000);
        var earlier = state.snapshot(1000);
        direct.put("endpoint", "changed");
        state.path(new JSONObject().put("path", "derp").put("derpRegionCode", "sin"), 6000);
        state.path(new JSONObject().put("path", "unreachable"), 11000);
        assertNull(state.issue); assertEquals(0, state.failures);
        assertEquals(1, earlier.paths.size()); assertEquals("203.0.113.4:41641", earlier.paths.get(0).endpoint);
        assertEquals(3, state.snapshot(11000).paths.size());
        assertEquals("derp", state.snapshot(11000).paths.get(1).path);
        state.fail(ConnectionStabilityCheck.Issue.STREAM_ERROR, null);
        state.path(direct, 12000); assertEquals(3, state.snapshot(12000).paths.size());
    }

    @Test public void stalledPathProbeCannotBlockHttpSamplesOrCompletion() throws Exception {
        CountDownLatch pathEntered = new CountDownLatch(1), release = new CountDownLatch(1), done = new CountDownLatch(1);
        AtomicReference<ConnectionStabilityCheck.Snapshot> result = new AtomicReference<>();
        var transport = new ConnectionStabilityCheck.Transport() {
            @Override public JSONObject status() throws Exception { return reply(FIRST); }
            @Override public void events(ConnectionStabilityCheck.Events listener) throws Exception {
                listener.snapshot(reply(FIRST));
                while (!release.await(20, TimeUnit.MILLISECONDS)) listener.heartbeat();
            }
            @Override public JSONObject path() throws Exception {
                pathEntered.countDown(); release.await(); return new JSONObject().put("path", "direct");
            }
            @Override public void close() { release.countDown(); }
        };
        var check = new ConnectionStabilityCheck(transport, new ConnectionStabilityCheck.Config(800, 50, 300, 300, 300, 250), new ConnectionStabilityCheck.Listener() {
            @Override public void progress(ConnectionStabilityCheck.Snapshot value) { }
            @Override public void complete(ConnectionStabilityCheck.Snapshot value) { result.set(value); done.countDown(); }
        });
        try {
            check.start(); assertTrue(pathEntered.await(3, TimeUnit.SECONDS)); assertTrue(done.await(3, TimeUnit.SECONDS));
            assertNull(result.get().issue); assertTrue(result.get().successes >= 4); assertEquals(0, result.get().failures);
            assertTrue("An unfinished probe must not claim a path", result.get().paths.isEmpty());
        } finally { check.close(); release.countDown(); }
    }
}
