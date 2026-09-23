package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class NetworkRouteTest {
    @Test public void wifiToCellularIgnoresLateWifiCallbacks() {
        NetworkRoute route = new NetworkRoute("wifi", "wifi-links");
        assertTrue(route.available("cellular"));
        assertTrue(route.links("cellular", "cellular-links"));
        long revision = route.revision();
        assertFalse(route.lost("wifi"));
        assertFalse(route.links("wifi", "stale-links"));
        assertEquals(revision, route.revision());
        assertTrue(route.online());
    }

    @Test public void offlineThenCellularAndWifiReturn() {
        NetworkRoute route = new NetworkRoute("wifi", "links");
        assertTrue(route.lost("wifi"));
        assertFalse(route.online());
        assertFalse(route.lost("wifi"));
        assertTrue(route.available("cellular"));
        assertTrue(route.online());
        assertTrue(route.available("wifi"));
        assertFalse(route.lost("cellular"));
        assertTrue(route.online());
    }

    @Test public void unchangedCallbacksDoNotRestartAndRouteChangesDo() {
        NetworkRoute route = new NetworkRoute("wifi", "links");
        assertFalse(route.available("wifi"));
        assertFalse(route.links("wifi", "links"));
        assertEquals(0, route.revision());
        assertTrue(route.links("wifi", "new-ip-or-dns"));
        assertEquals(1, route.revision());
        assertTrue(route.available(null));
        assertFalse(route.online());
        assertFalse(route.available(null));
    }
}
