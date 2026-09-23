package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.os.SystemClock;
import android.test.InstrumentationTestCase;
import android.view.MotionEvent;
import android.view.View;
import org.json.JSONObject;

public class ConversationDragTest extends InstrumentationTestCase {
    private CredentialStore encrypted;

    @Override protected void setUp() throws Exception {
        super.setUp(); encrypted = new CredentialStore(getInstrumentation().getTargetContext(), "local-chat-private"); encrypted.clear();
    }

    @Override protected void tearDown() throws Exception { encrypted.clear(); super.tearDown(); }

    public void testAdjacentRowEdgesShareOneInsertionTarget() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ConversationDrag[] controller = new ConversationDrag[1];
        View[] rows = new View[3];
        try {
            getInstrumentation().runOnMainSync(() -> {
                android.widget.ScrollView scroll = new android.widget.ScrollView(activity);
                android.widget.LinearLayout group = new android.widget.LinearLayout(activity); group.setOrientation(android.widget.LinearLayout.VERTICAL);
                scroll.addView(group); activity.setContentView(scroll);
                controller[0] = new ConversationDrag(group, scroll, (id, workspace, target, after) -> {});
                controller[0].target(group, "workspace", null);
                for (int index = 0; index < rows.length; index++) {
                    rows[index] = new View(activity); group.addView(rows[index], new android.widget.LinearLayout.LayoutParams(-1, 150));
                    controller[0].target(rows[index], "workspace", "row" + index);
                }
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    ConversationDrag drag = controller[0];
                    set(drag, "source", rows[2]); set(drag, "sourceId", "row2");
                    locate(drag, rows[0], .8f);
                    Object target = get(drag, "target"), indicator = get(drag, "indicator");
                    assertNotNull(target); assertNotNull(indicator); assertEquals(false, get(drag, "after"));
                    var targetView = target.getClass().getDeclaredMethod("view"); targetView.setAccessible(true);
                    assertSame(rows[1], targetView.invoke(target));
                    for (int repeat = 0; repeat < 4; repeat++) {
                        rows[0].setTranslationY(-12); rows[1].setTranslationY(12);
                        locate(drag, rows[1], .2f);
                        assertSame("The next row's top is the same gap", target, get(drag, "target"));
                        assertSame("The highlight must not restart or jump", indicator, get(drag, "indicator"));
                        locate(drag, rows[0], .8f);
                        assertSame(target, get(drag, "target")); assertSame(indicator, get(drag, "indicator"));
                    }
                    locate(drag, rows[0], .2f);
                    assertSame(rows[0], targetView.invoke(get(drag, "target"))); assertEquals(false, get(drag, "after"));
                    locate(drag, rows[1], .8f);
                    assertSame(rows[1], targetView.invoke(get(drag, "target"))); assertEquals(true, get(drag, "after"));
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally {
            getInstrumentation().runOnMainSync(() -> { if (controller[0] != null) controller[0].cancel(); activity.finish(); });
        }
    }

    private static Object get(ConversationDrag drag, String name) throws Exception {
        var field = ConversationDrag.class.getDeclaredField(name); field.setAccessible(true); return field.get(drag);
    }

    private static void set(ConversationDrag drag, String name, Object value) throws Exception {
        var field = ConversationDrag.class.getDeclaredField(name); field.setAccessible(true); field.set(drag, value);
    }

    private static void locate(ConversationDrag drag, View row, float fraction) throws Exception {
        int[] location = new int[2]; row.getLocationOnScreen(location);
        set(drag, "screenX", location[0] + row.getWidth() / 2f);
        set(drag, "screenY", location[1] - row.getTranslationY() + row.getHeight() * fraction);
        var method = ConversationDrag.class.getDeclaredMethod("locate"); method.setAccessible(true); method.invoke(drag);
    }

    public void testLongPressOpensMenuWithoutChangingOrderOrWorkspace() throws Exception {
        LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext());
        String workspace = store.createWorkspace("Source").getString("id");
        String target = store.createWorkspace("Target").getString("id");
        JSONObject first = store.createConversation(workspace, "route"), second = store.createConversation(workspace, "route");
        String firstId = first.getString("id"), secondId = second.getString("id");
        first.put("title", "First").put("updatedAt", 20); second.put("title", "Second").put("updatedAt", 10); store.save();
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                View row = activity.getWindow().getDecorView().findViewWithTag("localConversation:" + firstId);
                assertTrue(row.performLongClick());
                assertEquals(1f, row.getAlpha(), .01f); assertEquals(0f, row.getTranslationY(), .01f);
                try {
                    var field = LocalChatActivity.class.getDeclaredField("conversationPopup"); field.setAccessible(true);
                    ConversationMenu menu = (ConversationMenu) field.get(activity);
                    assertNotNull(menu.panel.findViewWithTag("conversationAction:select")); menu.dismiss();
                } catch (Exception error) { throw new AssertionError(error); }
            });
            store = new LocalChatStore(getInstrumentation().getTargetContext());
            assertEquals(firstId, store.orderedConversations(workspace).get(0).getString("id"));
            assertEquals(secondId, store.orderedConversations(workspace).get(1).getString("id"));
            getInstrumentation().runOnMainSync(() -> activity.getWindow().getDecorView().findViewWithTag("localGroup:" + target).performClick());
            store = new LocalChatStore(getInstrumentation().getTargetContext());
            assertEquals(workspace, store.conversation(firstId).getString("workspaceId"));
            getInstrumentation().runOnMainSync(() -> assertNotNull(activity.getWindow().getDecorView().findViewWithTag("localConversation:" + firstId)));
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    private void drag(Activity activity, String from, String to, boolean after) {
        getInstrumentation().waitForIdleSync();
        float[] points = new float[4];
        getInstrumentation().runOnMainSync(() -> {
            View source = activity.getWindow().getDecorView().findViewWithTag(from);
            View target = activity.getWindow().getDecorView().findViewWithTag(to);
            assertNotNull(source); assertNotNull(target);
            int[] location = new int[2]; source.getLocationOnScreen(location);
            points[0] = location[0] + source.getWidth() / 3f; points[1] = location[1] + source.getHeight() / 2f;
            target.getLocationOnScreen(location);
            points[2] = location[0] + target.getWidth() / 3f; points[3] = location[1] + target.getHeight() * (after ? .85f : .5f);
        });
        long down = SystemClock.uptimeMillis();
        touch(down, MotionEvent.ACTION_DOWN, points[0], points[1]);
        SystemClock.sleep(700);
        getInstrumentation().runOnMainSync(() -> {
            View source = activity.getWindow().getDecorView().findViewWithTag(from);
            assertTrue("Long press fades the original row", source.getAlpha() < .6f);
        });
        for (int step = 1; step <= 12; step++) {
            touch(down, MotionEvent.ACTION_MOVE, points[0] + (points[2] - points[0]) * step / 12, points[1] + (points[3] - points[1]) * step / 12);
            SystemClock.sleep(20);
        }
        SystemClock.sleep(100);
        if (to.startsWith("localConversation:")) getInstrumentation().runOnMainSync(() -> {
            View target = activity.getWindow().getDecorView().findViewWithTag(to);
            assertTrue("Rows animate out of the insertion gap", Math.abs(target.getTranslationY()) > 1);
        });
        touch(down, MotionEvent.ACTION_UP, points[2], points[3]);
        SystemClock.sleep(450); getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            View source = activity.getWindow().getDecorView().findViewWithTag(from);
            assertNotNull(source); assertEquals(1f, source.getAlpha(), .01f); assertEquals(0f, source.getTranslationY(), .01f);
        });
    }

    private void touch(long down, int action, float horizontal, float vertical) {
        MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, horizontal, vertical, 0);
        event.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        try { assertTrue(getInstrumentation().getUiAutomation().injectInputEvent(event, true)); } finally { event.recycle(); }
    }
}
