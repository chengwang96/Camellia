package app.camellia.mobile;

/** Keeps stream updates separate from notices the user has not read yet. */
final class ChatStatusState {
    private String work = "", notice = "";
    private boolean error, connectionError;
    private long expiresAt;

    void work(String value) {
        if (!work.equals(value) && !error) clear();
        work = value;
    }

    void notice(String value, long now) {
        if (error) return;
        notice = value; expiresAt = now + 4000;
    }

    void error(String value, boolean connection) {
        // A reconnect must not hide an unconfirmed action or a failed send.
        if (error && !connectionError && connection) return;
        notice = value; error = true; connectionError = connection;
    }

    void reconnected() { if (connectionError) clear(); }
    void clear() { notice = ""; error = false; connectionError = false; expiresAt = 0; }
    boolean isError() { return error; }
    String text(long now) {
        if (!error && now >= expiresAt) notice = "";
        return notice.isEmpty() ? work : notice;
    }
}
