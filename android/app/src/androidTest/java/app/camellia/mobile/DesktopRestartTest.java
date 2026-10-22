package app.camellia.mobile;

import android.app.Dialog;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

public class DesktopRestartTest extends InstrumentationTestCase {
    private MainActivity activity;
    private final AtomicInteger reads = new AtomicInteger(), writes = new AtomicInteger();
    private JSONObject computer, posted;
    private volatile String permission = "control";
    private volatile boolean supported = true, disconnect = false;
    private boolean oldEmbedded;
    private static final String INSTANCE = "12345678-1234-1234-1234-123456789abc";

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); oldEmbedded = EmbeddedNetwork.enabled(); EmbeddedNetwork.setEnabled(false);
        computer = new JSONObject().put("address", "http://100.64.0.11:43127").put("computerName", "Restart test").put("token", "a".repeat(43));
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            invoke("stopNetwork"); field("foreground", false); field("chinese", true);
            field("statusClientFactory", (Function<String, RemoteApi>) address -> new RemoteApi(address) {
                @Override public JSONObject json(String path, String token, JSONObject payload) throws IOException {
                    try {
                        assertEquals(computer.getString("token"), token);
                        if (path.equals("/v1/status")) {
                            reads.incrementAndGet();
                            return new JSONObject().put("protocol", 1).put("instanceId", INSTANCE).put("permission", permission)
                                .put("capabilities", new JSONArray(supported ? new String[]{"desktop-restart"} : new String[]{}));
                        }
                        assertEquals("/v1/desktop/restart", path); posted = new JSONObject(payload.toString()); writes.incrementAndGet();
                        if (disconnect) throw new IOException("Connection closed after POST");
                        return new JSONObject().put("ok", true).put("state", "accepted");
                    } catch (org.json.JSONException error) { throw new IOException(error); }
                }
                @Override public void cancel() {}
            });
            invoke("computersScreen");
            invoke("manageComputer", computer);
        });
    }

    @Override protected void tearDown() throws Exception {
        ui(() -> { dialog().dismiss(); activity.finish(); });
        getInstrumentation().waitForIdleSync(); EmbeddedNetwork.setEnabled(oldEmbedded); super.tearDown();
    }

    public void testMenuOpensConfirmationAndCancelNeverContactsTheDesktop() throws Exception {
        screenshot("desktop-restart-menu");
        ui(() -> {
            View action = dialog().getWindow().getDecorView().findViewWithTag("manageRestart");
            assertNotNull(action); action.performClick();
            assertNotNull(panel().findViewWithTag("restartConfirm"));
        });
        screenshot("desktop-restart-confirm");
        ui(() -> panel().findViewWithTag("restartCancel").performClick());
        assertEquals(0, reads.get()); assertEquals(0, writes.get());
    }

    public void testConfirmSendsOneBoundRestartAndPreservesTheComputerCredential() throws Exception {
        confirm(); waitFor(() -> writes.get() == 1 && !dialog().isShowing());
        assertEquals(1, reads.get()); assertEquals(INSTANCE, posted.getString("instanceId"));
        assertTrue(posted.getBoolean("confirmed")); assertEquals(3, posted.length());
        assertTrue(posted.getString("requestId").matches("[a-f0-9-]{36}"));
        assertEquals("a".repeat(43), computer.getString("token"));
        assertEquals(1, writes.get());
    }

    public void testReadOnlyAndOlderDesktopsCannotReceiveRestartRequests() throws Exception {
        permission = "read"; confirm(); waitFor(() -> feedback().contains("完整控制权限"));
        assertEquals(0, writes.get());
        ui(() -> { dialog().dismiss(); invoke("manageComputer", computer); });
        permission = "control"; supported = false; confirm(); waitFor(() -> feedback().contains("更新重启电脑端"));
        assertEquals(0, writes.get());
    }

    public void testLostAcknowledgmentNeverResendsTheRestart() throws Exception {
        disconnect = true; confirm(); waitFor(() -> feedback().contains("请求结果不确定"));
        ui(() -> { View confirm = panel().findViewWithTag("restartConfirm"); assertFalse(confirm.isEnabled()); confirm.performClick(); });
        assertEquals(1, writes.get());
    }

    private void confirm() throws Exception {
        ui(() -> {
            panel().findViewWithTag("manageRestart").performClick();
            panel().findViewWithTag("restartConfirm").performClick();
            assertFalse(panel().findViewWithTag("restartConfirm").isEnabled());
        });
    }
    private interface Check { void run() throws Exception; }
    private interface Condition { boolean get() throws Exception; }
    private void ui(Check check) { getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Exception error) { throw new AssertionError(error); } }); }
    private void waitFor(Condition condition) throws Exception {
        long end = android.os.SystemClock.uptimeMillis() + 5000;
        while (android.os.SystemClock.uptimeMillis() < end) {
            boolean[] done = {false}; ui(() -> done[0] = condition.get());
            if (done[0]) return;
            android.os.SystemClock.sleep(30);
        }
        fail("Timed out waiting for restart feedback");
    }
    private void screenshot(String name) throws Exception {
        getInstrumentation().waitForIdleSync();
        android.os.SystemClock.sleep(400);
        var bitmap = getInstrumentation().getUiAutomation().takeScreenshot();
        var directory = new java.io.File(activity.getExternalFilesDir(null), "screenshots"); directory.mkdirs();
        try (var output = new java.io.FileOutputStream(new java.io.File(directory, name + ".png"))) {
            assertTrue(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output));
        } finally { bitmap.recycle(); }
    }
    private Dialog dialog() throws Exception { return (Dialog) field("computerDialog"); }
    private View panel() throws Exception { return dialog().getWindow().getDecorView(); }
    private String feedback() throws Exception { return ((TextView) panel().findViewWithTag("restartFeedback")).getText().toString(); }
    private Object field(String name) throws Exception { var field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); return field.get(activity); }
    private void field(String name, Object value) throws Exception { var field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); field.set(activity, value); }
    private void invoke(String name) throws Exception { var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity); }
    private void invoke(String name, JSONObject value) throws Exception { var method = MainActivity.class.getDeclaredMethod(name, JSONObject.class); method.setAccessible(true); method.invoke(activity, value); }
}
