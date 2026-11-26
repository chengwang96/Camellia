package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class RemoteHostReachabilityTest {
    private static final String ADDRESS = "http://100.80.1.2:43127";
    private static final String TOKEN = "a".repeat(43);

    @Test public void quickPageHandoffKeepsTheSameComputerReachable() {
        var reachability = new RemoteHostReachability();
        reachability.seen(ADDRESS, TOKEN, 1_000);
        assertTrue(reachability.fresh(ADDRESS, TOKEN, 1_001));
        assertTrue(reachability.fresh(ADDRESS, TOKEN, 1_000 + RemoteHostReachability.FRESH_MS));
    }

    @Test public void staleEvidenceDoesNotHideARealReconnect() {
        var reachability = new RemoteHostReachability();
        reachability.seen(ADDRESS, TOKEN, 1_000);
        assertFalse(reachability.fresh(ADDRESS, TOKEN, 1_001 + RemoteHostReachability.FRESH_MS));
    }

    @Test public void anotherComputerOrRepairedTokenCannotInheritTheConnection() {
        var reachability = new RemoteHostReachability();
        reachability.seen(ADDRESS, TOKEN, 1_000);
        assertFalse(reachability.fresh("http://100.80.1.3:43127", TOKEN, 1_001));
        assertFalse(reachability.fresh(ADDRESS, "b".repeat(43), 1_001));
        assertFalse(reachability.fresh("", "", 1_001));
    }

    @Test public void anActualFailureClearsTheHandoff() {
        var reachability = new RemoteHostReachability();
        reachability.seen(ADDRESS, TOKEN, 1_000);
        reachability.clear();
        assertFalse(reachability.fresh(ADDRESS, TOKEN, 1_001));
    }
}
