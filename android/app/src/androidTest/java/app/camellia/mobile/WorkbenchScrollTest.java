package app.camellia.mobile;

import android.content.Intent;
import android.os.SystemClock;
import android.test.InstrumentationTestCase;
import android.view.MotionEvent;
import android.view.View;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public class WorkbenchScrollTest extends InstrumentationTestCase {
    private MainActivity activity;
    private JSONObject credentials;
    private JSONArray rows;
    private RemoteWorkbenchSync sync;
    private RemoteApi.SnapshotListener listener;
    private final java.util.concurrent.atomic.AtomicInteger subscriptions = new java.util.concurrent.atomic.AtomicInteger();

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context);
        EmbeddedNetwork.setEnabled(false);
        new CredentialStore(context).clear();
        credentials = new JSONObject().put("address", "http://100.80.1.8:43127")
            .put("token", "s".repeat(43)).put("computerName", "Workbench scroll fixture");
        rows = new JSONArray();
        long at = System.currentTimeMillis() - 90_000;
        for (int index = 0; index < 35; index++) rows.put(new JSONObject()
            .put("id", "scroll-" + index).put("title", "Work " + index)
            .put("engine", "codex").put("activity", "running").put("updatedAt", at).put("lastReplyAt", 0).put("replyReadAt", 0));
        RemoteListCache.workbench(context).remove(credentials);
        RemoteListCache.get(context).put(credentials, rows, -1, new JSONArray(), true);
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        CountDownLatch opened = new CountDownLatch(1);
        sync = new RemoteWorkbenchSync(address -> new RemoteApi(address) {
            final CountDownLatch closed = new CountDownLatch(1);
            @Override void workbenchEvents(String token, SnapshotListener callback, SseReader.HeartbeatListener heartbeat) throws java.io.IOException {
                subscriptions.incrementAndGet();
                listener = callback;
                try { callback.onSnapshot(new JSONObject().put("workbench", new JSONObject().put("conversations", rows))); }
                catch (Exception error) { throw new java.io.IOException(error); }
                opened.countDown();
                try { closed.await(); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            }
            @Override public void cancel() { closed.countDown(); }
        });
        main(() -> {
            ((RemoteWorkbenchSync) field("homeSync")).close();
            field("homeSync", sync);
            field("credentials", credentials);
            field("foreground", false);
            field("homeRunningExpanded", true);
            invoke("homeScreen");
            field("foreground", true);
            invoke("refreshHomeConversations");
        });
        assertTrue(opened.await(3, TimeUnit.SECONDS));
        getInstrumentation().waitForIdleSync();
    }

    @Override protected void tearDown() throws Exception {
        if (sync != null) sync.close();
        if (activity != null) getInstrumentation().runOnMainSync(activity::finish);
        getInstrumentation().waitForIdleSync();
        var context = getInstrumentation().getTargetContext();
        RemoteListCache.get(context).remove(credentials);
        RemoteListCache.workbench(context).remove(credentials);
        new CredentialStore(context).clear();
        super.tearDown();
    }

    public void testInvisiblePushBurstKeepsPageAndCardsAttached() throws Exception {
        View[] original = new View[6];
        String[] tags = {"workbenchNav", "homeConversations", "homeActive:http://100.80.1.8:43127#scroll-0",
            "homeActive:http://100.80.1.8:43127#scroll-2", "homeShortcuts", "homeRunningSection"};
        main(() -> { for (int i = 0; i < tags.length; i++) original[i] = view(tags[i]); });
        int[] detached = {0};
        main(() -> original[2].addOnAttachStateChangeListener(new View.OnAttachStateChangeListener() {
            public void onViewAttachedToWindow(View view) {}
            public void onViewDetachedFromWindow(View view) { detached[0]++; }
        }));
        Object scroll = field("scroll");
        for (int i = 0; i < 30; i++) {
            rows.getJSONObject(0).put("preview", "stream token " + i).put("cursor", i);
            push(rows);
        }
        getInstrumentation().waitForIdleSync();
        main(() -> {
            assertSame("Live snapshots must retain the scrolling container", scroll, field("scroll"));
            for (int i = 0; i < tags.length; i++) assertSame(tags[i], original[i], view(tags[i]));
            assertEquals("Unchanged cards must never detach", 0, detached[0]);
        });
    }

    public void testVisibleChangeReplacesOnlyTheChangedCard() throws Exception {
        View[] original = new View[3];
        main(() -> {
            original[0] = view("homeActive:http://100.80.1.8:43127#scroll-0");
            original[1] = view("homeActive:http://100.80.1.8:43127#scroll-1");
            original[2] = view("workbenchNav");
        });
        rows.getJSONObject(0).put("title", "Needs attention").put("activity", "permission");
        push(rows);
        awaitTitle(0, "Needs attention");
        main(() -> {
            assertNotSame(original[0], view("homeActive:http://100.80.1.8:43127#scroll-0"));
            assertSame(original[1], view("homeActive:http://100.80.1.8:43127#scroll-1"));
            assertSame(original[2], view("workbenchNav"));
            String status = ((TextView) view("homeActiveStatus:http://100.80.1.8:43127#scroll-0")).getText().toString();
            assertTrue(status.equals("等待电脑处理") || status.equals("Waiting for desktop input"));
        });
    }

    public void testPullRefreshKeepsThePageAndUnchangedCards() throws Exception {
        Object scroll = field("scroll");
        View[] unchanged = new View[1];
        rows.getJSONObject(0).put("title", "Fresh from pull");
        main(() -> {
            unchanged[0] = view("homeActive:http://100.80.1.8:43127#scroll-1");
            field("homeRefreshAt", 0L);
            java.lang.reflect.Field refresh = RefreshScrollView.class.getDeclaredField("refresh");
            refresh.setAccessible(true);
            ((Runnable) refresh.get(scroll)).run();
        });
        awaitTitle(0, "Fresh from pull");
        main(() -> {
            assertSame(scroll, field("scroll"));
            assertSame(unchanged[0], view("homeActive:http://100.80.1.8:43127#scroll-1"));
        });
    }

    public void testRunningToggleKeepsTheListSubscription() throws Exception {
        Object scroll = field("scroll");
        main(() -> {
            view("homeRunningToggle").performClick();
            assertNull(view("homeActive:http://100.80.1.8:43127#scroll-3"));
            view("homeRunningToggle").performClick();
            assertNotNull(view("homeActive:http://100.80.1.8:43127#scroll-34"));
            assertSame(scroll, field("scroll"));
        });
        SystemClock.sleep(200);
        assertEquals("Expand/collapse must not reopen the desktop stream", 1, subscriptions.get());
    }

    public void testDragCoalescesUpdatesAndKeepsLatestStateAfterRelease() throws Exception {
        ChatScrollView scroll = (ChatScrollView) field("scroll");
        main(() -> touch(scroll, MotionEvent.ACTION_DOWN));
        for (int i = 0; i < 12; i++) {
            rows.getJSONObject(0).put("title", "Latest " + i);
            push(rows);
        }
        getInstrumentation().waitForIdleSync();
        SystemClock.sleep(250);
        main(() -> {
            assertEquals("Updates must wait even when a finger rests longer than the idle delay", "Work 0", title(0));
            touch(scroll, MotionEvent.ACTION_CANCEL);
            // Keep the latest wire snapshot as the cache the home page reads, then
            // exercise the same idle render path without depending on a transient
            // embedded-network listener during the gesture.
            RemoteListCache.workbench(getInstrumentation().getTargetContext())
                .put(credentials, rows, -1, new JSONArray(), true);
            invoke("refreshHomeContent");
        });
        awaitTitle(0, "Latest 11");
        assertSame(scroll, field("scroll"));
    }

    public void testFlingContinuesDuringPushAndPreservesVisibleAnchorOnCompletion() throws Exception {
        ChatScrollView scroll = (ChatScrollView) field("scroll");
        View[] anchor = new View[1];
        int[] offset = new int[1];
        int[] flingStart = new int[1];
        boolean[] moved = {false}, updatedDuringFling = {false};
        android.view.ViewTreeObserver.OnScrollChangedListener observeFling = () -> {
            if (!scroll.isFlinging() || scroll.getScrollY() == flingStart[0]) return;
            moved[0] = true;
            updatedDuringFling[0] |= !"Work 0".equals(title(0));
        };
        rows.getJSONObject(0).put("title", "Changed during fling");
        main(() -> {
            View row = view("homeActive:http://100.80.1.8:43127#scroll-8");
            WorkbenchList list = (WorkbenchList) view("homeConversations");
            scroll.scrollTo(0, list.getTop() + row.getTop() + 10);
            touch(scroll, MotionEvent.ACTION_DOWN);
            touch(scroll, MotionEvent.ACTION_CANCEL);
            flingStart[0] = scroll.getScrollY();
            scroll.getViewTreeObserver().addOnScrollChangedListener(observeFling);
            scroll.fling(2800);
            push(rows);
        });
        try {
            awaitTitle(0, "Changed during fling");
            main(() -> {
                assertTrue("The fixture must exercise a moving fling", moved[0]);
                assertFalse("A live update must not interrupt the fling", updatedDuringFling[0] || scroll.isFlinging());
            });
        } finally {
            main(() -> scroll.getViewTreeObserver().removeOnScrollChangedListener(observeFling));
        }
        main(() -> {
            WorkbenchList list = (WorkbenchList) view("homeConversations");
            for (int i = 1; i < rows.length(); i++) {
                View candidate = view("homeActive:http://100.80.1.8:43127#scroll-" + i);
                if (list.getTop() + candidate.getBottom() > scroll.getScrollY()) {
                    anchor[0] = candidate;
                    offset[0] = list.getTop() + candidate.getTop() - scroll.getScrollY();
                    break;
                }
            }
        });
        assertNotNull(anchor[0]);
        // Completing an earlier card removes it from Running and inserts it into Recent.
        rows.getJSONObject(0).put("activity", "idle");
        push(rows);
        for (int attempt = 0; attempt < 60; attempt++) {
            boolean[] applied = {false};
            main(() -> applied[0] = view("homeRecent:http://100.80.1.8:43127#scroll-0") != null);
            if (applied[0]) break;
            SystemClock.sleep(25);
        }
        getInstrumentation().waitForIdleSync();
        main(() -> {
            assertNotNull(view("homeRecent:http://100.80.1.8:43127#scroll-0"));
            assertSame("Cards below a completed run remain attached", anchor[0], view((String) anchor[0].getTag()));
            WorkbenchList list = (WorkbenchList) view("homeConversations");
            assertEquals("Removing rows above the viewport must preserve its visible card offset",
                offset[0], list.getTop() + anchor[0].getTop() - scroll.getScrollY());
        });
    }

    public void testLeavingHomeDropsPendingGestureUpdate() throws Exception {
        ChatScrollView scroll = (ChatScrollView) field("scroll");
        main(() -> touch(scroll, MotionEvent.ACTION_DOWN));
        rows.getJSONObject(0).put("title", "Pending on old page");
        push(rows);
        getInstrumentation().waitForIdleSync();
        main(() -> {
            assertEquals("Work 0", title(0));
            invoke("settingsScreen");
            touch(scroll, MotionEvent.ACTION_CANCEL);
        });
        SystemClock.sleep(300);
        main(() -> {
            assertEquals("settings", field("screen"));
            assertNull(view("homeConversations"));
        });
    }

    private void push(JSONArray conversations) throws Exception {
        // Copy each wire snapshot so later test mutations cannot change an already queued push.
        listener.onSnapshot(new JSONObject().put("workbench", new JSONObject()
            .put("conversations", new JSONArray(conversations.toString())).put("nextOffset", -1)
            .put("workspaces", new JSONArray()).put("includeUnassigned", true)));
    }

    private void awaitTitle(int index, String expected) {
        for (int attempt = 0; attempt < 400; attempt++) {
            boolean[] ready = {false};
            main(() -> ready[0] = expected.equals(title(index)));
            if (ready[0]) return;
            SystemClock.sleep(25);
        }
        fail("Latest title was not applied: " + expected);
    }

    private View view(String tag) { return activity.getWindow().getDecorView().findViewWithTag(tag); }
    private String title(int index) {
        TextView title = view("homeActive:http://100.80.1.8:43127#scroll-" + index).findViewWithTag("conversationRowTitle");
        return title.getText().toString();
    }
    private void touch(ChatScrollView scroll, int action) {
        long now = SystemClock.uptimeMillis();
        MotionEvent event = MotionEvent.obtain(now, now, action, scroll.getWidth() / 2f, scroll.getHeight() / 2f, 0);
        try { scroll.dispatchTouchEvent(event); } finally { event.recycle(); }
    }
    private interface Checked { void run() throws Exception; }
    private void main(Checked action) {
        Throwable[] failure = {null};
        getInstrumentation().runOnMainSync(() -> {
            try { action.run(); } catch (Throwable error) { failure[0] = error; }
        });
        if (failure[0] != null) throw new AssertionError(failure[0]);
    }
    private Object field(String name) throws Exception {
        var field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); return field.get(activity);
    }
    private void field(String name, Object value) throws Exception {
        var field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); field.set(activity, value);
    }
    private void invoke(String name) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity);
    }
}
