package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.Button;
import android.widget.ScrollView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.TreeMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public class RemoteHistoryLoadingTest extends InstrumentationTestCase {
    private static final String ID = "00000000-0000-0000-0000-000000000001";
    private Activity activity;
    private final CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
    private final AtomicInteger requests = new AtomicInteger();
    private boolean block, fail, slow;

    private Object field(String name) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); return member.get(activity);
    }
    private void field(String name, Object value) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); member.set(activity, value);
    }
    private void call(String name) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity);
    }
    private void apply(JSONObject snapshot) throws Exception {
        var method = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); method.setAccessible(true); method.invoke(activity, snapshot);
    }
    private void main(Checked action) {
        var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> {
            try { action.run(); } catch (Throwable error) { failure.set(error); }
        });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private interface Checked { void run() throws Exception; }
    private interface Check { boolean done() throws Exception; }
    private void await(Check check) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + 8000;
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            boolean[] done = {false}; main(() -> done[0] = check.done());
            if (done[0]) { getInstrumentation().waitForIdleSync(); return; }
            Thread.sleep(20);
        }
        fail("Timed out waiting for history loading");
    }
    @SuppressWarnings("unchecked") private TreeMap<Long, JSONObject> history() throws Exception { return (TreeMap<Long, JSONObject>) field("history"); }
    private int visible() throws Exception { return (int) history().values().stream().filter(RemoteHistoryPage::visible).count(); }
    private JSONObject snapshot(long first, long last, String role, Long next) throws Exception {
        JSONArray rows = new JSONArray();
        for (long seq = first; seq <= last; seq++) rows.put(new JSONObject().put("seq", seq).put("role", role)
            .put("text", seq == 100 ? "Latest reply paragraph.\n\n".repeat(100) : "History " + seq));
        return new JSONObject().put("instanceId", "server").put("historyVersion", "v1").put("cursor", 1)
            .put("permission", "control").put("conversation", new JSONObject().put("id", ID).put("seq", 100))
            .put("messages", rows).put("nextBefore", next == null ? JSONObject.NULL : next);
    }
    private void open() throws Exception {
        activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().waitForIdleSync();
        main(() -> {
            field("foreground", false);
            field("credentials", new JSONObject().put("address", "http://100.80.1.2:43127").put("token", "a".repeat(43)));
            field("conversationId", ID); call("detailScreen");
            // Startup may still own unrelated reads. Control this pool so the
            // late-page test waits for the actual history request to finish.
            ((java.util.concurrent.ExecutorService) field("worker")).shutdownNow();
            field("worker", java.util.concurrent.Executors.newFixedThreadPool(1));
            field("api", new RemoteApi("http://100.80.1.2:43127") {
                @Override public JSONObject json(String path, String token, JSONObject payload) throws IOException {
                    int request = requests.incrementAndGet();
                    if (slow && request == 1) {
                        try { Thread.sleep(2100); } catch (InterruptedException error) { throw new IOException(error); }
                    }
                    if (block && request == 1) {
                        entered.countDown();
                        try { if (!release.await(8, TimeUnit.SECONDS)) throw new IOException("Test timed out"); }
                        catch (InterruptedException error) { throw new IOException(error); }
                    }
                    if (fail && request == 1) throw new IOException("Slow or offline network");
                    try {
                        long before = Long.parseLong(path.substring(path.indexOf("before=") + 7));
                        return before == 100 ? snapshot(80, 99, "tool", 80L)
                            : snapshot(Math.max(1, before - 40), before - 1, "assistant", before <= 41 ? null : before - 40);
                    } catch (Exception error) { throw new IOException(error); }
                }
                @Override public void cancel() { }
            });
            field("foreground", true);
            apply(snapshot(100, 100, "assistant", 100L));
            assertEquals("Latest reply must be available before history requests", 1, visible());
            assertEquals(0, requests.get());
        });
    }
    @Override protected void tearDown() throws Exception {
        release.countDown();
        if (activity != null) main(activity::finish);
        super.tearDown();
    }

    public void testFastConnectionAutomaticallyCrossesProcessPagesAndKeepsTheLatestReply() throws Exception {
        open();
        await(() -> visible() == 30 && !(boolean) field("olderLoading"));
        main(() -> {
            assertEquals(2, requests.get()); assertTrue(history().containsKey(100L));
            assertFalse((boolean) field("historyDetached")); assertEquals(51L, field("nextBefore"));
            assertTrue(((Button) field("older")).isEnabled());
            assertFalse("Opening must remain at the latest reply", ((ScrollView) field("scroll")).canScrollVertically(1));
        });
    }

    public void testBackgroundHistoryPreservesTheReadersVisibleMessage() throws Exception {
        block = true; open(); assertTrue(entered.await(5, TimeUnit.SECONDS));
        getInstrumentation().waitForIdleSync();
        int[] offset = new int[1];
        main(() -> {
            ScrollView scroll = (ScrollView) field("scroll");
            scroll.scrollTo(0, scroll.getScrollY() - 500);
            View message = ((android.view.ViewGroup) field("messages")).getChildAt(0);
            int[] location = new int[2]; message.getLocationOnScreen(location); offset[0] = location[1];
        });
        release.countDown(); await(() -> visible() == 30 && !(boolean) field("olderLoading"));
        main(() -> {
            View message = ((java.util.Map<?, View>) field("renderedMessages")).get("message:100");
            int[] location = new int[2]; message.getLocationOnScreen(location);
            assertEquals("Prepending history must retain the same reading position", offset[0], location[1]);
            assertTrue(((ScrollView) field("scroll")).canScrollVertically(1));
        });
    }

    public void testAutomaticFailureStopsQuietlyAndManualLoadingStillWorks() throws Exception {
        fail = true; open(); await(() -> requests.get() == 1 && !(boolean) field("olderLoading"));
        main(() -> { assertTrue((boolean) field("connected")); assertTrue(((Button) field("older")).isEnabled()); call("loadOlder"); });
        await(() -> visible() > 1 && !(boolean) field("olderLoading"));
        main(() -> { assertEquals(3, requests.get()); assertTrue(history().containsKey(100L)); });
    }

    public void testSlowConnectionStopsAfterOneProbeWithoutLosingTheManualEntry() throws Exception {
        slow = true; open(); await(() -> requests.get() == 1 && !(boolean) field("olderLoading"));
        main(() -> {
            assertEquals(1, visible()); assertEquals(80L, field("nextBefore"));
            assertTrue(((Button) field("older")).isEnabled());
            assertTrue(history().containsKey(100L)); assertFalse((boolean) field("historyDetached"));
        });
    }

    public void testFrequentLiveSnapshotsDoNotKeepPostponingAutomaticHistory() throws Exception {
        block = true; open();
        for (int cursor = 2; cursor <= 8; cursor++) {
            final int current = cursor;
            main(() -> apply(snapshot(100, 100, "assistant", 100L).put("cursor", current)));
            Thread.sleep(40);
        }
        assertTrue("Updates must not postpone the probe indefinitely", entered.await(1, TimeUnit.SECONDS));
        release.countDown(); await(() -> visible() == 30 && !(boolean) field("olderLoading"));
    }

    public void testSwitchingConversationRejectsTheLateAutomaticPage() throws Exception {
        block = true; open(); assertTrue(entered.await(5, TimeUnit.SECONDS));
        main(() -> {
            field("foreground", false); field("conversationId", "00000000-0000-0000-0000-000000000002");
            call("detailScreen"); field("foreground", true);
        });
        release.countDown();
        await(() -> ((java.util.concurrent.ThreadPoolExecutor) field("worker")).getActiveCount() == 0);
        main(() -> { assertTrue(history().isEmpty()); assertEquals(1, requests.get()); });
    }
}
