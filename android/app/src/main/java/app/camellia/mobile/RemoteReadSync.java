package app.camellia.mobile;

/** One active conversation, one in-flight read marker, and the latest desired timestamp. */
final class RemoteReadSync {
    static final class Request {
        final String scope;
        final long at;
        Request(String scope, long at) { this.scope = scope; this.at = at; }
    }

    private String scope;
    private long desired, confirmed, attempted;
    private Request active;

    Request observe(String owner, long replyAt, long readAt) {
        if (!owner.equals(scope)) { reset(); scope = owner; }
        desired = Math.max(desired, replyAt);
        confirmed = Math.max(confirmed, readAt);
        return next();
    }

    Request next() {
        if (active != null || desired <= Math.max(confirmed, attempted)) return null;
        attempted = desired;
        active = new Request(scope, desired);
        return active;
    }

    boolean acknowledge(Request request, long readAt) {
        if (request != active) return false;
        active = null; confirmed = Math.max(confirmed, readAt);
        return true;
    }

    boolean failed(Request request) {
        if (request != active) return false;
        active = null;
        return true;
    }

    void retry() { attempted = confirmed; }
    void reset() { scope = null; desired = confirmed = attempted = 0; active = null; }
}
