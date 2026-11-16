package app.camellia.mobile;

import org.json.JSONObject;

/** Presentation for the phone-to-computer transport path; never a connection verdict. */
final class ComputerRoute {
    private ComputerRoute() {}

    static String label(JSONObject probe, boolean chinese) {
        return label(probe == null ? "" : probe.optString("path"),
            probe == null ? "" : probe.optString("derpRegionCode"), chinese);
    }

    private static String label(String path, String regionCode, boolean chinese) {
        switch (path) {
            case "direct": return chinese ? "直连 · 点对点" : "Direct · peer-to-peer";
            case "peer-relay": return chinese ? "VPS 中继 · Peer Relay" : "VPS relay · Peer Relay";
            case "derp": {
                String region = regionCode.trim().toUpperCase(java.util.Locale.ROOT);
                String base = chinese ? "公网中继 · DERP" : "Public relay · DERP";
                return region.isEmpty() ? base : base + " " + region;
            }
            case "unknown": return chinese ? "路径未知" : "Path unknown";
            default: return "";
        }
    }

    /** Immutable evidence from one phone-to-target discovery ping, not an HTTP timing inference. */
    static final class Sample {
        final long elapsed;
        final String path, endpoint, peerRelay, region;
        final double latency;
        Sample(long elapsed, JSONObject probe) {
            this.elapsed = elapsed;
            path = probe.optString("path"); endpoint = probe.optString("endpoint");
            peerRelay = probe.optString("peerRelay"); region = probe.optString("derpRegionCode");
            latency = probe.optDouble("latencyMs", -1);
        }
    }

    static String evidence(Sample sample, boolean chinese) {
        String label = label(sample.path, sample.region, chinese);
        if (label.isEmpty()) label = chinese ? "路径未确认" : "Path unconfirmed";
        String endpoint = sample.path.equals("direct") ? sample.endpoint : sample.path.equals("peer-relay") ? sample.peerRelay : "";
        return String.format(java.util.Locale.ROOT, "+%.1fs · %s", sample.elapsed / 1000.0, label)
            + (endpoint.isEmpty() ? "" : " · " + endpoint)
            + (Double.isFinite(sample.latency) && sample.latency >= 0
                ? String.format(java.util.Locale.ROOT, " · %.1f ms", sample.latency) : "");
    }
}
