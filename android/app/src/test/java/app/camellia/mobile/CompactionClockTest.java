package app.camellia.mobile;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class CompactionClockTest {
    private JSONObject progress(long elapsed) throws Exception {
        return new JSONObject().put("state", "running").put("elapsedMs", elapsed);
    }

    @Test public void replayingTheSameSnapshotNeverRewindsTheClock() throws Exception {
        CompactionClock clock = new CompactionClock();
        JSONObject snapshot = progress(0);
        clock.update(snapshot, 10000);
        for (long now = 10250; now <= 15000; now += 250) {
            clock.update(snapshot, now);
            assertEquals(now - 10000, clock.elapsed(now));
        }
        assertEquals(6000, clock.elapsed(16000));
    }

    @Test public void oldReportsCannotEraseLocalTimeButNewerHostTimeCanAdvanceIt() throws Exception {
        CompactionClock clock = new CompactionClock();
        clock.update(progress(95000), 10000);
        clock.update(progress(90000), 12000);
        assertEquals(97000, clock.elapsed(12000));
        clock.update(progress(100000), 13000);
        assertEquals(101000, clock.elapsed(14000));
    }

    @Test public void stageAndChunkChangesWithoutTimingKeepTheSameClock() throws Exception {
        CompactionClock clock = new CompactionClock();
        JSONObject snapshot = new JSONObject().put("state", "running");
        clock.update(snapshot, 10000);
        clock.update(snapshot.put("stage", "summarizing").put("chunk", 2), 12000);
        clock.update(snapshot.put("summaryPhase", "reduce"), 14000);
        clock.update(snapshot.put("stage", "saving"), 16000);
        assertEquals(6500, clock.elapsed(16500));
    }

    @Test public void completionUsesTheFinalHostDurationAndStopsTicking() throws Exception {
        for (String state : new String[] {"completed", "failed", "cancelled"}) {
            CompactionClock clock = new CompactionClock();
            clock.update(progress(95000), 10000);
            JSONObject terminal = new JSONObject().put("state", state).put("durationMs", 42000);
            clock.update(terminal, 12000);
            assertEquals(42000, clock.elapsed(30000));
            clock.update(terminal, 40000);
            assertEquals(42000, clock.elapsed(50000));
        }
    }

    @Test public void terminalWithoutTimingFreezesTheAccruedTime() throws Exception {
        CompactionClock clock = new CompactionClock();
        clock.update(progress(0), 10000);
        clock.update(new JSONObject().put("state", "cancelled").put("elapsedMs", 0), 12500);
        assertEquals(2500, clock.elapsed(30000));
        assertEquals(-1, new CompactionClock().elapsed(30000));
        CompactionClock history = new CompactionClock();
        history.update(new JSONObject().put("state", "completed"), 10000);
        assertEquals(-1, history.elapsed(30000));
    }

    @Test public void aLaterRunStartsFreshAfterThePreviousOneEnds() throws Exception {
        CompactionClock clock = new CompactionClock();
        clock.update(progress(95000), 10000);
        clock.update(new JSONObject().put("state", "completed").put("durationMs", 96000), 11000);
        clock.update(progress(0), 12000);
        assertEquals(1000, clock.elapsed(13000));
    }

    @Test public void aNewStartOrBoundaryResetsEvenIfTheTerminalSnapshotWasMissed() throws Exception {
        for (String identity : new String[] {"startedAt", "afterSeq"}) {
            CompactionClock clock = new CompactionClock();
            clock.update(progress(95000).put(identity, 1), 10000);
            clock.update(progress(0).put(identity, 2), 12000);
            assertEquals(1000, clock.elapsed(13000));
        }
    }

    @Test public void optionalHostIdentityDoesNotRequireMatchingDeviceWallTime() throws Exception {
        CompactionClock clock = new CompactionClock();
        clock.update(progress(0), 10000);
        clock.update(progress(0).put("startedAt", 1793910000000L).put("afterSeq", 10), 12000);
        clock.update(progress(0), 14000);
        assertEquals(5000, clock.elapsed(15000));
    }
}
