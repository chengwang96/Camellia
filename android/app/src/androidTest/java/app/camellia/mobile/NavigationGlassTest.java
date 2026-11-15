package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.os.PowerManager;
import android.os.SystemClock;
import android.test.InstrumentationTestCase;
import android.view.ContextThemeWrapper;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ScrollView;

/** Real backdrop pixels, scroll alignment, idle cost and power-mode lifecycle. */
public class NavigationGlassTest extends InstrumentationTestCase {
    private Activity activity;
    private ScrollView scroll;
    private Bands bands;
    private WorkbenchNavigation navigation;
    private PopupSurface glass;

    @Override protected void setUp() throws Exception {
        super.setUp();
        activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(),
            PopupTestActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    @Override protected void tearDown() throws Exception {
        if (activity != null) ui(activity::finish);
        super.tearDown();
    }

    private final class Bands extends View {
        final Paint paint = new Paint();
        int draws, stripeHeight, first = Color.RED;
        Bands(android.content.Context context) { super(context); }
        @Override protected void onDraw(Canvas canvas) {
            draws++;
            for (int i = 0; i < 3; i++) {
                paint.setColor(i == 0 ? first : i == 1 ? Color.BLUE : Color.GREEN);
                canvas.drawRect(0, i * stripeHeight, getWidth(), (i + 1) * stripeHeight, paint);
            }
        }
    }

    private void mount(boolean dark) throws Exception {
        ui(() -> {
            ContextThemeWrapper context = new ContextThemeWrapper(activity, android.R.style.Theme_Material_Light_NoActionBar);
            Configuration configuration = new Configuration(activity.getResources().getConfiguration());
            configuration.uiMode = (configuration.uiMode & ~Configuration.UI_MODE_NIGHT_MASK)
                | (dark ? Configuration.UI_MODE_NIGHT_YES : Configuration.UI_MODE_NIGHT_NO);
            context.applyOverrideConfiguration(configuration);
            FrameLayout stage = new FrameLayout(context);
            stage.setBackgroundColor(dark ? Color.BLACK : Color.WHITE);
            scroll = new ScrollView(context); scroll.setFillViewport(true); scroll.setClipToPadding(false);
            scroll.setPadding(0, 0, 0, dp(WorkbenchNavigation.HEIGHT_DP + WorkbenchNavigation.CONTENT_GAP_DP));
            stage.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
            bands = new Bands(context);
            scroll.addView(bands, new ScrollView.LayoutParams(-1, 10000));
            navigation = new WorkbenchNavigation(context, "home", () -> {}, () -> {}, () -> {}, () -> {});
            stage.addView(navigation, new FrameLayout.LayoutParams(dp(300), dp(64), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL));
            navigation.setBackdropSource(scroll);
            activity.setContentView(stage);
        });
        SystemClock.sleep(150);
        ui(() -> {
            assertTrue("Fixture must have a laid out viewport", scroll.getHeight() > dp(100));
            bands.stripeHeight = scroll.getHeight();
            bands.setMinimumHeight(bands.stripeHeight * 3);
            bands.invalidate();
            glass = (PopupSurface) navigation.getChildAt(0);
        });
        SystemClock.sleep(150);
        getInstrumentation().waitForIdleSync();
    }

    public void testBackdropTracksScrollAndContentWithoutAnIdleRedrawLoop() throws Exception {
        assertFalse(activity.getSystemService(PowerManager.class).isPowerSaveMode());
        for (boolean dark : new boolean[] {false, true}) {
            mount(dark);
            awaitColor(Color.RED);
            int[] idleDraws = new int[1];
            ui(() -> idleDraws[0] = bands.draws);
            SystemClock.sleep(350);
            ui(() -> assertEquals("Idle glass must not schedule continuous page captures", idleDraws[0], bands.draws));
            ui(() -> scroll.scrollTo(0, bands.stripeHeight));
            awaitColor(Color.BLUE);
            screenshot("navigation-glass-" + (dark ? "dark" : "light") + "-scrolled");
            ui(() -> scroll.scrollTo(0, 0));
            awaitColor(Color.RED);
            ui(() -> { bands.first = Color.MAGENTA; bands.invalidate(); });
            awaitColor(Color.MAGENTA);
            ui(() -> {
                View selected = navigation.findViewWithTag("nav:home");
                assertTrue(selected.isSelected());
                assertEquals(1f, selected.getAlpha(), 0f);
                assertEquals(1f, navigation.getAlpha(), 0f);
            });
        }
    }

    public void testNavigationReleasesAndRestoresBackdropInPowerSaver() throws Exception {
        assertTrue("Requires disposable emulator", android.os.Build.HARDWARE.equals("ranchu")
            || android.os.Build.HARDWARE.equals("goldfish"));
        shell("dumpsys battery unplug");
        try {
            powerSave(false);
            mount(false); awaitColor(Color.RED);
            Bitmap previous = (Bitmap) field(glass, "snapshot");
            powerSave(true);
            ui(() -> {
                assertNull(glass.findViewWithTag("glassBackdrop"));
                assertNull(field(glass, "snapshot"));
                assertNull(field(glass, "sourceObserver"));
                assertTrue(previous.isRecycled());
            });
            powerSave(false); awaitColor(Color.RED);
            ui(() -> {
                assertNotSame(previous, field(glass, "snapshot"));
                activity.setContentView(new View(activity));
                assertNull(field(glass, "snapshot"));
                assertNull(field(glass, "sourceObserver"));
                assertNull(field(glass, "powerReceiver"));
            });
        } finally {
            powerSave(false);
            shell("dumpsys battery reset");
        }
    }

    private void awaitColor(int expected) throws Exception {
        int[] actual = {0};
        for (int attempt = 0; attempt < 60; attempt++) {
            ui(() -> {
                Bitmap snapshot = (Bitmap) field(glass, "snapshot");
                if (snapshot != null) actual[0] = snapshot.getPixel(snapshot.getWidth() / 2, snapshot.getHeight() / 2);
            });
            if (actual[0] == expected) return;
            SystemClock.sleep(25);
        }
        screenshot("navigation-glass-unexpected-pixels");
        ui(() -> {
            int[] position = new int[2]; navigation.getLocationOnScreen(position);
            System.out.println("GLASS geometry: scroll=" + scroll.getWidth() + "x" + scroll.getHeight()
                + " bands=" + bands.getWidth() + "x" + bands.getHeight() + " stripe=" + bands.stripeHeight
                + " draws=" + bands.draws + " scrollY=" + scroll.getScrollY()
                + " barY=" + position[1] + " sampleY=" + field(glass, "sampleTop"));
        });
        assertEquals("Glass must sample the content directly under it at the current scroll offset", expected, actual[0]);
    }

    private void powerSave(boolean enabled) throws Exception {
        shell("cmd power set-mode " + (enabled ? "1" : "0"));
        PowerManager power = activity.getSystemService(PowerManager.class);
        for (int i = 0; i < 100 && power.isPowerSaveMode() != enabled; i++) SystemClock.sleep(25);
        assertEquals(enabled, power.isPowerSaveMode());
        SystemClock.sleep(100);
        getInstrumentation().waitForIdleSync();
    }

    private void shell(String command) throws Exception {
        try (var output = new android.os.ParcelFileDescriptor.AutoCloseInputStream(
                getInstrumentation().getUiAutomation().executeShellCommand(command))) { while (output.read() != -1) {} }
    }

    private Object field(Object object, String name) throws Exception {
        var member = object.getClass().getDeclaredField(name); member.setAccessible(true); return member.get(object);
    }

    private void screenshot(String name) throws Exception {
        Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot();
        java.io.File directory = new java.io.File(activity.getExternalFilesDir(null), "navigation-glass-visuals");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        try (var output = new java.io.FileOutputStream(new java.io.File(directory, name + ".png"))) {
            assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, output));
        } finally { image.recycle(); }
    }

    private int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
    private interface Checked { void run() throws Exception; }
    private void ui(Checked check) {
        getInstrumentation().waitForIdleSync();
        var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable error) { failure.set(error); } });
        getInstrumentation().waitForIdleSync();
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
}
