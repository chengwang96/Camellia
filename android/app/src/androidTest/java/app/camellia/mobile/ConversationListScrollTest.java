package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Rect;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.EditText;
import android.widget.ScrollView;
import org.json.JSONArray;
import org.json.JSONObject;

public class ConversationListScrollTest extends InstrumentationTestCase {
    private MainActivity activity;
    private JSONObject computer;
    private JSONArray rows;
    private interface Check { void run() throws Exception; }

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        new CredentialStore(context).clear();
        computer = new JSONObject().put("address", "http://100.80.8.1:43127").put("token", "scroll".repeat(9));
        rows = new JSONArray();
        for (int i = 0; i < 65; i++) rows.put(new JSONObject().put("id", "list-scroll-" + i)
            .put("title", "Scroll fixture " + i).put("engine", "codex").put("pinned", true));
        cache(computer, rows);
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            set(activity, "foreground", false);
            set(activity, "credentials", computer);
            invoke(activity, "listScreen");
        });
        frames();
    }

    @Override protected void tearDown() throws Exception {
        if (activity != null) ui(activity::finish);
        getInstrumentation().waitForIdleSync();
        var context = getInstrumentation().getTargetContext();
        RemoteListCache.get(context).remove(computer);
        new CredentialStore(context).clear();
        super.tearDown();
    }

    private void cache(JSONObject credentials, JSONArray conversations) {
        RemoteListCache.get(getInstrumentation().getTargetContext()).put(credentials, conversations, -1, new JSONArray(), true);
    }

    private void ui(Check action) {
        var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    private static Object get(Activity target, String name) throws Exception {
        var field = target.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(target);
    }

    private static void set(Activity target, String name, Object value) throws Exception {
        var field = target.getClass().getDeclaredField(name); field.setAccessible(true); field.set(target, value);
    }

    private static void invoke(Activity target, String name) throws Exception {
        var method = target.getClass().getDeclaredMethod(name); method.setAccessible(true); method.invoke(target);
    }

    private void frames() throws Exception {
        var complete = new java.util.concurrent.CountDownLatch(1);
        ui(() -> activity.getWindow().getDecorView().postOnAnimation(new Runnable() {
            int remaining = 5;
            public void run() {
                if (--remaining == 0) complete.countDown();
                else activity.getWindow().getDecorView().postOnAnimation(this);
            }
        }));
        assertTrue("Layout must settle", complete.await(5, java.util.concurrent.TimeUnit.SECONDS));
        getInstrumentation().waitForIdleSync();
    }

    private int rowTop(Activity target, String tag) throws Exception {
        android.view.ViewGroup content = (android.view.ViewGroup) get(target, "content");
        View row = content.findViewWithTag(tag);
        assertNotNull(tag, row);
        Rect bounds = new Rect(); row.getDrawingRect(bounds); content.offsetDescendantRectToMyCoords(row, bounds);
        return bounds.top;
    }

    private void scrollTo(String id) throws Exception {
        ui(() -> ((ScrollView) get(activity, "scroll")).scrollTo(0, rowTop(activity, "conversation:" + id) + 13));
        frames();
    }

    private void openAndBack(String id) throws Exception {
        ui(() -> {
            activity.getWindow().getDecorView().findViewWithTag("conversation:" + id).performClick();
            assertEquals("detail", get(activity, "screen"));
        });
        frames();
        ui(activity::onBackPressed);
        frames();
    }

    private void assertAnchor(String id) {
        ui(() -> checkAnchor(id));
    }

    private void checkAnchor(String id) throws Exception {
        assertEquals("list", get(activity, "screen"));
        assertEquals("Return must keep the same visible row and pixel offset", -13,
            rowTop(activity, "conversation:" + id) - ((ScrollView) get(activity, "scroll")).getScrollY());
    }

    public void testBackRestoresPositionAcrossRepeatedConversationVisits() throws Exception {
        scrollTo("list-scroll-28");
        openAndBack("list-scroll-29");
        assertAnchor("list-scroll-28");
        scrollTo("list-scroll-43");
        openAndBack("list-scroll-44");
        assertAnchor("list-scroll-43");
    }

    public void testSynchronousRefreshAndInsertedRowPreserveVisibleConversation() throws Exception {
        scrollTo("list-scroll-28");
        ui(() -> activity.getWindow().getDecorView().findViewWithTag("conversation:list-scroll-29").performClick());
        JSONArray changed = new JSONArray().put(new JSONObject().put("id", "new-row").put("title", "New conversation").put("pinned", true));
        for (int i = 0; i < rows.length(); i++) changed.put(rows.get(i));
        cache(computer, changed);
        ui(() -> {
            activity.onBackPressed();
            var apply = MainActivity.class.getDeclaredMethod("applyConversationPage", JSONObject.class, boolean.class);
            apply.setAccessible(true);
            apply.invoke(activity, new JSONObject().put("conversations", changed), false);
            apply.invoke(activity, new JSONObject().put("conversations", changed), false);
        });
        frames();
        assertAnchor("list-scroll-28");
    }

    public void testReturnRestoresBeforeTheFirstVisibleFrame() throws Exception {
        scrollTo("list-scroll-28");
        ui(() -> activity.getWindow().getDecorView().findViewWithTag("conversation:list-scroll-29").performClick());
        frames();
        var drawn = new java.util.concurrent.CountDownLatch(1);
        var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        ui(() -> {
            activity.onBackPressed();
            View list = (View) get(activity, "scroll");
            list.getViewTreeObserver().addOnPreDrawListener(new android.view.ViewTreeObserver.OnPreDrawListener() {
                public boolean onPreDraw() {
                    list.getViewTreeObserver().removeOnPreDrawListener(this);
                    try { checkAnchor("list-scroll-28"); }
                    catch (Throwable error) { failure.set(error); }
                    finally { drawn.countDown(); }
                    return true;
                }
            });
        });
        assertTrue(drawn.await(5, java.util.concurrent.TimeUnit.SECONDS));
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    public void testLoadingPlaceholderDoesNotConsumeTheSavedPosition() throws Exception {
        scrollTo("list-scroll-28");
        ui(() -> activity.getWindow().getDecorView().findViewWithTag("conversation:list-scroll-29").performClick());
        RemoteListCache.get(getInstrumentation().getTargetContext()).remove(computer);
        ui(activity::onBackPressed); frames();
        ui(() -> {
            assertNotNull(activity.getWindow().getDecorView().findViewWithTag("chatEmptyState"));
            set(activity, "listLoaded", true);
            var apply = MainActivity.class.getDeclaredMethod("applyConversationPage", JSONObject.class, boolean.class);
            apply.setAccessible(true);
            apply.invoke(activity, new JSONObject().put("conversations", rows), false);
        });
        frames(); assertAnchor("list-scroll-28");
    }

    public void testActivityRecreationInsideConversationRetainsListPosition() throws Exception {
        new ComputerStore(new CredentialStore(getInstrumentation().getTargetContext())).save(computer);
        scrollTo("list-scroll-28");
        ui(() -> activity.getWindow().getDecorView().findViewWithTag("conversation:list-scroll-29").performClick());
        frames();
        var monitor = getInstrumentation().addMonitor(MainActivity.class.getName(), null, false);
        try {
            ui(activity::recreate);
            Activity recreated = monitor.waitForActivityWithTimeout(5000);
            assertNotNull("Android must recreate the activity", recreated);
            activity = (MainActivity) recreated;
            ui(() -> { invoke(activity, "stopNetwork"); set(activity, "foreground", false); });
            frames();
            ui(() -> assertEquals("detail", get(activity, "screen")));
            ui(activity::onBackPressed); frames(); assertAnchor("list-scroll-28");
        } finally { getInstrumentation().removeMonitor(monitor); }
    }

    public void testFilterAndSearchSurviveReturn() throws Exception {
        ui(() -> {
            set(activity, "conversationFilter", "pinned");
            invoke(activity, "renderConversations");
            ((View) get(activity, "searchBar")).setVisibility(View.VISIBLE);
            ((EditText) get(activity, "searchInput")).setText("Scroll fixture");
        });
        frames();
        scrollTo("list-scroll-28");
        openAndBack("list-scroll-29");
        ui(() -> {
            assertEquals("pinned", get(activity, "conversationFilter"));
            assertEquals("Scroll fixture", ((EditText) get(activity, "searchInput")).getText().toString());
            assertEquals(View.VISIBLE, ((View) get(activity, "searchBar")).getVisibility());
        });
        assertAnchor("list-scroll-28");
    }

    public void testEachComputerHasItsOwnPosition() throws Exception {
        JSONObject other = new JSONObject().put("address", "http://100.80.8.2:43127").put("token", "other".repeat(9));
        cache(other, rows);
        try {
            scrollTo("list-scroll-28");
            ui(() -> { set(activity, "credentials", other); invoke(activity, "listScreen"); });
            frames();
            ui(() -> assertEquals("A different computer starts at the top", 0, ((ScrollView) get(activity, "scroll")).getScrollY()));
            scrollTo("list-scroll-43");
            ui(() -> { set(activity, "credentials", computer); invoke(activity, "listScreen"); });
            frames(); assertAnchor("list-scroll-28");
            ui(() -> { set(activity, "credentials", other); invoke(activity, "listScreen"); });
            frames(); assertAnchor("list-scroll-43");
        } finally { RemoteListCache.get(getInstrumentation().getTargetContext()).remove(other); }
    }

    public void testMissingAnchorClampsSafelyAndNewPairingStartsAtTop() throws Exception {
        scrollTo("list-scroll-55");
        ui(() -> activity.getWindow().getDecorView().findViewWithTag("conversation:list-scroll-56").performClick());
        cache(computer, new JSONArray().put(rows.get(0)));
        ui(activity::onBackPressed); frames();
        ui(() -> {
            ScrollView scroll = (ScrollView) get(activity, "scroll");
            assertEquals(0, scroll.getScrollY());
            assertNotNull(activity.getWindow().getDecorView().findViewWithTag("conversation:list-scroll-0"));
        });
        cache(computer, rows);
        ui(() -> invoke(activity, "listScreen")); frames(); scrollTo("list-scroll-28");
        JSONObject repaired = new JSONObject(computer.toString()).put("token", "replacement");
        cache(repaired, rows);
        try {
            ui(() -> { set(activity, "credentials", repaired); invoke(activity, "listScreen"); }); frames();
            ui(() -> assertEquals(0, ((ScrollView) get(activity, "scroll")).getScrollY()));
        } finally { RemoteListCache.get(getInstrumentation().getTargetContext()).remove(repaired); }
    }

    public void testLocalConversationListAlsoRestoresItsPosition() throws Exception {
        var context = getInstrumentation().getTargetContext();
        LocalChatFixture.clear(context);
        LocalChatFixture fixture = new LocalChatFixture(context);
        for (int i = 0; i < 65; i++) fixture.conversations().put(new JSONObject().put("id", "local-scroll-" + i)
            .put("title", "Local fixture " + i).put("workspaceId", "").put("messages", new JSONArray()).put("order", i));
        fixture.save();
        LocalChatActivity local = (LocalChatActivity) LocalChatFixture.start(getInstrumentation(),
            new Intent(context, LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            ui(() -> ((ScrollView) get(local, "scroll")).scrollTo(0, rowTop(local, "localConversation:local-scroll-28") + 13));
            getInstrumentation().waitForIdleSync();
            ui(() -> local.getWindow().getDecorView().findViewWithTag("localConversation:local-scroll-29").performClick());
            long deadline = android.os.SystemClock.uptimeMillis() + 5000;
            while (android.os.SystemClock.uptimeMillis() < deadline) {
                boolean[] ready = {false};
                ui(() -> ready[0] = local.getWindow().getDecorView().findViewWithTag("localComposer") != null);
                if (ready[0]) break;
                android.os.SystemClock.sleep(20);
            }
            ui(local::onBackPressed); getInstrumentation().waitForIdleSync();
            ui(() -> assertEquals(-13, rowTop(local, "localConversation:local-scroll-28") - ((ScrollView) get(local, "scroll")).getScrollY()));
        } finally {
            ui(local::finish); getInstrumentation().waitForIdleSync(); LocalChatFixture.clear(context);
        }
    }
}
