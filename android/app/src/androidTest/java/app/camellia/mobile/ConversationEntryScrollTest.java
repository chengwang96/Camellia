package app.camellia.mobile;

import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.widget.ScrollView;
import org.json.JSONArray;
import org.json.JSONObject;

public class ConversationEntryScrollTest extends InstrumentationTestCase {
    private MainActivity activity;
    private interface Check { void run() throws Exception; }

    private void ui(Check check) {
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    private Object field(String name) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); return member.get(activity);
    }

    private void field(String name, Object value) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); member.set(activity, value);
    }

    private void detail() throws Exception {
        var method = MainActivity.class.getDeclaredMethod("detailScreen"); method.setAccessible(true); method.invoke(activity);
    }

    private JSONObject snapshot(int cursor) throws Exception {
        return new JSONObject().put("instanceId", "entry-scroll").put("cursor", cursor)
            .put("conversation", new JSONObject().put("id", "entry-scroll").put("seq", cursor))
            .put("messages", new JSONArray().put(new JSONObject().put("seq", 1).put("role", "assistant")
                .put("text", "消息内容，用于验证进入会话时默认显示最新消息。\n\n".repeat(50) + "最后一条消息")))
            .put("nextBefore", JSONObject.NULL);
    }

    private void apply(int cursor) throws Exception {
        var method = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); method.setAccessible(true);
        method.invoke(activity, snapshot(cursor));
    }

    @Override protected void setUp() throws Exception {
        super.setUp();
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            field("credentials", new JSONObject().put("address", "http://100.64.0.1:43128").put("token", "entry-scroll"));
            field("conversationId", "entry-scroll");
        });
    }

    @Override protected void tearDown() throws Exception {
        ui(activity::finish); getInstrumentation().waitForIdleSync(); super.tearDown();
    }

    private void assertBottom() {
        awaitLayout();
        ui(() -> {
            ScrollView scroll = (ScrollView) field("scroll");
            assertTrue("Long conversation must actually scroll: viewport=" + scroll.getHeight() + ", content=" + scroll.getChildAt(0).getHeight()
                + ", pending=" + field("pendingScrollPosition") + ", listener=" + field("pendingMessageScroll"), scroll.getScrollY() > 0);
            assertFalse("Entry must show the bottom without user scrolling", scroll.canScrollVertically(1));
        });
    }

    private void awaitLayout() {
        java.util.concurrent.CountDownLatch frames = new java.util.concurrent.CountDownLatch(1);
        ui(() -> activity.getWindow().getDecorView().postOnAnimation(new Runnable() {
            private int remaining = 4;
            @Override public void run() {
                if (--remaining == 0) frames.countDown();
                else activity.getWindow().getDecorView().postOnAnimation(this);
            }
        }));
        try { assertTrue("Layout frames must complete", frames.await(5, java.util.concurrent.TimeUnit.SECONDS)); }
        catch (InterruptedException error) { throw new AssertionError(error); }
        getInstrumentation().waitForIdleSync();
    }

    public void testFreshEntryShowsBottomAndLaterUpdatesRespectReadingPosition() {
        ui(() -> { detail(); apply(1); });
        assertBottom();
        ui(() -> ((ScrollView) field("scroll")).scrollTo(0, 160));
        getInstrumentation().waitForIdleSync();
        ui(() -> apply(2));
        awaitLayout();
        ui(() -> assertEquals(160, ((ScrollView) field("scroll")).getScrollY()));
        ui(() -> { detail(); apply(3); });
        assertBottom();
    }

    public void testCachedEntryShowsBottomBeforeNetworkReply() {
        ui(() -> {
            ((RemotePrefetch) field("prefetch")).put((JSONObject) field("credentials"), snapshot(1));
            detail();
        });
        assertBottom();
        ui(() -> apply(2));
        assertBottom();
    }

    public void testCachedAndLiveSnapshotsInSameFrameStillShowBottom() {
        ui(() -> {
            ((RemotePrefetch) field("prefetch")).put((JSONObject) field("credentials"), snapshot(1));
            detail(); apply(2); apply(3);
        });
        assertBottom();
    }
}
