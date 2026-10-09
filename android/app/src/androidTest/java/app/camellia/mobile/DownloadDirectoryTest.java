package app.camellia.mobile;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.test.InstrumentationTestCase;
import android.view.View;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

public class DownloadDirectoryTest extends InstrumentationTestCase {
    private Activity activity;
    private ArtifactDownloads downloads;
    private final List<Uri> created = new ArrayList<>();
    private Instrumentation.ActivityMonitor monitor;

    @Override protected void setUp() throws Exception {
        super.setUp();
        assertFalse(ArtifactDownloadService.snapshot().active());
        DownloadDirectory.clear(getInstrumentation().getTargetContext());
        DownloadDirectoryFixture.grant(getInstrumentation());
    }

    @Override protected void tearDown() throws Exception {
        try {
            if (monitor != null) getInstrumentation().removeMonitor(monitor);
            ui(() -> { if (downloads != null) downloads.close(); if (activity != null) activity.finish(); });
            for (Uri file : created) DocumentsContract.deleteDocument(getInstrumentation().getTargetContext().getContentResolver(), file);
            DownloadDirectory.clear(getInstrumentation().getTargetContext());
            getInstrumentation().waitForIdleSync();
        } finally { super.tearDown(); }
    }

    public void testSettingsChooseRememberAndClearDirectory() throws Exception {
        activity = LocalChatFixture.start(getInstrumentation(), new Intent(getInstrumentation().getTargetContext(), SettingsActivity.class)
            .putExtra("section", "general").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        await(() -> activity.getWindow().getDecorView().findViewWithTag("preference:downloadDirectory") != null);
        final int[] picked = {0};
        monitor = new Instrumentation.ActivityMonitor() {
            @Override public Instrumentation.ActivityResult onStartActivity(Intent intent) {
                if (!Intent.ACTION_OPEN_DOCUMENT_TREE.equals(intent.getAction())) return null;
                picked[0]++;
                assertTrue((intent.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0);
                return new Instrumentation.ActivityResult(Activity.RESULT_OK, DownloadDirectoryFixture.selection());
            }
        };
        getInstrumentation().addMonitor(monitor);
        ui(() -> activity.getWindow().getDecorView().findViewWithTag("preference:downloadDirectory").performClick());
        await(() -> DownloadDirectoryFixture.TREE.equals(DownloadDirectory.selected(activity))
            && activity.getWindow().getDecorView().findViewWithTag("downloadDirectoryClear") != null);
        assertEquals(1, picked[0]);
        assertTrue(DownloadDirectory.hasPermission(activity, DownloadDirectoryFixture.TREE));
        assertEquals(DownloadDirectoryFixture.PATH, DownloadDirectory.label(activity));
        assertEquals(DownloadDirectoryFixture.TREE, DownloadDirectory.picker(activity).getParcelableExtra(DocumentsContract.EXTRA_INITIAL_URI));
        ui(activity::finish); await(() -> activity.isDestroyed());
        activity = LocalChatFixture.start(getInstrumentation(), new Intent(getInstrumentation().getTargetContext(), SettingsActivity.class)
            .putExtra("section", "general").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        await(() -> activity.getWindow().getDecorView().findViewWithTag("downloadDirectoryClear") != null);
        ui(() -> {
            View row = activity.getWindow().getDecorView().findViewWithTag("preference:downloadDirectory");
            row.requestRectangleOnScreen(new android.graphics.Rect(0, 0, row.getWidth(), row.getHeight()), true);
        });
        getInstrumentation().waitForIdleSync();
        var screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
        if (screenshot != null) {
            try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), "default-download-settings.png"))) {
                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
            } finally { screenshot.recycle(); }
        }
        ui(() -> {
            View row = activity.getWindow().getDecorView().findViewWithTag("preference:downloadDirectory");
            assertTrue(row.getContentDescription().toString().contains(DownloadDirectoryFixture.PATH));
            activity.getWindow().getDecorView().findViewWithTag("downloadDirectoryClear").performClick();
        });
        assertNull(DownloadDirectory.selected(activity));
        assertFalse(DownloadDirectory.hasPermission(activity, DownloadDirectoryFixture.TREE));
    }

    public void testDuplicatesCreateNewFilesWithoutReplacingOriginal() throws Exception {
        DownloadDirectory.saveSelection(getInstrumentation().getTargetContext(), DownloadDirectoryFixture.selection());
        Uri first = DownloadDirectory.createFile(getInstrumentation().getTargetContext(), DownloadDirectoryFixture.TREE, "report.pdf"); created.add(first);
        try (var output = getInstrumentation().getTargetContext().getContentResolver().openOutputStream(first, "wt")) {
            output.write("preserved original".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
        Uri second = DownloadDirectory.createFile(getInstrumentation().getTargetContext(), DownloadDirectoryFixture.TREE, "report.pdf"); created.add(second);
        assertFalse(first.equals(second));
        try (var cursor = getInstrumentation().getTargetContext().getContentResolver().query(second,
                new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            assertTrue(cursor.moveToFirst()); assertEquals("report (1).pdf", cursor.getString(0));
        }
        try (var input = getInstrumentation().getTargetContext().getContentResolver().openInputStream(first)) {
            assertEquals("preserved original", new String(input.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8));
        }
        assertTrue(DownloadDirectory.hasPermission(getInstrumentation().getTargetContext(), DownloadDirectoryFixture.TREE));
    }

    public void testExpiredDirectoryPermissionFallsBackToSavePicker() throws Exception {
        DownloadDirectory.saveSelection(getInstrumentation().getTargetContext(), DownloadDirectoryFixture.selection());
        getInstrumentation().getTargetContext().getContentResolver().releasePersistableUriPermission(DownloadDirectoryFixture.TREE,
            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        assertSavePicker(false);
    }

    public void testSaveAsBypassesAnAuthorizedDefaultDirectory() throws Exception {
        DownloadDirectory.saveSelection(getInstrumentation().getTargetContext(), DownloadDirectoryFixture.selection());
        assertSavePicker(true);
        assertTrue(DownloadDirectory.hasPermission(getInstrumentation().getTargetContext(), DownloadDirectoryFixture.TREE));
    }

    private void assertSavePicker(boolean saveAs) throws Exception {
        activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), PopupTestActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        final List<Intent> launched = new ArrayList<>();
        monitor = new Instrumentation.ActivityMonitor() {
            @Override public Instrumentation.ActivityResult onStartActivity(Intent intent) {
                launched.add(new Intent(intent)); return new Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null);
            }
        };
        getInstrumentation().addMonitor(monitor);
        ui(() -> {
            downloads = new ArtifactDownloads(activity, null);
            var choose = ArtifactDownloads.class.getDeclaredMethod("choose", JSONObject.class, String.class, String.class, String.class, boolean.class);
            choose.setAccessible(true);
            choose.invoke(downloads, new JSONObject().put("name", "report.pdf").put("size", 10).put("id", "a".repeat(64)),
                "http://100.64.0.1:43127", "b".repeat(43), "conversation", saveAs);
        });
        getInstrumentation().waitForIdleSync();
        assertEquals(1, launched.size());
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, launched.get(0).getAction());
        assertFalse("Choosing a different location must not start a download yet", ArtifactDownloadService.snapshot().active());
    }

    private interface Check { void run() throws Exception; }
    private interface Condition { boolean ready() throws Exception; }
    private void ui(Check check) throws Exception {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() instanceof Exception) throw (Exception) failure.get();
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private void await(Condition condition) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + 10_000;
        do {
            boolean[] ready = {false}; ui(() -> ready[0] = condition.ready());
            if (ready[0]) return;
            android.os.SystemClock.sleep(50);
        } while (android.os.SystemClock.elapsedRealtime() < deadline);
        fail("The download setting did not update");
    }
}
