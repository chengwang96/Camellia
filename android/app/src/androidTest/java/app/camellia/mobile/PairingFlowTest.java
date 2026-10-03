package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.test.InstrumentationTestCase;
import android.test.InstrumentationTestRunner;
import android.view.View;
import android.widget.EditText;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.concurrent.atomic.AtomicBoolean;

public class PairingFlowTest extends InstrumentationTestCase {
    private static final String ADDRESS = "http://100.64.0.1:43129";
    private static final String CODE = "00112233445566778899aabb";
    private MainActivity activity;
    private CredentialStore storage;
    private String previousName, previousLanguage, previousTheme;

    private interface Check { void run() throws Exception; }
    private interface Condition { boolean get() throws Exception; }
    private void ui(Check check) {
        var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private Object field(Object target, String name) throws Exception {
        var member = target.getClass().getDeclaredField(name); member.setAccessible(true); return member.get(target);
    }
    private void invoke(String name) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity);
    }
    private EditText input(String tag) { return activity.getWindow().getDecorView().findViewWithTag(tag); }
    private TextView action() { return activity.getWindow().getDecorView().findViewWithTag("pairRequest"); }
    private String status() { return ((TextView) activity.getWindow().getDecorView().findViewWithTag("connectionStatus")).getText().toString(); }
    private void await(Condition condition) throws Exception {
        long deadline = android.os.SystemClock.uptimeMillis() + 15000;
        AtomicBoolean done = new AtomicBoolean();
        while (!done.get() && android.os.SystemClock.uptimeMillis() < deadline) {
            ui(() -> done.set(condition.get()));
            if (!done.get()) android.os.SystemClock.sleep(40);
        }
        assertTrue("Timed out waiting for pairing state", done.get());
    }
    private boolean integration() {
        return "true".equals(((InstrumentationTestRunner) getInstrumentation()).getArguments().getString("pairingIntegration"));
    }

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        previousName = MobilePreferences.deviceName(context);
        previousLanguage = MobilePreferences.get(context, "language"); previousTheme = MobilePreferences.get(context, "theme");
        Bundle options = ((InstrumentationTestRunner) getInstrumentation()).getArguments();
        if (options.containsKey("language")) MobilePreferences.set(context, "language", options.getString("language"));
        if (options.containsKey("theme")) MobilePreferences.set(context, "theme", options.getString("theme"));
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        storage = new CredentialStore(context); storage.clear();
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> invoke("pairScreen"));
        getInstrumentation().waitForIdleSync();
    }

    @Override protected void tearDown() throws Exception {
        ui(() -> activity.finish()); getInstrumentation().waitForIdleSync();
        storage.clear(); MobilePreferences.set(getInstrumentation().getTargetContext(), "deviceName", previousName);
        MobilePreferences.set(getInstrumentation().getTargetContext(), "language", previousLanguage);
        MobilePreferences.set(getInstrumentation().getTargetContext(), "theme", previousTheme);
        super.tearDown();
    }

    public void testValidationAndNetworkRoundTripKeepDraft() throws Exception {
        ui(() -> {
            input("pairAddress").setText("192.168.1.2");
            action().performClick();
            assertTrue(input("pairAddress").createAccessibilityNodeInfo().isContentInvalid());
            input("pairAddress").setText("100.64.0.1"); input("pairPort").setText("0"); action().performClick();
            assertTrue(input("pairPort").createAccessibilityNodeInfo().isContentInvalid());
            input("pairPort").setText("43129"); input("pairCode").setText("short"); action().performClick();
            assertTrue(input("pairCode").createAccessibilityNodeInfo().isContentInvalid());
            input("pairCode").setText(CODE); input("pairName").setText("Draft phone");
            invoke("showNetwork"); activity.onBackPressed();
            assertEquals("100.64.0.1", input("pairAddress").getText().toString());
            assertEquals("43129", input("pairPort").getText().toString());
            assertEquals(CODE, input("pairCode").getText().toString());
            assertEquals("Draft phone", input("pairName").getText().toString());
            assertEquals(0, storage.load().length());
        });
    }

    public void testScanResultNormalizesHostBeforeForegroundAndRejectsBadPayload() throws Exception {
        ui(() -> {
            var foreground = MainActivity.class.getDeclaredField("foreground"); foreground.setAccessible(true); foreground.set(activity, false);
            activity.onActivityResult(44, Activity.RESULT_OK, new Intent().putExtra(QrScanActivity.EXTRA_ADDRESS, ADDRESS).putExtra(QrScanActivity.EXTRA_CODE, CODE.toUpperCase(java.util.Locale.ROOT)));
            assertEquals("100.64.0.1", input("pairAddress").getText().toString());
            assertEquals("43129", input("pairPort").getText().toString());
            assertEquals(CODE, input("pairCode").getText().toString());
            assertEquals(true, field(activity, "pendingScannedPairing")); assertEquals(0, storage.load().length());
            activity.onActivityResult(44, Activity.RESULT_OK, new Intent().putExtra(QrScanActivity.EXTRA_ADDRESS, "http://evil.example").putExtra(QrScanActivity.EXTRA_CODE, CODE));
            assertEquals("100.64.0.1", input("pairAddress").getText().toString());
            assertTrue(status().contains("无效") || status().contains("Invalid"));
            foreground.set(activity, true);
            var pending = MainActivity.class.getDeclaredField("pendingScannedPairing"); pending.setAccessible(true); pending.set(activity, false);
        });
    }

    public void testPairingDraftSurvivesActivityRecreation() throws Exception {
        ui(() -> {
            input("pairAddress").setText("100.64.0.1"); input("pairPort").setText("43129");
            input("pairCode").setText(CODE); input("pairName").setText("Rotated phone");
            Bundle saved = new Bundle(); activity.onSaveInstanceState(saved);
            Bundle draft = saved.getBundle("pairingDraft"); assertNotNull(draft);
            assertEquals(CODE, draft.getString("code"));
        });
        var monitor = getInstrumentation().addMonitor(MainActivity.class.getName(), null, false);
        try {
            ui(() -> activity.recreate());
            Activity replacement = getInstrumentation().waitForMonitorWithTimeout(monitor, 6000); assertNotNull(replacement);
            activity = (MainActivity) replacement; getInstrumentation().waitForIdleSync();
            ui(() -> {
                assertEquals("100.64.0.1", input("pairAddress").getText().toString()); assertEquals(CODE, input("pairCode").getText().toString());
                assertEquals("Rotated phone", input("pairName").getText().toString());
            });
        } finally { getInstrumentation().removeMonitor(monitor); }
    }

    public void testScannedQrReturnsFromCameraAndPairsExactlyOnce() throws Exception {
        if (!integration()) return;
        ui(() -> input("pairName").setText("Pairing scan fixture"));
        var monitor = getInstrumentation().addMonitor(QrScanActivity.class.getName(), null, false);
        QrScanActivity scanner = null;
        try {
            ui(() -> activity.getWindow().getDecorView().findViewWithTag("pairScan").performClick());
            scanner = (QrScanActivity) getInstrumentation().waitForMonitorWithTimeout(monitor, 6000); assertNotNull(scanner);
            QrScanActivity current = scanner;
            await(() -> field(current, "camera") != null && (int) field(current, "previewWidth") > 0 && Boolean.FALSE.equals(field(activity, "foreground")));
            ui(() -> {
                assertEquals(false, field(activity, "foreground"));
                int width = (int) field(current, "previewWidth"), height = (int) field(current, "previewHeight");
                String json = new JSONObject().put("v", 1).put("type", "camellia-pair").put("address", ADDRESS).put("code", CODE).toString();
                int size = Math.min(width, height) - 40;
                var qr = new com.google.zxing.qrcode.QRCodeWriter().encode(json, com.google.zxing.BarcodeFormat.QR_CODE, size, size);
                byte[] frame = new byte[width * height * 3 / 2]; java.util.Arrays.fill(frame, (byte) 128);
                java.util.Arrays.fill(frame, 0, width * height, (byte) 255);
                for (int y = 0; y < size; y++) for (int x = 0; x < size; x++) {
                    frame[(y + (height - size) / 2) * width + x + (width - size) / 2] = (byte) (qr.get(x, y) ? 0 : 255);
                }
                current.onPreviewFrame(frame, (android.hardware.Camera) field(current, "camera"));
            });
            await(() -> Boolean.TRUE.equals(field(activity, "foreground")) && Boolean.TRUE.equals(field(activity, "pairingBusy")));
            ui(() -> {
                assertEquals("100.64.0.1", input("pairAddress").getText().toString());
                assertEquals("43129", input("pairPort").getText().toString());
                assertFalse(action().isEnabled()); assertFalse(input("pairCode").isEnabled());
                invoke("requestPairing"); // Guard also protects programmatic duplicate submissions.
            });
            await(() -> ((JSONObject) field(activity, "credentials")).has("token"));
            ui(() -> {
                assertEquals("list", field(activity, "screen"));
                assertEquals("Pairing test desktop", storage.load().getString("computerName"));
                assertFalse(storage.load().has("claim")); assertEquals(ADDRESS, storage.load().getString("address"));
            });
        } finally {
            if (scanner != null && !scanner.isFinishing()) { QrScanActivity current = scanner; ui(current::finish); }
            getInstrumentation().removeMonitor(monitor);
        }
    }

    public void testManualPairingShowsFailureThenRetriesAndApproves() throws Exception {
        if (!integration()) return;
        ui(() -> {
            input("pairAddress").setText("100.64.0.1"); input("pairPort").setText("43129");
            input("pairCode").setText(CODE); input("pairName").setText("Pairing retry fixture");
            action().performClick(); assertFalse(action().isEnabled()); invoke("requestPairing");
        });
        await(() -> action().isEnabled() && status().contains("503"));
        ui(() -> {
            assertEquals(CODE, input("pairCode").getText().toString());
            action().performClick(); assertFalse(action().isEnabled());
        });
        await(() -> ((JSONObject) field(activity, "credentials")).has("claim"));
        ui(() -> { assertFalse(action().isEnabled()); assertTrue(status().contains("授权") || status().contains("Approve")); });
        await(() -> ((JSONObject) field(activity, "credentials")).has("token"));
        ui(() -> assertEquals("list", field(activity, "screen")));
    }

    public void testExpiredClaimEnablesFreshPairing() throws Exception {
        ui(() -> {
            var credentials = MainActivity.class.getDeclaredField("credentials"); credentials.setAccessible(true);
            credentials.set(activity, new JSONObject().put("address", ADDRESS).put("name", "Expired phone").put("id", "expired").put("claim", "expired").put("expiresAt", 1));
            invoke("waitForApproval");
            assertTrue(action().isEnabled()); assertFalse(((JSONObject) field(activity, "credentials")).has("claim"));
            assertTrue(status().contains("过期") || status().contains("expired"));
        });
    }

    public void testPairingPageUsesSettingsSurfaceAndVisibleAction() throws Exception {
        getInstrumentation().waitForIdleSync();
        // Main-thread idleness does not mean the page transition and layout
        // have completed. Check visibility after the real button is laid out.
        await(() -> {
            android.graphics.Rect visible = new android.graphics.Rect();
            return action().isLaidOut() && action().getHeight() > 0
                && action().getGlobalVisibleRect(visible) && action().getHeight() == visible.height();
        });
        ui(() -> {
            View root = activity.getWindow().getDecorView();
            assertNotNull(root.findViewWithTag("settingsBack"));
            assertTrue(input("pairAddress").getBackground() instanceof android.graphics.drawable.StateListDrawable);
            android.graphics.Rect visible = new android.graphics.Rect(); assertTrue(action().getGlobalVisibleRect(visible));
            assertEquals(action().getHeight(), visible.height());
        });
        android.os.SystemClock.sleep(400);
        android.graphics.Bitmap bitmap = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(bitmap);
        try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), "pairing-page.png"))) {
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
        } finally { bitmap.recycle(); }
    }
}
