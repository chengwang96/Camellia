package app.camellia.mobile;

/** Controls the completion notice without changing the computer's saved goal. */
final class RemoteGoalVisibility {
    private String goalKey = "", previousPhase = "";
    private long completionUserSeq;
    private boolean dismissed;

    void reset() {
        goalKey = ""; previousPhase = ""; completionUserSeq = 0; dismissed = false;
    }

    boolean show(String key, String phase, long completedAt, long latestUserSeq, long latestUserAt) {
        if (phase.isEmpty()) { reset(); return false; }
        if (!goalKey.equals(key)) { reset(); goalKey = key; }
        if (!phase.equals("complete")) {
            previousPhase = phase; dismissed = false;
            return true;
        }
        if (!previousPhase.equals("complete")) {
            completionUserSeq = latestUserSeq;
            // Older desktops do not date completions. Only show one if we
            // observed that goal unfinished here; an old saved completion
            // must not reappear each time the conversation is opened.
            dismissed = completedAt <= 0 && previousPhase.isEmpty();
        }
        previousPhase = phase;
        dismissed |= completedAt > 0 ? latestUserAt > completedAt : latestUserSeq > completionUserSeq;
        return !dismissed;
    }
}
