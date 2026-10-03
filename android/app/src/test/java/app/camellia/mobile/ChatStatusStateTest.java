package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class ChatStatusStateTest {
    @Test public void unreadFailureSurvivesSnapshotsAndReconnect() {
        ChatStatusState state = new ChatStatusState(); state.work("Ready");
        state.error("Send unconfirmed", false); state.work("Replying");
        state.error("Connection interrupted", true); state.reconnected();
        assertEquals("Send unconfirmed", state.text(10000)); assertTrue(state.isError());
        state.clear(); assertEquals("Replying", state.text(10000)); assertFalse(state.isError());
    }

    @Test public void connectionRecoveryClearsOnlyItsOwnFailure() {
        ChatStatusState state = new ChatStatusState(); state.work("Waiting for sync");
        state.error("Offline", true); state.work("Compacting context");
        assertEquals("Offline", state.text(10000));
        state.reconnected(); assertEquals("Compacting context", state.text(10000));
    }

    @Test public void briefNoticeExpiresWithoutAnIncomingSnapshot() {
        ChatStatusState state = new ChatStatusState(); state.work("Ready");
        state.notice("History loaded", 1000); state.work("Ready");
        assertEquals("History loaded", state.text(3000));
        assertEquals("Ready", state.text(5000));
    }

    @Test public void newWorkReplacesSuccessNoticeButNotError() {
        ChatStatusState state = new ChatStatusState(); state.work("Submitting");
        state.notice("Accepted", 1000); state.work("Waiting for approval");
        assertEquals("Waiting for approval", state.text(1001));
        state.error("Approval not confirmed", false); state.notice("History loaded", 1002);
        state.work("Replying"); assertEquals("Approval not confirmed", state.text(1003));
    }
}
