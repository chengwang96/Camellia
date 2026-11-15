package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.SystemClock;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Run by check-android-modern-screens.ps1 at real modern phone aspect ratios. */
public class ModernSettingsLayoutTest extends InstrumentationTestCase {
    private Activity activity;
    private String previousTheme, previousLanguage;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        previousTheme = MobilePreferences.get(context, "theme");
        previousLanguage = MobilePreferences.get(context, "language");
    }
    @Override protected void tearDown() throws Exception {
        if (activity != null) ui(activity::finish);
        var context = getInstrumentation().getTargetContext();
        MobilePreferences.set(context, "theme", previousTheme);
        MobilePreferences.set(context, "language", previousLanguage);
        super.tearDown();
    }

    public void testGeneralSettingsTailAndEdgeOnCurrentViewport() throws Exception {
        var context = getInstrumentation().getTargetContext();
        for (String theme : new String[] {"light", "dark"}) {
            if (activity != null) { ui(activity::finish); activity = null; }
            MobilePreferences.set(context, "theme", theme);
            MobilePreferences.set(context, "language", theme.equals("light") ? "zh-CN" : "en");
            activity = LocalChatFixture.start(getInstrumentation(), new Intent(context, SettingsActivity.class)
                .putExtra("section", "general").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            for (int i = 0; i < 100; i++) {
                boolean[] ready = {false};
                ui(() -> ready[0] = root().findViewWithTag("preference:remoteKeepAlive") != null);
                if (ready[0]) break;
                SystemClock.sleep(25);
            }
            ui(() -> {
                assertNotNull(root().findViewWithTag("preference:remoteKeepAlive"));
                scroll().setSmoothScrollingEnabled(false);
                scroll().fullScroll(View.FOCUS_DOWN);
            });
            SystemClock.sleep(100);
            ui(() -> {
                ScrollView scroll = scroll(); View viewport = root().findViewWithTag("settingsViewport");
                View page = (View) viewport.getParent();
                assertEquals("Settings must not reserve an opaque footer outside scrolling content", 0, page.getPaddingBottom());
                assertEquals("The settings body must reach the actual window bottom", page.getHeight(), viewport.getBottom());
                LinearLayout content = (LinearLayout) scroll.getChildAt(0);
                TextView note = (TextView) content.getChildAt(content.getChildCount() - 1);
                android.graphics.Rect visible = new android.graphics.Rect();
                assertTrue("The final explanatory note is reachable", note.getGlobalVisibleRect(visible));
                assertEquals("Every line of the final note is visible after scrolling to the end", note.getHeight(), visible.height());
                int[] noteOrigin = new int[2], viewOrigin = new int[2];
                note.getLocationOnScreen(noteOrigin); scroll.getLocationOnScreen(viewOrigin);
                assertTrue("The note clears the real bottom inset", noteOrigin[1] + note.getHeight()
                    <= viewOrigin[1] + scroll.getHeight() - scroll.getPaddingBottom());
                assertTrue("Bottom clearance lives inside the scrolling area", scroll.getPaddingBottom() >= dp(20));
                assertEquals(Color.TRANSPARENT, activity.getWindow().getNavigationBarColor());
                System.out.println("MODERN SETTINGS: " + activity.getResources().getDisplayMetrics().widthPixels
                    + "x" + activity.getResources().getDisplayMetrics().heightPixels
                    + " widthDp=" + activity.getResources().getConfiguration().screenWidthDp
                    + " font=" + activity.getResources().getConfiguration().fontScale
                    + " theme=" + theme + " lastNote=" + visible + " internalBottom=" + scroll.getPaddingBottom());
            });
            capture("general-bottom-" + theme);
            // Reproduce a line crossing the old opaque-footer boundary, rather
            // than only checking a comfortable scroll-to-bottom resting state.
            ui(() -> {
                ScrollView scroll = scroll(); LinearLayout content = (LinearLayout) scroll.getChildAt(0);
                content.removeAllViews();
                View probe = new View(activity); probe.setBackgroundColor(Color.BLUE);
                content.addView(probe, new LinearLayout.LayoutParams(-1, dp(3000)));
                scroll.scrollTo(0, dp(100));
            });
            SystemClock.sleep(100);
            ui(() -> {
                View viewport = root().findViewWithTag("settingsViewport"), page = (View) viewport.getParent();
                Bitmap frame = Bitmap.createBitmap(page.getWidth(), page.getHeight(), Bitmap.Config.ARGB_8888);
                try {
                    page.draw(new Canvas(frame));
                    assertEquals("Content continues through the old footer strip to the physical bottom",
                        Color.BLUE, frame.getPixel(frame.getWidth() / 2, frame.getHeight() - 2));
                } finally { frame.recycle(); }
            });
        }
    }

    private View root() { return activity.getWindow().getDecorView(); }
    private ScrollView scroll() { return root().findViewWithTag("settingsScroll"); }
    private int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
    private void capture(String name) throws Exception {
        Bitmap frame = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(frame);
        var config = activity.getResources().getConfiguration();
        var display = activity.getResources().getDisplayMetrics();
        String filename = name + "-" + display.widthPixels + "x" + display.heightPixels + "-fs" + config.fontScale + ".png";
        java.io.File directory = new java.io.File(activity.getExternalFilesDir(null), "modern-settings-visuals");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        try (var output = new java.io.FileOutputStream(new java.io.File(directory, filename))) {
            assertTrue(frame.compress(Bitmap.CompressFormat.PNG, 100, output));
        } finally { frame.recycle(); }
    }
    private interface Checked { void run() throws Exception; }
    private void ui(Checked check) {
        LocalChatFixture.idle(getInstrumentation());
        var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable error) { failure.set(error); } });
        LocalChatFixture.idle(getInstrumentation());
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
}
