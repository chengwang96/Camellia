package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.test.InstrumentationTestCase;
import android.view.KeyEvent;
import android.view.View;
import android.widget.PopupWindow;
import java.util.Arrays;
import java.util.Collections;

public class ModelPickerStyleTest extends InstrumentationTestCase {
    private Activity activity;
    private ModelPickerPopup picker;
    private String chosen;

    @Override protected void setUp() throws Exception {
        super.setUp();
        activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().waitForIdleSync();
    }

    @Override protected void tearDown() throws Exception {
        getInstrumentation().runOnMainSync(() -> { if (picker != null) picker.dismiss(); activity.finish(); });
        getInstrumentation().waitForIdleSync(); super.tearDown();
    }

    private View panel() {
        try {
            var field = ModelPickerPopup.class.getDeclaredField("popup"); field.setAccessible(true);
            return ((PopupWindow) field.get(picker)).getContentView();
        } catch (Exception error) { throw new AssertionError(error); }
    }

    private void open(boolean dark, boolean empty) {
        getInstrumentation().runOnMainSync(() -> {
            android.widget.LinearLayout fixture = new android.widget.LinearLayout(activity);
            fixture.setOrientation(android.widget.LinearLayout.VERTICAL);
            fixture.setPadding(40, 40, 40, 40); fixture.setBackgroundColor(dark ? 0xff151517 : 0xffffffff);
            android.widget.Button anchor = new android.widget.Button(activity);
            anchor.setText("GPT · 默认"); anchor.setTag("pickerTestAnchor"); fixture.addView(anchor);
            android.widget.TextView content = new android.widget.TextView(activity);
            content.setText("Camellia\n\n今天想一起做点什么？"); content.setTextColor(0xff4176e6);
            content.setTextSize(28); content.setPadding(30, 160, 30, 0); fixture.addView(content);
            activity.setContentView(fixture);
        });
        getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            LocalChatConfig.Route route = new LocalChatConfig.Route("test/gpt", "Example · GPT", "gpt-5", "openai", "https://example.com/v1", "test");
            LocalChatConfig.Route other = new LocalChatConfig.Route("test/other", "Example · Another model", "other", "openai", "https://example.com/v1", "test");
            picker = new ModelPickerPopup(activity, true, dark ? 0xff151517 : 0xffffffff, dark ? 0xff232324 : 0xfff5f6f7,
                dark ? 0xfff9fafb : 0xff0f1115, dark ? 0xffadb2b8 : 0xff61666b, 0xff4176e6,
                empty ? Collections.emptyList() : Arrays.asList(route, other), empty ? null : route, "auto", new ModelPickerPopup.Listener() {
                    public void onModel(LocalChatConfig.Route value) { chosen = value.id; }
                    public void onThinking(String value) { chosen = value; }
                    public void onImport() { chosen = "import"; }
                });
            picker.show(activity.getWindow().getDecorView().findViewWithTag("pickerTestAnchor"));
        });
        getInstrumentation().waitForIdleSync();
    }

    private void screenshot(String name) throws Exception {
        getInstrumentation().waitForIdleSync(); android.os.SystemClock.sleep(250);
        getInstrumentation().getUiAutomation().waitForIdle(250, 4000);
        Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(image);
        try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), name + ".png"))) {
            image.compress(Bitmap.CompressFormat.PNG, 100, output);
        } finally { image.recycle(); }
    }

    public void testRetainsParentAndRestoresNavigation() throws Exception {
        open(false, false);
        screenshot("glass-models");
        View parent = panel().findViewWithTag("modelPickerModels");
        getInstrumentation().runOnMainSync(() -> panel().findViewWithTag("thinkingSettings").performClick());
        getInstrumentation().waitForIdleSync(); screenshot("glass-thinking");
        getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
        getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            assertTrue(picker.isShowing()); assertNull(panel().findViewWithTag("modelPickerThinking"));
            panel().findViewWithTag("thinkingSettings").performClick();
        });
        getInstrumentation().runOnMainSync(() -> {
            assertSame(parent, panel().findViewWithTag("modelPickerModels"));
            assertEquals(.32f, parent.getAlpha());
            assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, parent.getImportantForAccessibility());
            View child = panel().findViewWithTag("modelPickerThinking");
            assertTrue(child.getHeight() > 0); assertTrue(child.getBottom() <= panel().getHeight());
            panel().findViewWithTag("thinkingBack").performClick();
            assertNull(panel().findViewWithTag("modelPickerThinking")); assertEquals(1f, parent.getAlpha());
            assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO, parent.getImportantForAccessibility());
            panel().findViewWithTag("thinkingSettings").performClick();
            panel().dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK));
            panel().dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK));
            assertTrue(picker.isShowing()); assertNull(panel().findViewWithTag("modelPickerThinking"));
            panel().findViewWithTag("thinkingSettings").performClick();
            panel().findViewWithTag("thinkingRetreat").performClick();
            assertNull(panel().findViewWithTag("modelPickerThinking"));
            panel().findViewWithTag("thinkingSettings").performClick();
            panel().findViewWithTag("thinkingOption:high").performClick();
            assertEquals("high", chosen); assertFalse(picker.isShowing());
        });
    }

    public void testDarkAndEmptyFallback() throws Exception {
        open(true, true);
        getInstrumentation().runOnMainSync(() -> panel().findViewWithTag("thinkingSettings").performClick());
        screenshot("glass-dark-empty");
        getInstrumentation().runOnMainSync(() -> {
            assertFalse(panel().findViewWithTag("thinkingOption:high").isEnabled());
            assertTrue(panel().findViewWithTag("thinkingOption:auto").isEnabled());
            panel().findViewWithTag("thinkingBack").performClick();
            panel().findViewWithTag("pickerImport").performClick();
            assertEquals("import", chosen); assertFalse(picker.isShowing());
        });
    }
}
