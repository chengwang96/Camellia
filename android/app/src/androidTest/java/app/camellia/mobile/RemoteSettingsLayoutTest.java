package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

public class RemoteSettingsLayoutTest extends InstrumentationTestCase {
    private Activity activity;
    private View anchor;
    private RemoteSettingsPopup selector;

    @Override protected void setUp() throws Exception {
        super.setUp();
        activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().runOnMainSync(() -> {
            FrameLayout fixture = new FrameLayout(activity);
            TextView button = new TextView(activity); button.setText("Models");
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(200, 100, Gravity.BOTTOM | Gravity.RIGHT);
            params.bottomMargin = 40; fixture.addView(button, params);
            anchor = button; activity.setContentView(fixture);
        });
        getInstrumentation().waitForIdleSync();
    }

    @Override protected void tearDown() throws Exception {
        getInstrumentation().runOnMainSync(() -> { if (selector != null) selector.dismiss(); activity.finish(); });
        getInstrumentation().waitForIdleSync(); super.tearDown();
    }

    private Object field(String name) {
        try {
            var field = RemoteSettingsPopup.class.getDeclaredField(name); field.setAccessible(true); return field.get(selector);
        } catch (Exception error) { throw new AssertionError(error); }
    }

    private void open(int count, boolean permissions) throws Exception { open(count, permissions, "subscription", "subscription"); }

    private void open(int count, boolean permissions, String connection, String firstConnection) throws Exception {
        JSONArray models = new JSONArray();
        for (int index = 0; index < count; index++) {
            String id = index == 0 ? "openai/openai/gpt-6-astra" : "model-" + index;
            // Half of the list is a shared API route so the grouping caption is
            // exercised exactly like a subscription conversation that also has
            // routes configured.
            models.put(new JSONObject().put("id", id).put("connection", index % 2 == 0 ? firstConnection : other(firstConnection))
                .put("thinking", new JSONArray().put("high")));
        }
        JSONObject settings = new JSONObject().put("models", models).put("connection", connection)
            .put("model", "openai/openai/gpt-6-astra").put("permissionMode", "auto");
        getInstrumentation().runOnMainSync(() -> {
            selector = new RemoteSettingsPopup(activity, true, 0xffffffff, 0xff0f1115, 0xff61666b, 0xff4176e6,
                settings, (key, value) -> {});
            selector.show(anchor, permissions);
        });
        getInstrumentation().waitForIdleSync();
    }
    private String other(String connection) { return connection.equals("subscription") ? "api" : "subscription"; }

    private void assertFitsContent() {
        getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            PopupWindow popup = (PopupWindow) field("popup");
            LinearLayout body = (LinearLayout) field("body");
            ScrollView scroll = (ScrollView) field("scroll");
            int limit = (Integer) field("heightLimit");
            assertTrue(body.getHeight() > 0);
            assertEquals("Measure using the actual layout width", scroll.getWidth(), body.getWidth());
            assertEquals("Popup must not reserve blank space below its content", Math.min(limit, body.getHeight()), popup.getHeight());
            assertEquals("Keep only the intended bottom padding", body.getPaddingBottom(),
                body.getHeight() - body.getChildAt(body.getChildCount() - 1).getBottom());
        });
    }

    private void click(String tag) {
        getInstrumentation().runOnMainSync(() -> ((LinearLayout) field("body")).findViewWithTag(tag).performClick());
        getInstrumentation().waitForIdleSync();
    }

    public void testModelAndThinkingMenusFitContent() throws Exception {
        open(8, false); assertFitsContent();
        click("remoteThinkingSettings"); assertFitsContent();
        click("remoteThinkingBack"); assertFitsContent();
    }

    public void testPermissionMenuFitsContent() throws Exception {
        open(1, true); assertFitsContent();
    }

    public void testConnectionGroupsAreLabelledOnlyWhenBothArePresent() throws Exception {
        open(4, false);
        getInstrumentation().runOnMainSync(() -> {
            LinearLayout body = (LinearLayout) field("body");
            assertTrue(hasText(body, "账号模型"));
            assertTrue(hasText(body, "共享 API 路由"));
            assertNotNull(body.findViewWithTag("remoteModelOption:model-1"));
        });
    }

    public void testApiConversationAlsoOffersAccountModels() throws Exception {
        open(4, false, "api", "api");
        getInstrumentation().runOnMainSync(() -> {
            LinearLayout body = (LinearLayout) field("body");
            assertTrue(hasText(body, "账号模型"));
            assertTrue(hasText(body, "共享 API 路由"));
            // The route list leads, so its caption comes before the account one.
            assertTrue(indexOfText(body, "共享 API 路由") < indexOfText(body, "账号模型"));
            assertNotNull(body.findViewWithTag("remoteModelOption:model-1"));
        });
    }

    private int indexOfText(LinearLayout body, String value) {
        for (int index = 0; index < body.getChildCount(); index++) {
            View child = body.getChildAt(index);
            if (child instanceof TextView && value.contentEquals(((TextView) child).getText())) return index;
        }
        return -1;
    }

    public void testSingleConnectionListHasNoGroupCaptions() throws Exception {
        getInstrumentation().runOnMainSync(() -> {
            try {
                JSONArray models = new JSONArray();
                for (int index = 0; index < 3; index++) models.put(new JSONObject().put("id", "route-" + index).put("connection", "api"));
                JSONObject settings = new JSONObject().put("models", models).put("connection", "api").put("model", "route-0").put("permissionMode", "auto");
                selector = new RemoteSettingsPopup(activity, true, 0xffffffff, 0xff0f1115, 0xff61666b, 0xff4176e6, settings, (key, value) -> {});
                selector.show(anchor, false);
            } catch (Exception error) { throw new AssertionError(error); }
        });
        getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            LinearLayout body = (LinearLayout) field("body");
            assertFalse(hasText(body, "账号模型"));
            assertFalse(hasText(body, "共享 API 路由"));
        });
    }

    private boolean hasText(LinearLayout body, String value) {
        for (int index = 0; index < body.getChildCount(); index++) {
            View child = body.getChildAt(index);
            if (child instanceof TextView && value.contentEquals(((TextView) child).getText())) return true;
        }
        return false;
    }

    public void testLongModelListRemainsScrollable() throws Exception {
        open(40, false); assertFitsContent();
        getInstrumentation().runOnMainSync(() -> {
            ScrollView scroll = (ScrollView) field("scroll");
            assertTrue(scroll.canScrollVertically(1));
            scroll.setSmoothScrollingEnabled(false); scroll.fullScroll(View.FOCUS_DOWN);
        });
        getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            ScrollView scroll = (ScrollView) field("scroll");
            assertFalse(scroll.canScrollVertically(1));
            assertTrue(scroll.canScrollVertically(-1));
        });
        click("remoteThinkingSettings"); assertFitsContent();
    }
}
