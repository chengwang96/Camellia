package app.camellia.mobile;

import android.content.Intent;
import android.graphics.Matrix;
import android.test.InstrumentationTestCase;
import android.view.TextureView;
import android.view.View;

public class QrScannerTest extends InstrumentationTestCase {
    private QrScanActivity scanner;
    private String previousLanguage, previousTheme;
    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private Object field(String name) throws Exception {
        var member = QrScanActivity.class.getDeclaredField(name); member.setAccessible(true); return member.get(scanner);
    }
    private void waitForCamera() throws Exception {
        java.util.concurrent.atomic.AtomicBoolean ready = new java.util.concurrent.atomic.AtomicBoolean();
        long deadline = android.os.SystemClock.uptimeMillis() + 6000;
        while (!ready.get() && android.os.SystemClock.uptimeMillis() < deadline) {
            ui(() -> ready.set(field("camera") != null && (int) field("previewWidth") > 0));
            if (!ready.get()) android.os.SystemClock.sleep(40);
        }
        assertTrue("Camera did not start", ready.get());
    }

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        // Shell permission setup also supports the app's Android 8 minimum.
        try (var grant = new android.os.ParcelFileDescriptor.AutoCloseInputStream(getInstrumentation().getUiAutomation()
                .executeShellCommand("pm grant " + context.getPackageName() + " android.permission.CAMERA"))) {
            while (grant.read() != -1) { }
        }
        assertEquals(android.content.pm.PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(android.Manifest.permission.CAMERA));
        previousLanguage = MobilePreferences.get(context, "language"); previousTheme = MobilePreferences.get(context, "theme");
        android.os.Bundle options = ((android.test.InstrumentationTestRunner) getInstrumentation()).getArguments();
        if (options.containsKey("language")) MobilePreferences.set(context, "language", options.getString("language"));
        if (options.containsKey("theme")) MobilePreferences.set(context, "theme", options.getString("theme"));
        scanner = (QrScanActivity) getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), QrScanActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        waitForCamera(); getInstrumentation().waitForIdleSync();
    }
    @Override protected void tearDown() throws Exception {
        ui(() -> scanner.finish());
        long deadline = android.os.SystemClock.uptimeMillis() + 5000;
        while (!scanner.isDestroyed() && android.os.SystemClock.uptimeMillis() < deadline) {
            getInstrumentation().waitForIdleSync(); Thread.sleep(25);
        }
        assertTrue("Scanner must release its camera before the next test", scanner.isDestroyed());
        MobilePreferences.set(getInstrumentation().getTargetContext(), "language", previousLanguage);
        MobilePreferences.set(getInstrumentation().getTargetContext(), "theme", previousTheme);
        super.tearDown();
    }

    public void testPreviewKeepsSensorAspectAndChromeOutsideCamera() throws Exception {
        ui(() -> {
            TextureView preview = (TextureView) field("preview");
            android.hardware.Camera.CameraInfo info = (android.hardware.Camera.CameraInfo) field("cameraInfo");
            int rotation = CameraPreviewGeometry.rotation(info.orientation, scanner.getWindowManager().getDefaultDisplay().getRotation() * 90,
                info.facing == android.hardware.Camera.CameraInfo.CAMERA_FACING_FRONT);
            int width = (int) field("previewWidth"), height = (int) field("previewHeight");
            float ratio = rotation % 180 == 0 ? (float) width / height : (float) height / width;
            float[] transform = new float[9]; preview.getTransform(new Matrix()).getValues(transform);
            assertEquals(ratio, preview.getWidth() * transform[Matrix.MSCALE_X] / (preview.getHeight() * transform[Matrix.MSCALE_Y]), .0001f);
            View root = scanner.getWindow().getDecorView(), guide = root.findViewWithTag("qrGuide"), status = root.findViewWithTag("qrStatus");
            assertTrue(guide.getWidth() > 0 && guide.getHeight() > 0);
            android.graphics.Rect previewRect = new android.graphics.Rect(), statusRect = new android.graphics.Rect(), headerRect = new android.graphics.Rect();
            assertTrue(preview.getGlobalVisibleRect(previewRect)); assertTrue(status.getGlobalVisibleRect(statusRect));
            assertTrue(root.findViewWithTag("settingsTitle").getGlobalVisibleRect(headerRect));
            assertTrue(headerRect.bottom <= previewRect.top); assertTrue(previewRect.bottom <= statusRect.top);
        });
        android.os.SystemClock.sleep(400);
        android.graphics.Bitmap bitmap = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(bitmap);
        try (var output = new java.io.FileOutputStream(new java.io.File(scanner.getExternalCacheDir(), "qr-scanner.png"))) {
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
        } finally { bitmap.recycle(); }
    }

    public void testPauseReleasesCameraAndResumeReopensRetainedSurface() throws Exception {
        ui(() -> { getInstrumentation().callActivityOnPause(scanner); assertNull(field("camera")); });
        ui(() -> getInstrumentation().callActivityOnResume(scanner)); waitForCamera();
        ui(() -> {
            TextureView preview = (TextureView) field("preview");
            scanner.onSurfaceTextureDestroyed(preview.getSurfaceTexture());
            assertEquals(false, field("surfaceReady")); assertNull(field("camera"));
            scanner.onSurfaceTextureAvailable(preview.getSurfaceTexture(), preview.getWidth(), preview.getHeight());
        });
        waitForCamera();
    }

    public void testLandscapeRecreatesCameraWithCorrectPreview() throws Exception {
        var monitor = getInstrumentation().addMonitor(QrScanActivity.class.getName(), null, false);
        try {
            ui(() -> scanner.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
            android.app.Activity replacement = getInstrumentation().waitForMonitorWithTimeout(monitor, 6000);
            if (replacement != null) scanner = (QrScanActivity) replacement;
            waitForCamera(); getInstrumentation().waitForIdleSync();
            ui(() -> {
                assertEquals(android.content.res.Configuration.ORIENTATION_LANDSCAPE, scanner.getResources().getConfiguration().orientation);
                assertTrue(scanner.getWindow().getDecorView().getWidth() > scanner.getWindow().getDecorView().getHeight());
            });
            testPreviewKeepsSensorAspectAndChromeOutsideCamera();
        } finally { getInstrumentation().removeMonitor(monitor); }
    }
}
