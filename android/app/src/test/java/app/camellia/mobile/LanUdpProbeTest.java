package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class LanUdpProbeTest {
    @Test public void parsesDirectBroadcastReply() {
        String fingerprint = "6e7a27fc91ed101a70913d3a1bb84972535b912edebdc47a4fe620ae8abcebb0";
        String payload = "{\"v\":1,\"id\":\"c9ab3075-393e-478b-a4d5-7a92247579f9\","
            + "\"name\":\"HP\",\"ip\":\"192.168.3.59\",\"port\":4194,\"fp\":\"" + fingerprint + "\",\"join\":1}";
        LanMdnsProbe.Result result = LanUdpProbe.parse(payload);
        assertEquals("c9ab3075-393e-478b-a4d5-7a92247579f9", result.computerId);
        assertEquals("HP", result.name);
        assertEquals("192.168.3.59", result.address);
        assertEquals(4194, result.port);
        assertEquals(fingerprint, result.fingerprint);
        assertTrue(result.joinable);
    }

    @Test public void rejectsMalformedOrUnsafeReplies() {
        assertNull(LanUdpProbe.parse("not json"));
        assertNull(LanUdpProbe.parse("{\"v\":1,\"id\":\"x\",\"ip\":\"8.8.8.8\","
            + "\"port\":4194,\"fp\":\"" + "a".repeat(64) + "\"}"));
        assertNull(LanUdpProbe.parse("{\"v\":2,\"id\":\"x\",\"ip\":\"192.168.3.59\","
            + "\"port\":4194,\"fp\":\"" + "a".repeat(64) + "\"}"));
    }
}
