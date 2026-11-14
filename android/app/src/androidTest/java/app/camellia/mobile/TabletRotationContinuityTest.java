package app.camellia.mobile;

import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.EditText;
import org.json.JSONArray;
import org.json.JSONObject;

/** Rotation must relayout the tablet UI without tearing down the live computer session. */
public class TabletRotationContinuityTest extends InstrumentationTestCase {
    private MainActivity activity;
    private String previousLanguage, previousTheme;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context);
        EmbeddedNetwork.setEnabled(false);
        new CredentialStore(context).clear();
        previousLanguage = MobilePreferences.get(context, "language");
        previousTheme = MobilePreferences.get(context, "theme");
        MobilePreferences.set(context, "language", "zh-CN");
        MobilePreferences.set(context, "theme", "light");
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().waitForIdleSync();
    }

    @Override protected void tearDown() throws Exception {
        if (activity != null) {
            getInstrumentation().runOnMainSync(() -> {
                try { activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED); }
                catch (RuntimeException ignored) { }
                activity.finish();
            });
            getInstrumentation().waitForIdleSync();
        }
        var context = getInstrumentation().getTargetContext();
        RemoteListCache.get(context).remove(new JSONObject().put("address", "http://100.80.1.7:43127")
            .put("token", "a".repeat(43)));
        new CredentialStore(context).clear();
        MobilePreferences.set(context, "language", previousLanguage);
        MobilePreferences.set(context, "theme", previousTheme);
        super.tearDown();
    }

    public void testTabletRotationKeepsTheSameConnectionOwner() throws Exception {
        if (!tabletWindow()) return;
        ActivityInfo info = activity.getPackageManager().getActivityInfo(activity.getComponentName(), 0);
        assertTrue("MainActivity must own orientation changes",
            (info.configChanges & ActivityInfo.CONFIG_ORIENTATION) != 0);
        assertTrue("MainActivity must own screen-size changes",
            (info.configChanges & ActivityInfo.CONFIG_SCREEN_SIZE) != 0);

        rotate(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        JSONObject credentials = new JSONObject().put("address", "http://100.80.1.7:43127")
            .put("token", "a".repeat(43)).put("computerName", "Rotation test");
        JSONArray rows = new JSONArray()
            .put(new JSONObject().put("id", "rotation-test").put("title", "旋转时保留当前会话").put("engine", "codex"))
            .put(new JSONObject().put("id", "rotation-other").put("title", "切换到另一个会话").put("engine", "dsh"));
        RemoteListCache.get(activity).put(credentials, rows, -1, new JSONArray(), true);
        getInstrumentation().runOnMainSync(() -> {
            try {
                field("foreground", false);
                field("credentials", credentials);
                field("conversationId", "rotation-test");
                field("conversationTitle", "旋转时保留当前会话");
                field("detailReturn", "list");
                invoke("detailScreen");
                ((EditText) field("composer")).setText("横竖屏切换后仍保留的草稿");
            } catch (Exception error) {
                throw new AssertionError(error);
            }
        });
        getInstrumentation().waitForIdleSync();
        android.os.SystemClock.sleep(400);
        getInstrumentation().waitForIdleSync();

        RemoteApi owner = new RemoteApi("http://100.80.1.7:43127");
        getInstrumentation().runOnMainSync(() -> {
            try {
                field("api", owner);
                field("generation", 41);
            } catch (Exception error) {
                throw new AssertionError(error);
            }
        });
        assertNull(activity.getWindow().getDecorView().findViewWithTag("detailConversationSidebar"));
        rotate(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
        assertSameConnection(owner);
        assertSidebarVisible();
        capture("system-rotation-landscape");
        rotate(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        assertSameConnection(owner);
        assertNull(activity.getWindow().getDecorView().findViewWithTag("detailConversationSidebar"));
        rotate(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
        assertSameConnection(owner);
        assertSidebarVisible();
    }

    public void testConversationOpenedInLandscapeHasUsableSidebar() throws Exception {
        if (!tabletWindow()) return;
        rotate(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
        getInstrumentation().runOnMainSync(() -> {
            try {
                field("foreground", false);
                field("conversationId", "landscape-test");
                field("conversationTitle", "横屏打开会话");
                invoke("detailScreen");
            } catch (Exception error) { throw new AssertionError(error); }
        });
        getInstrumentation().waitForIdleSync();
        assertSidebarVisible();
    }

    private boolean tabletWindow() {
        if (android.os.Build.VERSION.SDK_INT < 30) return false;
        var bounds = activity.getWindowManager().getMaximumWindowMetrics().getBounds();
        boolean tablet = !MobileOrientation.isPhoneSize(bounds.width(), bounds.height(),
            activity.getResources().getDisplayMetrics().density);
        if (!tablet) {
            android.os.Bundle status = new android.os.Bundle();
            status.putString("stream", "Skipped: real tablet rotation requires a window with a 600dp shortest side.\n");
            getInstrumentation().sendStatus(2, status);
        }
        return tablet;
    }

    private void rotate(int orientation) throws Exception {
        boolean landscape = orientation == ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
        getInstrumentation().runOnMainSync(() -> activity.setRequestedOrientation(orientation));
        long deadline = android.os.SystemClock.uptimeMillis() + 8_000;
        boolean[] rotated = {false};
        while (android.os.SystemClock.uptimeMillis() < deadline) {
            getInstrumentation().runOnMainSync(() -> {
                var bounds = activity.getWindowManager().getCurrentWindowMetrics().getBounds();
                Configuration config = activity.getResources().getConfiguration();
                rotated[0] = (bounds.width() > bounds.height()) == landscape
                    && (config.screenWidthDp > config.screenHeightDp) == landscape;
            });
            if (rotated[0]) break;
            android.os.SystemClock.sleep(100);
        }
        assertTrue("System rotation must update the Activity resources: "
            + activity.getResources().getConfiguration() + " bounds="
            + activity.getWindowManager().getCurrentWindowMetrics().getBounds(), rotated[0]);
        getInstrumentation().waitForIdleSync();
        android.os.SystemClock.sleep(350);
        getInstrumentation().waitForIdleSync();
        android.os.Bundle status = new android.os.Bundle();
        Configuration config = activity.getResources().getConfiguration();
        status.putString("stream", "System rotation: " + config.screenWidthDp + "x" + config.screenHeightDp
            + "dp, smallest=" + config.smallestScreenWidthDp + "dp\n");
        getInstrumentation().sendStatus(2, status);
    }

    private void assertSidebarVisible() {
        getInstrumentation().runOnMainSync(() -> {
            View root = activity.getWindow().getDecorView();
            View sidebar = root.findViewWithTag("detailConversationSidebar");
            assertNotNull("A landscape tablet must show the conversation sidebar: "
                + activity.getResources().getConfiguration(), sidebar);
            assertTrue("The sidebar must have usable width", sidebar.getWidth() > 0);
            assertTrue("The sidebar must have usable height", sidebar.getHeight() > 0);
        });
    }

    private void capture(String name) throws Exception {
        java.io.File directory = new java.io.File(activity.getExternalFilesDir(null), "workbench-visuals");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        Configuration config = activity.getResources().getConfiguration();
        java.io.File target = new java.io.File(directory,
            name + "-" + config.screenWidthDp + "x" + config.screenHeightDp + "dp.png");
        android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull(screenshot);
        try (var output = new java.io.FileOutputStream(target)) {
            assertTrue(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output));
        } finally { screenshot.recycle(); }
    }

    private void assertSameConnection(RemoteApi owner) {
        getInstrumentation().runOnMainSync(() -> {
            try {
                assertFalse("Rotation must not recreate MainActivity", activity.isDestroyed());
                assertSame("Rotation must keep the same RemoteApi owner", owner, field("api"));
                assertEquals("Rotation must not start a new connection generation", 41, field("generation"));
                assertEquals("detail", field("screen"));
                assertEquals("rotation-test", field("conversationId"));
                assertEquals("list", field("detailReturn"));
                assertEquals("横竖屏切换后仍保留的草稿", ((EditText) field("composer")).getText().toString());
            } catch (Exception error) {
                throw new AssertionError(error);
            }
        });
    }

    private void field(String name, Object value) throws Exception {
        var member = MainActivity.class.getDeclaredField(name);
        member.setAccessible(true);
        member.set(activity, value);
    }

    private Object field(String name) throws Exception {
        var member = MainActivity.class.getDeclaredField(name);
        member.setAccessible(true);
        return member.get(activity);
    }

    private void invoke(String name) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name);
        method.setAccessible(true);
        method.invoke(activity);
    }
}
