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

    public void testLongPressReorderAndMoveToCollapsedWorkspace() throws Exception {
        LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext());
        String workspace = store.createWorkspace("Source").getString("id");
        String target = store.createWorkspace("Target").getString("id");
        JSONObject first = store.createConversation(workspace, "route"), second = store.createConversation(workspace, "route");
        String firstId = first.getString("id"), secondId = second.getString("id");
        first.put("title", "First").put("updatedAt", 20); second.put("title", "Second").put("updatedAt", 10); store.save();
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            drag(activity, "localConversation:" + firstId, "localConversation:" + secondId, true);
            store = new LocalChatStore(getInstrumentation().getTargetContext());
            assertEquals(secondId, store.orderedConversations(workspace).get(0).getString("id"));
            assertEquals(firstId, store.orderedConversations(workspace).get(1).getString("id"));
            getInstrumentation().runOnMainSync(() -> activity.getWindow().getDecorView().findViewWithTag("localGroup:" + target).performClick());
            drag(activity, "localConversation:" + firstId, "localGroup:" + target, false);
            store = new LocalChatStore(getInstrumentation().getTargetContext());
            assertEquals(target, store.conversation(firstId).getString("workspaceId"));
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
