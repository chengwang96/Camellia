package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Rect;
import android.test.InstrumentationTestCase;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public class ModelMenuWidthTest extends InstrumentationTestCase {
    private Activity activity;
    private View anchor;
    private Object picker;
    private final String[] sample = {"GPT-6.1-Sol", "deepseek-v4.1-flash:1017", "openclaw/main"};
    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private PopupWindow popup() throws Exception {
        var field = picker.getClass().getDeclaredField("popup"); field.setAccessible(true); return (PopupWindow) field.get(picker);
    }
    @Override protected void setUp() throws Exception {
        super.setUp(); var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false); new CredentialStore(context).clear();
        activity = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            FrameLayout root = new FrameLayout(activity); TextView button = new TextView(activity); button.setText("Model");
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(240, 120, Gravity.BOTTOM | Gravity.RIGHT);
            params.setMargins(0, 0, 40, 40); root.addView(button, params); anchor = button; activity.setContentView(root);
        }); getInstrumentation().waitForIdleSync();
    }
    @Override protected void tearDown() throws Exception {
        ui(() -> { if (picker != null) popup().dismiss(); activity.finish(); }); getInstrumentation().waitForIdleSync(); super.tearDown();
    }
    private int remote(String[] names, int selected) throws Exception {
        JSONArray models = new JSONArray();
        for (String name : names) models.put(new JSONObject().put("id", name).put("name", name).put("connection", "api"));
        JSONObject settings = new JSONObject().put("model", names[selected]).put("connection", "api").put("models", models)
            .put("quickSwitch", new JSONObject().put("available", true).put("model", names[selected]));
        ui(() -> {
            if (picker != null) popup().dismiss();
            var remote = new RemoteSettingsPopup(activity, true, 0xffffffff, 0xff111111, 0xff666666, 0xff4176e6, settings, (key, value) -> {});
            picker = remote; remote.show(anchor, false);
        }); getInstrumentation().waitForIdleSync();
        return popup().getWidth();
    }
    private void assertTitlesFit(View view) {
        if (view instanceof ChatChoiceRow row) {
            TextView title = (TextView) ((LinearLayout) row.getChildAt(0)).getChildAt(0);
            assertNotNull(title.getLayout());
            assertEquals("Ordinary model titles must remain readable: " + title.getText(), 0, title.getLayout().getEllipsisCount(0));
        }
        if (view instanceof ViewGroup group) for (int index = 0; index < group.getChildCount(); index++) assertTitlesFit(group.getChildAt(index));
    }
    public void testShortMenusShrinkAndOrdinaryLongestNameFits() throws Exception {
        int shortWidth = remote(new String[]{"GPT", "Mini"}, 0);
        int sampleWidth = remote(sample, 1);
        assertTrue("Short labels must not reserve a wide fixed panel", shortWidth < sampleWidth);
        ui(() -> {
            assertTrue("The screenshot's model list should fit a compact menu", popup().getWidth() < 310 * activity.getResources().getDisplayMetrics().density);
            assertTitlesFit(popup().getContentView());
        });
    }
    public void testSelectingTheLongestModelDoesNotChangeMenuWidth() throws Exception {
        assertEquals(remote(sample, 0), remote(sample, 1));
        ui(() -> assertTitlesFit(popup().getContentView()));
    }
    public void testLongNamesStayWithinTheWindowAndRetainFullTooltip() throws Exception {
        String longName = "long-model-name/".repeat(12); remote(new String[]{longName}, 0);
        ui(() -> {
            PopupWindow popup = popup(); Rect visible = PopupSurface.visibleFrame(anchor);
            int[] point = new int[2]; popup.getContentView().getLocationOnScreen(point);
            assertTrue(popup.getWidth() <= Math.round(340 * activity.getResources().getDisplayMetrics().density));
            assertTrue(point[0] >= visible.left); assertTrue(point[0] + popup.getWidth() <= visible.right);
            View option = popup.getContentView().findViewWithTag("remoteModelOption:" + longName);
            assertTrue(option.getTooltipText().toString().contains(longName));
        });
    }
    public void testLocalAndRemoteUseTheSameCompactSizing() throws Exception {
        int remoteWidth = remote(sample, 1);
        ui(() -> {
            popup().dismiss(); List<LocalChatConfig.Route> routes = new ArrayList<>();
            for (String name : sample) routes.add(new LocalChatConfig.Route(name, "API · " + name, name, "openai", "https://example.test/v1", "test"));
            var local = new ModelPickerPopup(activity, true, 0xffffffff, 0xffeeeeee, 0xff111111, 0xff666666, 0xff4176e6,
                routes, routes.get(1), "auto", new ModelPickerPopup.Listener() {
                    @Override public void onModel(LocalChatConfig.Route route) { }
                    @Override public void onThinking(String level) { }
                    @Override public void onImport() { }
                });
            picker = local; local.show(anchor); assertEquals(remoteWidth, popup().getWidth());
        }); getInstrumentation().waitForIdleSync();
        ui(() -> assertTitlesFit(popup().getContentView()));
    }
}
