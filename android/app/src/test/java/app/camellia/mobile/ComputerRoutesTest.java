package app.camellia.mobile;

import org.json.JSONObject;
import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

public class ComputerRoutesTest {
    private static final String FP = "a".repeat(64);

    @Test public void resolvesLanAndTailscaleUnderOneStableComputerKey() {
        try {
            String tail = "http://100.80.1.2:43127";
            JSONObject computer = new JSONObject().put("address", tail)
                .put("token", "x".repeat(43))
                .put("lanAddress", "https://192.168.1.8:43127")
                .put("lanFingerprint", FP)
                .put("activeTransport", ComputerRoutes.TAILSCALE);
            ComputerRoutes.configure(List.of(computer));
            assertEquals(tail, ComputerRoutes.route(tail).url);
            assertEquals(ComputerRoutes.TAILSCALE, ComputerRoutes.activeTransport(tail));
            computer.put("activeTransport", ComputerRoutes.LAN);
            ComputerRoutes.configure(List.of(computer));
            assertEquals("https://192.168.1.8:43127", ComputerRoutes.route(tail).url);
            assertEquals(FP, ComputerRoutes.route(tail).fingerprint);
            assertEquals(ComputerRoutes.LAN, ComputerRoutes.route("https://192.168.1.8:43127").transport);
        } catch (Exception error) {
            fail(error.toString());
        }
    }

    @Test public void rejectsInvalidPinsAndFingerprints() {
        assertTrue(LanTls.validFingerprint(FP));
        assertFalse(LanTls.validFingerprint("abc"));
        assertThrows(IllegalArgumentException.class, () -> LanTls.normalize("not-a-fingerprint"));
    }

    @Test public void keepsAStableLanKeyAfterAddingTailscaleLater() {
        try {
            String lan = "https://192.168.3.59:4194";
            String tail = "http://100.80.1.2:43127";
            JSONObject computer = new JSONObject().put("address", lan)
                .put("token", "x".repeat(43))
                .put("lanAddress", lan)
                .put("lanFingerprint", FP)
                .put("tailscaleAddress", tail)
                .put("activeTransport", ComputerRoutes.TAILSCALE);
            ComputerRoutes.configure(List.of(computer));
            assertEquals(tail, ComputerRoutes.route(lan).url);
            assertEquals(ComputerRoutes.TAILSCALE, ComputerRoutes.route(lan).transport);
            assertEquals(lan, ComputerRoutes.lanUrl(lan));
            assertEquals(FP, ComputerRoutes.lanFingerprint(lan));
        } catch (Exception error) {
            fail(error.toString());
        }
    }

    @Test public void keepsASingleRouteForLanOnlyTailscaleOnlyAndDualTransportProfiles() {
        try {
            String tail = "http://100.80.1.2:43127";
            String lan = "https://192.168.3.59:4194";
            String dualLan = "https://192.168.3.60:4194";
            ComputerRoutes.configure(List.of(
                new JSONObject().put("address", tail).put("token", "a".repeat(43)),
                new JSONObject().put("address", lan).put("token", "b".repeat(43))
                    .put("lanFingerprint", FP).put("activeTransport", ComputerRoutes.LAN),
                new JSONObject().put("address", dualLan).put("token", "c".repeat(43))
                    .put("tailscaleAddress", tail).put("lanAddress", dualLan).put("lanFingerprint", FP)
                    .put("activeTransport", ComputerRoutes.LAN)
            ));
            assertEquals(ComputerRoutes.TAILSCALE, ComputerRoutes.route(tail).transport);
            assertEquals(ComputerRoutes.LAN, ComputerRoutes.route(lan).transport);
            assertEquals(ComputerRoutes.LAN, ComputerRoutes.route(dualLan).transport);
        } catch (Exception error) {
            fail(error.toString());
        }
    }

    @Test public void preservesLegacyLanPreferenceUntilTheUserChangesIt() throws Exception {
        String tail = "http://100.80.1.2:43127";
        String lan = "https://192.168.1.8:43127";
        JSONObject computer = new JSONObject().put("address", tail).put("token", "x".repeat(43))
            .put("lanAddress", lan).put("lanFingerprint", FP);
        assertFalse(ComputerRoutes.prefersLan(computer));
        computer.put("autoLan", true);
        assertTrue(ComputerRoutes.prefersLan(computer));
        computer.put("autoLan", false).put("lanPaired", true).put("activeTransport", ComputerRoutes.LAN);
        assertTrue(ComputerRoutes.prefersLan(computer));
        ComputerRoutes.configure(List.of(computer));
        assertEquals(lan, ComputerRoutes.route(tail).url);

        computer.put("lanPreferred", false);
        ComputerRoutes.configure(List.of(computer));
        assertFalse(ComputerRoutes.prefersLan(computer));
        assertEquals(tail, ComputerRoutes.route(tail).url);

        computer.put("address", lan);
        assertTrue(ComputerRoutes.prefersLan(computer));
        ComputerRoutes.configure(List.of(computer));
        assertEquals(lan, ComputerRoutes.route(lan).url);
    }

    @Test public void checksBothIdentityAndFingerprintBeforeReusingLocalTrust() throws Exception {
        JSONObject computer = new JSONObject().put("computerId", "desktop").put("lanFingerprint", FP);
        assertTrue(ComputerRoutes.matchesLanFingerprint(computer, "desktop", "A".repeat(64)));
        assertFalse(ComputerRoutes.matchesLanFingerprint(computer, "another-desktop", FP));
        assertFalse(ComputerRoutes.matchesLanFingerprint(computer, "desktop", "b".repeat(64)));
        assertFalse(ComputerRoutes.matchesLanFingerprint(computer, "desktop", ""));
    }

    @Test public void usesNewTailscaleRouteWhenTheLanOnlyComputerIsAwayFromItsNetwork() throws Exception {
        String lan = "https://192.168.1.8:43127", tail = "http://100.80.1.2:43127";
        JSONObject computer = new JSONObject().put("address", lan).put("token", "x".repeat(43))
            .put("lanAddress", lan).put("lanFingerprint", FP).put("activeTransport", ComputerRoutes.LAN);
        assertFalse(ComputerRoutes.updateDiscoveredRoute(computer, null));
        computer.put("tailscaleAddress", tail);
        assertTrue(ComputerRoutes.updateDiscoveredRoute(computer, null));
        assertTrue(ComputerRoutes.prefersLan(computer));
        ComputerRoutes.configure(List.of(computer));
        assertEquals(tail, ComputerRoutes.route(lan).url);
    }
}
