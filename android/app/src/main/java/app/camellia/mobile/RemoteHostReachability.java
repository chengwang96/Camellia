package app.camellia.mobile;

/**
 * Carries recent evidence that one computer was reachable across a page-scoped
 * stream handoff.
 *
 * A conversation list and an open conversation use separate event streams.
 * Replacing one subscription with the other is not a new computer connection,
 * even though the new stream has not produced its first snapshot yet. The
 * evidence is deliberately short lived, and a different address or token can
 * never inherit it.
 */
final class RemoteHostReachability {
    static final long FRESH_MS = RemoteStreamHealth.IDLE_TIMEOUT_MS;
    private String identity = "";
    private long seenAt;

    synchronized void seen(String address, String token, long now) {
        identity = key(address, token);
        seenAt = now;
    }

    synchronized boolean fresh(String address, String token, long now) {
        String expected = key(address, token);
        return !expected.isEmpty() && expected.equals(identity)
            && now >= seenAt && now - seenAt <= FRESH_MS;
    }

    synchronized void clear() {
        identity = "";
        seenAt = 0;
    }

    private static String key(String address, String token) {
        if (address == null || address.isEmpty() || token == null || token.isEmpty()) return "";
        return address + "\n" + token;
    }
}
