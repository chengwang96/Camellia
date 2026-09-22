package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import org.json.JSONObject;

public class PageTransitionsTest extends InstrumentationTestCase {
    private CredentialStore encrypted;

    @Override protected void setUp() throws Exception {
        super.setUp();
        encrypted = new CredentialStore(getInstrumentation().getTargetContext()); encrypted.clear();
        EmbeddedNetwork.initialize(getInstrumentation().getTargetContext()); EmbeddedNetwork.setEnabled(false);
    }

    @Override protected void tearDown() throws Exception { encrypted.clear(); super.tearDown(); }

    public void testNetworkPushPopAndSamePageRefresh() {
        MainActivity activity = launch();
        try {
            getInstrumentation().runOnMainSync(() -> {
                PageTransitions pages = pages(activity);
                assertEquals(1, pages.getChildCount());
                invoke(activity, "settingsScreen");
                invoke(activity, "showNetwork"); invoke(activity, "stopNetwork");
                assertPush(pages);
                invoke(activity, "showNetwork"); invoke(activity, "stopNetwork");
                assertEquals(1, pages.getChildCount());
                assertEquals(0f, pages.getChildAt(0).getTranslationX());
                activity.onBackPressed(); invoke(activity, "stopNetwork");
                assertPop(pages);
            });
            awaitSettled(activity);
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testComputerAndRapidBackThroughConversation() throws Exception {
        JSONObject computer = new JSONObject().put("address", "http://100.80.1.2:43127")
            .put("token", "a".repeat(43)).put("deviceId", "animation-test");
        new ComputerStore(encrypted).save(computer);
        MainActivity activity = launch();
        try {
            getInstrumentation().runOnMainSync(() -> {
                PageTransitions pages = pages(activity);
                activity.getWindow().getDecorView().findViewWithTag("remoteControlEntry").performClick();
                activity.getWindow().getDecorView().findViewWithTag("computer:" + computer.optString("address")).performClick();
                invoke(activity, "stopNetwork"); assertPush(pages);
                invoke(activity, "detailScreen"); assertPush(pages);
                activity.onBackPressed(); invoke(activity, "stopNetwork"); assertPop(pages);
                activity.onBackPressed(); invoke(activity, "stopNetwork"); assertPop(pages);
            });
            awaitSettled(activity);
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testPairNetworkReturnsToPairWithPop() {
        MainActivity activity = launch();
        try {
            getInstrumentation().runOnMainSync(() -> {
                invoke(activity, "pairScreen"); assertPush(pages(activity));
                invoke(activity, "showNetwork"); invoke(activity, "stopNetwork"); assertPush(pages(activity));
                activity.onBackPressed(); invoke(activity, "stopNetwork"); assertPop(pages(activity));
            });
            awaitSettled(activity);
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testLocalChatEntryAndReturn() {
        MainActivity activity = launch();
        var monitor = getInstrumentation().addMonitor(LocalChatActivity.class.getName(), null, false);
        Activity local = null;
        try {
            getInstrumentation().runOnMainSync(() -> activity.getWindow().getDecorView().findViewWithTag("localChatEntry").performClick());
            local = monitor.waitForActivityWithTimeout(5000);
            assertNotNull(local);
            getInstrumentation().waitForIdleSync();
            Activity opened = local;
            getInstrumentation().runOnMainSync(() -> {
                assertEquals(1, pages(opened).getChildCount());
                opened.getWindow().getDecorView().findViewWithTag("localBack").performClick();
            });
            android.os.SystemClock.sleep(600);
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> assertTrue(opened.isFinishing()));
        } finally {
            getInstrumentation().removeMonitor(monitor);
            if (local != null) getInstrumentation().runOnMainSync(local::finish);
            getInstrumentation().runOnMainSync(activity::finish);
        }
    }

    private MainActivity launch() {
        MainActivity activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(
            getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().waitForIdleSync();
        return activity;
    }

    private PageTransitions pages(Activity activity) { return activity.getWindow().getDecorView().findViewWithTag("pageTransitions"); }

    private void assertPush(PageTransitions pages) {
        if (!android.animation.ValueAnimator.areAnimatorsEnabled()) {
            assertEquals(1, pages.getChildCount());
            assertEquals(0f, pages.getChildAt(0).getTranslationX());
            return;
        }
        assertEquals(2, pages.getChildCount());
        assertEquals((float) pages.getWidth(), pages.getChildAt(1).getTranslationX());
    }

    private void assertPop(PageTransitions pages) {
        if (!android.animation.ValueAnimator.areAnimatorsEnabled()) {
            assertEquals(1, pages.getChildCount());
            assertEquals(0f, pages.getChildAt(0).getTranslationX());
            return;
        }
        assertEquals(2, pages.getChildCount());
        assertEquals(-pages.getWidth() * 0.3f, pages.getChildAt(0).getTranslationX());
    }

    private void awaitSettled(Activity activity) {
        android.os.SystemClock.sleep(600);
        getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            PageTransitions pages = pages(activity);
            assertEquals(1, pages.getChildCount());
            View current = pages.getChildAt(0);
            assertEquals(0f, current.getTranslationX());
            assertTrue(current.getWidth() > 0);
        });
    }

    private void invoke(Activity activity, String name) {
        try {
            var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity);
        } catch (Exception error) { throw new AssertionError(error); }
    }
}
