package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Rect;
import android.test.InstrumentationTestCase;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.PopupWindow;
import android.widget.TextView;
import java.util.Collections;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

public class PopupCoordinatesTest extends InstrumentationTestCase {
    private Activity activity;
    private FrameLayout fixture;
    private View anchor;
    private PopupWindow popup;

    private interface Check { void run() throws Exception; }

    private void ui(Check check) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> {
            try { check.run(); } catch (Throwable error) { failure.set(error); }
        });
        getInstrumentation().waitForIdleSync();
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    @Override protected void setUp() throws Exception {
        super.setUp();
        activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            fixture = new FrameLayout(activity);
            TextView button = new TextView(activity); button.setText("Models");
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(160, 80, Gravity.TOP | Gravity.LEFT);
            params.leftMargin = 90; params.topMargin = 650;
            fixture.addView(button, params); anchor = button; activity.setContentView(fixture);
        });
    }

    @Override protected void tearDown() throws Exception {
        try { ui(() -> { if (popup != null) popup.dismiss(); if (activity != null) activity.finish(); }); }
        finally { super.tearDown(); }
    }

    private PopupWindow popup(Object owner) throws Exception {
        var field = owner.getClass().getDeclaredField("popup"); field.setAccessible(true);
        return (PopupWindow) field.get(owner);
    }

    private void assertCoordinates(String kind) {
        int[] previous = new int[2];
        for (int direction : new int[] {View.LAYOUT_DIRECTION_LTR, View.LAYOUT_DIRECTION_RTL}) {
            ui(() -> { fixture.setLayoutDirection(direction); anchor.setLayoutDirection(direction); });
            ui(() -> {
                assertEquals(direction, anchor.getLayoutDirection());
                if (kind.equals("conversation")) {
                    ConversationMenu menu = new ConversationMenu(anchor, new ChatStyle(activity), false, false,
                        () -> {}, () -> {}, () -> {}, () -> {}, () -> {});
                    popup = popup(menu);
                } else if (kind.equals("local")) {
                    ModelPickerPopup picker = new ModelPickerPopup(activity, false, 0xffffffff, 0xffeeeeee,
                        0xff111111, 0xff666666, 0xff4176e6, Collections.emptyList(), null, "auto", new ModelPickerPopup.Listener() {
                            public void onModel(LocalChatConfig.Route route) { }
                            public void onThinking(String level) { }
                            public void onImport() { }
                        });
                    picker.show(anchor); popup = popup(picker);
                } else {
                    RemoteSettingsPopup picker = new RemoteSettingsPopup(activity, false, 0xffffffff, 0xff111111,
                        0xff666666, 0xff4176e6, new JSONObject(), (key, value) -> {});
                    picker.show(anchor, true); popup = popup(picker);
                }
            });
            ui(() -> {
                View content = popup.getContentView();
                int[] location = new int[2]; content.getLocationOnScreen(location);
                int[] anchorLocation = new int[2]; anchor.getLocationOnScreen(anchorLocation);
                Rect visible = new Rect(); anchor.getWindowVisibleDisplayFrame(visible);
                int margin = Math.round(12 * activity.getResources().getDisplayMetrics().density);
                int expectedLeft = Math.max(visible.left + margin,
                    Math.min(anchorLocation[0], visible.right - popup.getWidth() - margin));
                assertEquals(expectedLeft, location[0]);
                assertTrue(content.getWidth() > 0); assertTrue(content.getHeight() > 0);
                assertTrue(location[0] + content.getWidth() <= visible.right);
                assertTrue(location[1] >= visible.top);
                assertTrue(location[1] + content.getHeight() <= visible.bottom);
                if (direction == View.LAYOUT_DIRECTION_LTR) {
                    previous[0] = location[0]; previous[1] = location[1];
                } else {
                    assertEquals(previous[0], location[0]); assertEquals(previous[1], location[1]);
                }
                popup.dismiss(); popup = null;
            });
        }
    }

    public void testConversationCoordinatesInBothDirections() { assertCoordinates("conversation"); }
    public void testLocalPickerCoordinatesInBothDirections() { assertCoordinates("local"); }
    public void testRemotePickerCoordinatesInBothDirections() { assertCoordinates("remote"); }
}
