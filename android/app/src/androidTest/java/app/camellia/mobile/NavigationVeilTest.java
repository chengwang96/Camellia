package app.camellia.mobile;

import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.os.SystemClock;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;

/** Checks the region outside the capsule and the very bottom, on production pages. */
public class NavigationVeilTest extends InstrumentationTestCase {
    private MainActivity activity;
    private String previousTheme;
    private String previousLanguage;
    private static final int PAGE_COLOR = 0xff2860b0;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        new CredentialStore(context).clear();
        previousTheme = MobilePreferences.get(context, "theme");
        previousLanguage = MobilePreferences.get(context, "language");
    }

    @Override protected void tearDown() throws Exception {
        if (activity != null) ui(activity::finish);
        MobilePreferences.set(getInstrumentation().getTargetContext(), "theme", previousTheme);
        MobilePreferences.set(getInstrumentation().getTargetContext(), "language", previousLanguage);
        new CredentialStore(getInstrumentation().getTargetContext()).clear();
        super.tearDown();
    }

    private void launch(String theme) throws Exception {
        if (activity != null) ui(activity::finish);
        MobilePreferences.set(getInstrumentation().getTargetContext(), "theme", theme);
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(
            getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        SystemClock.sleep(250); getInstrumentation().waitForIdleSync();
    }

    public void testWholeBottomFadesIntoFrostAndRemainsTranslucentToScreenEdge() throws Exception {
        for (String theme : new String[] {"light", "dark"}) {
            launch(theme);
            ui(() -> {
                invoke("stopNetwork");
                LinearLayout content = (LinearLayout) field("content");
                content.removeAllViews();
                View color = new View(activity); color.setBackgroundColor(PAGE_COLOR);
                content.addView(color, new LinearLayout.LayoutParams(-1, dp(2000)));
            });
            SystemClock.sleep(200); getInstrumentation().waitForIdleSync();
            ui(() -> {
                LinearLayout root = (LinearLayout) field("root");
                View bar = root.findViewWithTag("workbenchNav");
                View veil = root.findViewWithTag("navigationVeil");
                ScrollView scroll = (ScrollView) field("scroll");
                int[] edge = new int[2]; veil.getLocationInWindow(edge);
                int[] page = new int[2]; root.getLocationInWindow(page);
                assertEquals("Material spans the entire screen width", root.getWidth(), veil.getWidth());
                assertEquals("No clear gutter at the side of the bottom material", page[0], edge[0]);
                assertEquals("No opaque strip may follow the scroll viewport", 0, root.getPaddingBottom());
                assertEquals("Scrolling content continues to the bottom", root.getHeight(),
                    ((View) scroll.getParent()).getBottom());
                assertEquals("The material includes the complete bottom inset", page[1] + root.getHeight(), edge[1] + veil.getHeight());
                assertEquals(Color.TRANSPARENT, activity.getWindow().getNavigationBarColor());
                if (android.os.Build.VERSION.SDK_INT >= 29) assertFalse(activity.getWindow().isNavigationBarContrastEnforced());
                Bitmap pixels = Bitmap.createBitmap(root.getWidth(), root.getHeight(), Bitmap.Config.ARGB_8888);
                try {
                    root.draw(new Canvas(pixels));
                    int x = dp(24), top = edge[1] - page[1];
                    int original = pixels.getPixel(x, top - dp(3));
                    int first = pixels.getPixel(x, top + dp(2));
                    int middle = pixels.getPixel(x, top + dp(NavigationDockLayout.FADE_HEIGHT_DP * 2 / 3));
                    int bottom = pixels.getPixel(x, pixels.getHeight() - dp(2));
                    int base = Palette.of(activity).background;
                    System.out.println("VEIL " + theme + " page=" + root.getWidth() + "x" + root.getHeight()
                        + " material=" + veil.getWidth() + "x" + veil.getHeight() + " y=" + top
                        + " original=" + Integer.toHexString(original) + " first=" + Integer.toHexString(first)
                        + " middle=" + Integer.toHexString(middle) + " bottom=" + Integer.toHexString(bottom)
                        + " base=" + Integer.toHexString(base));
                    var snapshotField = PopupSurface.class.getDeclaredField("snapshot"); snapshotField.setAccessible(true);
                    Bitmap snapshot = (Bitmap) snapshotField.get(veil);
                    System.out.println("VEIL raw lower pixel=" + Integer.toHexString(snapshot.getPixel(snapshot.getWidth() / 2, snapshot.getHeight() - 2)));
                    try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), "veil-pixels-" + theme + ".png"))) {
                        pixels.compress(Bitmap.CompressFormat.PNG, 100, output);
                    }
                    assertTrue("Fixture must put actual content below the veil", distance(original, PAGE_COLOR) <= 3);
                    assertTrue("The veil starts without a hard edge", distance(original, first) < 12);
                    assertTrue("Above the buttons the page already becomes frosted", distance(original, middle) > 15);
                    assertTrue("Bottom is veiled, rather than fully clear", distance(original, bottom) > 30);
                    assertTrue("Bottom still shows the page rather than an opaque fill", distance(base, bottom) > 14);
                } finally { pixels.recycle(); }
            });
            capture("full-bottom-" + theme);
        }
    }

    public void testFourDestinationsKeepLastActionAboveBarWithBottomInsets() throws Exception {
        launch("light");
        for (String destination : new String[] {"homeScreen", "listScreen", "computersScreen", "settingsScreen"}) {
            ui(() -> {
                invoke(destination); invoke("stopNetwork");
                ((PageTransitions) field("pages")).finishTransition();
                LinearLayout content = (LinearLayout) field("content"); content.removeAllViews();
                View filler = new View(activity); filler.setBackgroundColor(PAGE_COLOR);
                content.addView(filler, new LinearLayout.LayoutParams(-1, dp(1600)));
                View last = new View(activity); last.setTag("lastNavigationAction");
                content.addView(last, new LinearLayout.LayoutParams(-1, dp(48)));
            });
            SystemClock.sleep(100);
            for (int bottomDp : new int[] {0, 24, 48}) {
                ui(() -> {
                    View root = (View) field("root");
                    android.view.WindowInsets insets = root.getRootWindowInsets(); assertNotNull(insets);
                    root.dispatchApplyWindowInsets(insets.replaceSystemWindowInsets(0, insets.getSystemWindowInsetTop(), 0, dp(bottomDp)));
                });
                SystemClock.sleep(80);
                ui(() -> ((ScrollView) field("scroll")).fullScroll(View.FOCUS_DOWN));
                SystemClock.sleep(80);
                ui(() -> {
                    View root = (View) field("root"), bar = root.findViewWithTag("workbenchNav"), last = root.findViewWithTag("lastNavigationAction");
                    int[] barOrigin = new int[2], lastOrigin = new int[2];
                    bar.getLocationInWindow(barOrigin); last.getLocationInWindow(lastOrigin);
                    assertTrue(destination + " final action clears the buttons", lastOrigin[1] + last.getHeight() <= barOrigin[1] - dp(8));
                });
            }
        }
    }

    public void testCaptureScrollingSessionsAcrossEntireBottom() throws Exception {
        var context = getInstrumentation().getTargetContext();
        var computer = new org.json.JSONObject().put("address", "http://100.64.0.10:43127")
            .put("token", "v".repeat(43)).put("deviceId", "navigation-veil-fixture").put("computerName", "HP");
        var rows = new org.json.JSONArray();
        String[] titles = {"调整底部导航的渐变磨砂", "检查工作区更改并生成提交信息", "移动端额度用量展示与入口讨论", "实时任务 Codex", "实时任务 Kimi"};
        for (int index = 0; index < 18; index++) rows.put(new org.json.JSONObject()
            .put("id", "veil-row-" + index).put("title", titles[index % titles.length])
            .put("currentEngine", index % 5 == 4 ? "kimi" : "codex").put("activity", "idle")
            .put("workspaceId", "main").put("workspaceName", "Camellia")
            .put("updatedAt", System.currentTimeMillis() - index * 60_000));
        try {
            MobilePreferences.set(context, "language", "zh-CN");
            for (String theme : new String[] {"light", "dark"}) {
                new ComputerStore(new CredentialStore(context)).save(computer);
                RemoteListCache.get(context).put(computer, rows, -1,
                    new org.json.JSONArray().put(new org.json.JSONObject().put("id", "main").put("name", "Camellia")), true);
                launch(theme);
                ui(() -> {
                    invoke("listScreen"); invoke("stopNetwork");
                    ((PageTransitions) field("pages")).finishTransition();
                });
                SystemClock.sleep(200);
                ui(() -> ((ScrollView) field("scroll")).scrollTo(0, dp(110)));
                SystemClock.sleep(200);
                capture("sessions-" + theme);
            }
        } finally { RemoteListCache.get(context).remove(computer); }
    }

    private void capture(String name) throws Exception {
        Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot();
        java.io.File directory = new java.io.File(activity.getExternalFilesDir(null), "navigation-veil-visuals");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        try (var output = new java.io.FileOutputStream(new java.io.File(directory, name + ".png"))) {
            assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, output));
        } finally { image.recycle(); }
    }
    private int distance(int a, int b) { return Math.max(Math.abs(Color.red(a) - Color.red(b)), Math.max(Math.abs(Color.green(a) - Color.green(b)), Math.abs(Color.blue(a) - Color.blue(b)))); }
    private int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
    private Object field(String name) throws Exception { var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); return member.get(activity); }
    private void invoke(String name) throws Exception { var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity); }
    private interface Checked { void run() throws Exception; }
    private void ui(Checked check) {
        getInstrumentation().waitForIdleSync();
        var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable error) { failure.set(error); } });
        getInstrumentation().waitForIdleSync();
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
}
