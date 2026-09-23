package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import java.util.ArrayDeque;
import java.util.ArrayList;

public class RemoteEntryGateTest extends InstrumentationTestCase {
    private final ArrayDeque<Runnable> work = new ArrayDeque<>();
    private final ArrayList<RemoteEntryGate.State> states = new ArrayList<>();
    private RemoteEntryGate gate;
    private RemoteEntryGate.State outcome = RemoteEntryGate.State.CONNECTING;

    private void ui(Runnable action) { getInstrumentation().runOnMainSync(action); getInstrumentation().waitForIdleSync(); }
    private void complete() { work.remove().run(); getInstrumentation().waitForIdleSync(); }

    private void start(long timeout) {
        ui(() -> { gate = new RemoteEntryGate(work::add, () -> outcome, states::add, timeout); gate.start(); });
    }

    @Override protected void tearDown() throws Exception {
        if (gate != null) ui(gate::stop);
        super.tearDown();
    }

    public void testCannotBecomeReadyUntilProbeCompletes() {
        start(30_000);
        assertEquals(RemoteEntryGate.State.CONNECTING, states.get(states.size() - 1));
        outcome = RemoteEntryGate.State.READY; complete();
        assertEquals(RemoteEntryGate.State.READY, states.get(states.size() - 1));
    }

    public void testStopDiscardsLateSuccessAndRestartDoesNotOverlapChecks() {
        start(30_000); ui(gate::stop);
        outcome = RemoteEntryGate.State.READY; complete(); assertEquals(1, states.size());
        ui(gate::start); ui(gate::start); assertEquals(1, work.size());
        complete(); assertEquals(RemoteEntryGate.State.CONNECTING, states.get(states.size() - 1));
        assertEquals(1, work.size()); complete();
        assertEquals(RemoteEntryGate.State.READY, states.get(states.size() - 1));
    }

    public void testTimeoutLoginOfflineAndRetryStates() {
        start(0); complete(); assertEquals(RemoteEntryGate.State.TIMED_OUT, states.get(states.size() - 1));
        ui(gate::stop); outcome = RemoteEntryGate.State.SIGN_IN; start(30_000); complete();
        assertEquals(RemoteEntryGate.State.SIGN_IN, states.get(states.size() - 1));
        outcome = RemoteEntryGate.State.OFFLINE; ui(gate::start); complete();
        assertEquals(RemoteEntryGate.State.OFFLINE, states.get(states.size() - 1));
        outcome = RemoteEntryGate.State.READY; ui(gate::start); complete();
        assertEquals(RemoteEntryGate.State.READY, states.get(states.size() - 1));
    }

    public void testProbeFailureShowsRetryState() {
        ui(() -> { gate = new RemoteEntryGate(work::add, () -> { throw new java.io.IOException("unavailable"); }, states::add); gate.start(); });
        complete(); assertEquals(RemoteEntryGate.State.FAILED, states.get(states.size() - 1));
    }

    public void testHungProbeTimesOutAndCannotEnableEntryAfterDeadline() {
        start(0);
        assertEquals(RemoteEntryGate.State.TIMED_OUT, states.get(states.size() - 1));
        outcome = RemoteEntryGate.State.READY; complete();
        assertEquals(RemoteEntryGate.State.TIMED_OUT, states.get(states.size() - 1));
    }

    public void testHomeEntryBlocksClicksButKeepsLocalAndNetworkSettingsAvailable() throws Exception {
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context);
        boolean embedded = EmbeddedNetwork.enabled(); EmbeddedNetwork.setEnabled(false);
        Activity activity = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            var render = MainActivity.class.getDeclaredMethod("renderRemoteEntry", RemoteEntryGate.State.class); render.setAccessible(true);
            var screen = MainActivity.class.getDeclaredField("screen"); screen.setAccessible(true);
            ui(() -> {
                try {
                    View root = activity.getWindow().getDecorView();
                    for (RemoteEntryGate.State state : RemoteEntryGate.State.values()) {
                        if (state == RemoteEntryGate.State.READY) continue;
                        render.invoke(activity, state);
                        View entry = root.findViewWithTag("remoteControlEntry");
                        assertFalse(entry.isEnabled()); assertFalse(entry.isClickable());
                        entry.performClick(); assertEquals("home", screen.get(activity));
                        assertTrue(root.findViewWithTag("localChatEntry").isEnabled());
                        assertTrue(root.findViewWithTag("settingsEntry").isEnabled());
                        assertNull(root.findViewWithTag("homeNetworkSettings"));
                        boolean retryable = state == RemoteEntryGate.State.FAILED || state == RemoteEntryGate.State.TIMED_OUT
                            || state == RemoteEntryGate.State.OFFLINE;
                        assertEquals(retryable ? View.VISIBLE : View.GONE, root.findViewWithTag("remoteEntryRetry").getVisibility());
                    }
                    render.invoke(activity, RemoteEntryGate.State.READY);
                    assertTrue(root.findViewWithTag("remoteControlEntry").isEnabled());
                    assertEquals(View.GONE, root.findViewWithTag("remoteEntryLoading").getVisibility());
                    render.invoke(activity, RemoteEntryGate.State.SIGN_IN);
                    root.findViewWithTag("settingsEntry").performClick(); assertEquals("settings", screen.get(activity));
                    root.findViewWithTag("settings:network").performClick(); assertEquals("network", screen.get(activity));
                    activity.onBackPressed(); assertEquals("settings", screen.get(activity));
                    activity.onBackPressed(); assertEquals("home", screen.get(activity));
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { ui(activity::finish); EmbeddedNetwork.setEnabled(embedded); }
    }
}
