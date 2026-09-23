package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;

public class ArtifactSheetTest extends InstrumentationTestCase {
    public void testProgressUsesSettingsPaletteAndDismissDoesNotCancelTask() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        var stateField = ArtifactDownloadService.class.getDeclaredField("state"); stateField.setAccessible(true);
        Object previous = stateField.get(null);
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    stateField.set(null, new ArtifactDownloadService.State("Camellia-Android-0.3.39-debug.apk", "test", 12 * 1024 * 1024, 48 * 1024 * 1024, "running", ""));
                    ArtifactDownloads downloads = new ArtifactDownloads(activity, null); downloads.showProgress();
                    var field = ArtifactDownloads.class.getDeclaredField("dialog"); field.setAccessible(true);
                    ArtifactSheet sheet = (ArtifactSheet) field.get(downloads);
                    assertNotNull(sheet.findViewById(android.R.id.content));
                    assertEquals(new SettingsStyle(activity).background, sheet.style.background);
                    assertNotNull(sheet.getWindow().getDecorView().findViewWithTag("downloadPercent"));
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            var bitmap = getInstrumentation().getUiAutomation().takeScreenshot();
            if (bitmap != null) {
                try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), "download-sheet.png"))) {
                    bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
                } finally { bitmap.recycle(); }
            }
            getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
            assertTrue(ArtifactDownloadService.snapshot().active());
        } finally {
            stateField.set(null, previous);
            getInstrumentation().runOnMainSync(activity::finish);
        }
    }

    public void testTransferLeaseKeepsNetworkAliveUntilReleased() throws Exception {
        var count = EmbeddedNetwork.class.getDeclaredField("transfers"); count.setAccessible(true);
        int before = count.getInt(null);
        EmbeddedNetwork.retainTransfer();
        try { EmbeddedNetwork.background(); assertEquals(before + 1, count.getInt(null)); }
        finally { EmbeddedNetwork.releaseTransfer(); EmbeddedNetwork.foreground(); }
        assertEquals(before, count.getInt(null));
        assertEquals(25, ArtifactDownloadService.percent(12, 48));
        assertEquals(0, ArtifactDownloadService.percent(0, 0));
        assertEquals(100, ArtifactDownloadService.percent(Long.MAX_VALUE, Long.MAX_VALUE));
    }
}
