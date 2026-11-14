package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.test.InstrumentationTestCase;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

public class RemoteSettingsLayoutTest extends InstrumentationTestCase {
    private Activity activity;
    private FrameLayout fixture;
    private View anchor;
    private EditText imeProbe;
    private RemoteSettingsPopup selector;

    @Override protected void setUp() throws Exception {
        super.setUp();
        activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().runOnMainSync(() -> {
            fixture = new FrameLayout(activity);
            TextView button = new TextView(activity); button.setText("Models");
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(200, 100, Gravity.BOTTOM | Gravity.RIGHT);
            params.bottomMargin = 40; fixture.addView(button, params);
            anchor = button; activity.setContentView(fixture);
            imeProbe = new EditText(activity); imeProbe.setTag("imeProbe");
            FrameLayout.LayoutParams probe = new FrameLayout.LayoutParams(160, 48, Gravity.TOP | Gravity.LEFT);
            probe.topMargin = 40; fixture.addView(imeProbe, probe);
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

    public void testLongModelListKeepsContextVisibleOnPhoneAndTablet() throws Exception {
        open(40, false);
        getInstrumentation().waitForIdleSync();
        android.os.SystemClock.sleep(400);
        getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            PopupWindow popup = (PopupWindow) field("popup");
            Rect visible = new Rect();
            anchor.getWindowVisibleDisplayFrame(visible);
            int expected = PopupSurface.menuHeightLimit(activity, visible);
            assertEquals(expected, ((Integer) field("heightLimit")).intValue());
            assertEquals(PopupSurface.modelMenuWidth(activity, visible), popup.getWidth());
            assertTrue(popup.getHeight() <= expected);
            assertTrue("A long model list must leave conversation context visible",
                popup.getHeight() < Math.round(visible.height() * .62f));
            View fade = popup.getContentView().findViewWithTag("glassScrollFade");
            assertNotNull(fade);
            assertEquals("A clipped list needs a cue that it can keep scrolling",
                View.VISIBLE, fade.getVisibility());

            float density = activity.getResources().getDisplayMetrics().density;
            Rect tablet = new Rect(0, 0, Math.round(900 * density), Math.round(1200 * density));
            int tabletLimit = PopupSurface.menuHeightLimit(activity, tablet);
            assertTrue(tabletLimit <= Math.round(400 * density));
            assertTrue("A tablet menu must not use half the screen either",
                tabletLimit < tablet.height() / 2);
        });
        Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull(image);
        try (var output = new java.io.FileOutputStream(new java.io.File(
                activity.getExternalCacheDir(), "remote-model-compact.png"))) {
            image.compress(Bitmap.CompressFormat.PNG, 100, output);
        } finally {
            image.recycle();
        }
        getInstrumentation().runOnMainSync(() -> {
            ScrollView scroll = (ScrollView) field("scroll");
            scroll.setSmoothScrollingEnabled(false);
            scroll.fullScroll(View.FOCUS_DOWN);
        });
        getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            PopupWindow popup = (PopupWindow) field("popup");
            View fade = popup.getContentView().findViewWithTag("glassScrollFade");
            assertEquals("The fade must disappear at the end of the list", View.GONE, fade.getVisibility());
        });
    }

    public void testModelMenuStaysAboveTheKeyboard() throws Exception {
        getInstrumentation().runOnMainSync(() -> {
            activity.getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            imeProbe.requestFocus();
            android.view.inputmethod.InputMethodManager keyboard =
                (android.view.inputmethod.InputMethodManager) activity.getSystemService(Activity.INPUT_METHOD_SERVICE);
            keyboard.showSoftInput(imeProbe, android.view.inputmethod.InputMethodManager.SHOW_FORCED);
        });
        int screenHeight = activity.getResources().getDisplayMetrics().heightPixels;
        boolean keyboardVisible = false;
        for (int attempt = 0; attempt < 30 && !keyboardVisible; attempt++) {
            android.os.SystemClock.sleep(100);
            getInstrumentation().waitForIdleSync();
            int[] height = new int[1];
            getInstrumentation().runOnMainSync(() -> {
                Rect visible = PopupSurface.visibleFrame(anchor);
                height[0] = visible.height();
            });
            keyboardVisible = height[0] < screenHeight - Math.round(140 * activity.getResources().getDisplayMetrics().density);
        }
        if (!keyboardVisible) {
            getInstrumentation().runOnMainSync(() -> {
                android.view.inputmethod.InputMethodManager keyboard =
                    (android.view.inputmethod.InputMethodManager) activity.getSystemService(Activity.INPUT_METHOD_SERVICE);
                keyboard.hideSoftInputFromWindow(imeProbe.getWindowToken(), 0);
            });
            return;
        }
        try {
            open(40, false);
            getInstrumentation().runOnMainSync(() -> {
                PopupWindow popup = (PopupWindow) field("popup");
                Rect visible = PopupSurface.visibleFrame(anchor);
                int limit = PopupSurface.menuHeightLimit(activity, visible);
                assertTrue(popup.getHeight() <= limit);
                int[] location = new int[2];
                popup.getContentView().getLocationOnScreen(location);
                assertTrue("The model menu must remain above the IME",
                    location[1] + popup.getHeight() <= visible.bottom);
            });
            Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot();
            assertNotNull(image);
            try (var output = new java.io.FileOutputStream(new java.io.File(
                    activity.getExternalCacheDir(), "remote-model-keyboard.png"))) {
                image.compress(Bitmap.CompressFormat.PNG, 100, output);
            } finally {
                image.recycle();
            }
        } finally {
            getInstrumentation().runOnMainSync(() -> {
                android.view.inputmethod.InputMethodManager keyboard =
                    (android.view.inputmethod.InputMethodManager) activity.getSystemService(Activity.INPUT_METHOD_SERVICE);
                keyboard.hideSoftInputFromWindow(imeProbe.getWindowToken(), 0);
            });
        }
    }
}
