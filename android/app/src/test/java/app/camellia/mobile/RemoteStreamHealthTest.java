package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class RemoteStreamHealthTest {
    @Test public void initialDeadlineDoesNotMoveBeforeAUsableSnapshot() {
        var health = new RemoteStreamHealth(1000);
        health.heartbeat(20_000); health.heartbeat(30_000);
        assertFalse(health.synced());
        assertEquals(1, health.remaining(30_999));
        assertEquals(0, health.remaining(31_000));
    }

    @Test public void quietConversationsRemainHealthyWithHeartbeats() {
        var health = new RemoteStreamHealth(0);
        health.snapshot(100);
        for (long now = 10_000; now <= 120_000; now += 10_000) {
            health.heartbeat(now);
            assertTrue(health.synced());
            assertEquals(RemoteStreamHealth.IDLE_TIMEOUT_MS, health.remaining(now));
        }
    }

    @Test public void liveSnapshotsAlsoKeepTheStreamAlive() {
        var health = new RemoteStreamHealth(0);
        health.snapshot(29_999); health.snapshot(60_000);
        assertEquals(1, health.remaining(94_999));
        assertEquals(0, health.remaining(95_000));
    }

    @Test public void foregroundInspectionDetectsTimeSpentAsleep() {
        var health = new RemoteStreamHealth(0);
        health.snapshot(100); health.heartbeat(10_000);
        assertEquals(0, health.remaining(300_000));
    }

    @Test public void foregroundReuseRequiresARecentUsableFrame() {
        var health = new RemoteStreamHealth(0);
        health.heartbeat(100);
        assertFalse(health.fresh(100, 5_000));
        health.snapshot(100);
        assertTrue(health.fresh(5_100, 5_000));
        assertFalse(health.fresh(5_101, 5_000));
        health.heartbeat(5_200);
        assertTrue(health.fresh(10_200, 5_000));
    }

    @Test public void foregroundRecoveryCanUseAShortInitialDeadline() {
        var health = new RemoteStreamHealth(1_000, RemoteStreamHealth.RECOVERY_INITIAL_TIMEOUT_MS);
        health.heartbeat(20_000);
        assertEquals(1, health.remaining(8_999));
        assertEquals(0, health.remaining(9_000));
        assertEquals(30_000, new RemoteStreamHealth(1_000).remaining(1_000));
    }
}
