package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.SystemClock;
import android.test.InstrumentationTestCase;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.widget.Switch;

/** Exercises real touch feedback, including the frames between pointer down and release. */
public class SettingsFeedbackTest extends InstrumentationTestCase {
    private Activity activity;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        LocalChatFixture.clear(context);
        context.getSharedPreferences("mobile-preferences", 0).edit().clear().commit();
    }

    @Override protected void tearDown() throws Exception {
        if (activity != null) ui(activity::finish);
        var context = getInstrumentation().getTargetContext();
        LocalChatFixture.clear(context);
        context.getSharedPreferences("mobile-preferences", 0).edit().clear().commit();
        super.tearDown();
    }

    public void testSwitchFeedbackStaysInsideTrackAndClearsOnRelease() throws Exception {
        for (String theme : new String[] {"light", "dark"}) {
            launch(theme);
            for (boolean checked : new boolean[] {false, true}) {
                Switch toggle = toggle();
                ui(() -> { toggle.setChecked(checked); toggle.jumpDrawablesToCurrentState(); });
                SystemClock.sleep(350);
                Rect area = bounds(toggle);
                Bitmap before = capture(theme + "-" + checked + "-idle");
                long down = SystemClock.uptimeMillis();
                float x = area.centerX() + dp(checked ? 10 : -10), y = area.exactCenterY();
                pointer(down, MotionEvent.ACTION_DOWN, x, y);
                SystemClock.sleep(250);
                Bitmap pressed = capture(theme + "-" + checked + "-pressed");
                pointer(down, MotionEvent.ACTION_UP, x, y);
                SystemClock.sleep(500);
                Bitmap released = capture(theme + "-" + checked + "-released");
                try {
                    int pressLeaks = outsideTrackDifferences(before, pressed, area);
                    int releaseLeaks = outsideTrackDifferences(before, released, area);
                    System.out.println("SWITCH FEEDBACK " + theme + " checked=" + checked
                        + " pressedOutside=" + pressLeaks + " releasedOutside=" + releaseLeaks);
                    assertEquals("A press must not add the platform halo outside the custom track", 0, pressLeaks);
                    assertEquals("Release must not leave a highlight outside the track", 0, releaseLeaks);
                    ui(() -> assertEquals("A real tap changes the setting once", !checked, toggle.isChecked()));
                } finally { before.recycle(); pressed.recycle(); released.recycle(); }
            }
            ui(activity::finish); activity = null;
        }
    }

    public void testSwitchDragCancelAndDisabledRow() throws Exception {
        launch("light");
        Switch toggle = toggle();
        ui(() -> { toggle.setChecked(false); toggle.jumpDrawablesToCurrentState(); });
        SystemClock.sleep(350); // Let the initial drawable state reach the compositor before the baseline frame.
        Rect area = bounds(toggle);
        Bitmap beforeDrag = capture("drag-idle");
        long down = SystemClock.uptimeMillis();
        float startX = area.centerX() - dp(10);
        float dragStartX = startX + ViewConfiguration.get(activity).getScaledTouchSlop() + dp(2);
        float endX = dragStartX + dp(24);
        pointer(down, MotionEvent.ACTION_DOWN, startX, area.exactCenterY());
        // Enter the native drag state before measuring thumb travel. A slow
        // renderer can coalesce the intermediate moves used to cross slop.
        pointer(down, MotionEvent.ACTION_MOVE, dragStartX, area.exactCenterY());
        getInstrumentation().waitForIdleSync();
        for (int step = 1; step <= 8; step++) {
            SystemClock.sleep(25);
            pointer(down, MotionEvent.ACTION_MOVE, dragStartX + dp(24) * step / 8f, area.exactCenterY());
        }
        Bitmap dragging = captureDraggedThumb(beforeDrag, area);
        pointer(down, MotionEvent.ACTION_UP, endX, area.exactCenterY());
        try {
            System.out.println("THUMB DRAG before=" + thumbCenter(beforeDrag, area) + " during=" + thumbCenter(dragging, area));
            assertTrue("The visible thumb follows a drag before release",
                thumbCenter(dragging, area) - thumbCenter(beforeDrag, area) > dp(8));
        } finally { beforeDrag.recycle(); dragging.recycle(); }
        SystemClock.sleep(350);
        ui(() -> assertTrue("Dragging the visible thumb turns the switch on", toggle.isChecked()));

        down = SystemClock.uptimeMillis();
        pointer(down, MotionEvent.ACTION_DOWN, area.centerX() + dp(10), area.exactCenterY());
        pointer(down, MotionEvent.ACTION_CANCEL, area.centerX() + dp(10), area.exactCenterY());
        SystemClock.sleep(350);
        ui(() -> {
            assertTrue("Cancelling a press must not toggle the setting", toggle.isChecked());
            assertFalse("Cancelled presses are released", toggle.isPressed());
            View row = (View) toggle.getParent();
            toggle.setEnabled(false); row.performClick();
            assertTrue("The label must not change a disabled switch", toggle.isChecked());
            toggle.setEnabled(true); row.performClick();
            assertFalse("The whole row still operates an enabled switch", toggle.isChecked());
            assertFalse(MobilePreferences.get(activity, "notify:error").equals("enabled"));
        });
    }

    public void testWholeRowPressAndScrollCancellation() throws Exception {
        launch("light");
        Switch toggle = toggle();
        View row = (View) toggle.getParent();
        Rect rowArea = bounds(row), area = bounds(toggle);
        ui(() -> { toggle.setChecked(true); toggle.jumpDrawablesToCurrentState(); });
        SystemClock.sleep(350);
        Bitmap before = capture("row-idle");
        long down = SystemClock.uptimeMillis();
        float x = rowArea.left + dp(35), y = rowArea.exactCenterY();
        pointer(down, MotionEvent.ACTION_DOWN, x, y);
        SystemClock.sleep(250);
        boolean[] pressed = {false}; ui(() -> pressed[0] = toggle.isPressed());
        Bitmap held = capture("row-pressed");
        pointer(down, MotionEvent.ACTION_UP, x, y);
        SystemClock.sleep(500);
        Bitmap released = capture("row-released");
        try {
            assertTrue("Tapping the label gives the same contained press feedback", pressed[0]);
            assertEquals(0, outsideTrackDifferences(before, held, area));
            assertEquals(0, outsideTrackDifferences(before, released, area));
            ui(() -> { assertFalse(toggle.isChecked()); assertFalse(toggle.isPressed()); });
        } finally { before.recycle(); held.recycle(); released.recycle(); }

        down = SystemClock.uptimeMillis();
        pointer(down, MotionEvent.ACTION_DOWN, x, y);
        for (int step = 1; step <= 6; step++) {
            SystemClock.sleep(30);
            pointer(down, MotionEvent.ACTION_MOVE, x, y - dp(120) * step / 6f);
        }
        pointer(down, MotionEvent.ACTION_UP, x, y - dp(120));
        SystemClock.sleep(350);
        ui(() -> {
            assertFalse("Scrolling from a settings row must not change it", toggle.isChecked());
            assertFalse("Scrolling cancels the row's press feedback", toggle.isPressed());
        });
    }

    private void launch(String theme) throws Exception {
        var context = getInstrumentation().getTargetContext();
        MobilePreferences.set(context, "theme", theme); MobilePreferences.set(context, "language", "zh-CN");
        activity = LocalChatFixture.start(getInstrumentation(), new Intent(context, SettingsActivity.class)
            .putExtra("section", "notifications").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        for (int i = 0; i < 100; i++) {
            boolean[] ready = {false}; ui(() -> ready[0] = toggle() != null);
            if (ready[0]) break;
            SystemClock.sleep(25);
        }
        assertNotNull(toggle());
        SystemClock.sleep(350);
    }

    private Switch toggle() { return activity.getWindow().getDecorView().findViewWithTag("preference:notify:error"); }
    private int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
    private Rect bounds(View view) {
        Rect result = new Rect(); ui(() -> assertTrue(view.getGlobalVisibleRect(result))); return result;
    }
    private void pointer(long down, int action, float x, float y) {
        MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, 0);
        try { getInstrumentation().sendPointerSync(event); } finally { event.recycle(); }
    }
    private int outsideTrackDifferences(Bitmap before, Bitmap after, Rect area) {
        int count = 0;
        for (int y = area.top - dp(8); y < area.bottom + dp(8); y++) for (int x = area.left - dp(8); x < area.right + dp(8); x++) {
            if (Math.abs(x - area.centerX()) <= dp(26) && Math.abs(y - area.centerY()) <= dp(16)) continue;
            if (before.getPixel(x, y) != after.getPixel(x, y)) count++;
        }
        return count;
    }
    private float thumbCenter(Bitmap frame, Rect area) {
        long sum = 0; int count = 0;
        for (int y = area.centerY() - dp(6); y < area.centerY() + dp(6); y++)
            for (int x = area.centerX() - dp(22); x < area.centerX() + dp(22); x++) {
                int color = frame.getPixel(x, y);
                if (android.graphics.Color.red(color) > 235 && android.graphics.Color.green(color) > 235
                        && android.graphics.Color.blue(color) > 235) { sum += x; count++; }
            }
        assertTrue("The thumb is visible in the drag frame", count > 0);
        return sum / (float) count;
    }
    private Bitmap captureDraggedThumb(Bitmap before, Rect area) throws Exception {
        float initial = thumbCenter(before, area);
        long deadline = SystemClock.uptimeMillis() + 3000;
        Bitmap frame;
        do {
            getInstrumentation().waitForIdleSync();
            frame = capture("drag-before-release");
            if (thumbCenter(frame, area) - initial > dp(8) || SystemClock.uptimeMillis() >= deadline) return frame;
            frame.recycle();
            SystemClock.sleep(50);
        } while (true);
    }
    private Bitmap capture(String name) throws Exception {
        Bitmap bitmap = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(bitmap);
        java.io.File directory = new java.io.File(activity.getExternalFilesDir(null), "settings-feedback-visuals");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        try (var output = new java.io.FileOutputStream(new java.io.File(directory, name + ".png"))) {
            assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output));
        }
        return bitmap;
    }
    private interface Checked { void run() throws Exception; }
    private void ui(Checked action) {
        LocalChatFixture.idle(getInstrumentation());
        var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } });
        LocalChatFixture.idle(getInstrumentation());
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
}
