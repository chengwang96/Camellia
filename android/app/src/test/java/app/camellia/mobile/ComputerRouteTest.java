package app.camellia.mobile;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class ComputerRouteTest {
    private JSONObject probe(String path) throws Exception { return new JSONObject().put("path", path); }

    @Test public void labelsTheThreeRealPathsWithoutClaimingConnectivity() throws Exception {
        assertEquals("直连 · 点对点", ComputerRoute.label(probe("direct"), true));
        assertEquals("VPS 中继 · Peer Relay", ComputerRoute.label(probe("peer-relay"), true));
        assertEquals("Public relay · DERP LAX",
            ComputerRoute.label(probe("derp").put("derpRegionCode", "lax"), false));
        assertEquals("公网中继 · DERP", ComputerRoute.label(probe("derp"), true));
    }

    @Test public void unknownAndFailedProbesDoNotRenderAStalePath() throws Exception {
        assertEquals("路径未知", ComputerRoute.label(probe("unknown"), true));
        assertEquals("", ComputerRoute.label(probe("unreachable"), true));
        assertEquals("", ComputerRoute.label(null, true));
        assertEquals("", ComputerRoute.label(new JSONObject(), false));
    }

    @Test public void reportEvidenceKeepsTheActualEndpointAndDoesNotInferAPathFromLatency() throws Exception {
        var sample = new ComputerRoute.Sample(2500,
            probe("direct").put("endpoint", "203.0.113.4:41641").put("latencyMs", 533));
        assertEquals("+2.5s · 直连 · 点对点 · 203.0.113.4:41641 · 533.0 ms", ComputerRoute.evidence(sample, true));
        String unknown = ComputerRoute.evidence(new ComputerRoute.Sample(10, probe("unreachable")), true);
        assertTrue(unknown, unknown.contains("路径未确认"));
        assertFalse(unknown.contains("直连")); assertFalse(unknown.contains("中继"));
    }
}
