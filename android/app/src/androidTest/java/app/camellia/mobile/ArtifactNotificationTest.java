package app.camellia.mobile;

import android.app.Activity;
import android.app.Instrumentation;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/** Run with notification permission unset, denied, and granted on a disposable emulator. */
public class ArtifactNotificationTest extends InstrumentationTestCase {
    private Activity activity;
    private ArtifactDownloads downloads;
    private java.lang.reflect.Field stateField;
    private Object previousState;
    private final List<Intent> launches = new ArrayList<>();
    private Instrumentation.ActivityMonitor monitor;

    @Override protected void setUp() throws Exception {
        super.setUp();
        stateField = ArtifactDownloadService.class.getDeclaredField("state"); stateField.setAccessible(true);
        previousState = stateField.get(null);
        assertFalse("Run without an active download", ArtifactDownloadService.snapshot().active());
        stateField.set(null, new ArtifactDownloadService.State("", "", 0, 0, "idle", ""));
        activity = startActivity();
        monitor = new Instrumentation.ActivityMonitor() {
            @Override public Instrumentation.ActivityResult onStartActivity(Intent intent) {
                if (intent.getComponent() != null && intent.getComponent().getPackageName().equals(activity.getPackageName())) return null;
                launches.add(new Intent(intent));
                return new Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null);
            }
        };
        getInstrumentation().addMonitor(monitor);
        onMain(() -> downloads = new ArtifactDownloads(activity, null));
    }

    @Override protected void tearDown() throws Exception {
        try {
            if (monitor != null) getInstrumentation().removeMonitor(monitor);
            onMain(() -> { if (downloads != null) downloads.close(); if (activity != null) activity.finish(); });
            getInstrumentation().waitForIdleSync();
            if (stateField != null) stateField.set(null, previousState);
        } finally { super.tearDown(); }
    }

    public void testFirstTapOpensSavePickerWithoutPermissionPrompt() throws Exception {
        choose();
        assertPicker(1);
        onMain(() -> {
            Bundle saved = new Bundle(); downloads.save(saved);
            JSONObject pending = new JSONObject(saved.getString("artifactSave"));
            assertEquals("report.pdf", pending.getString("name"));
            assertEquals("http://100.64.0.1:43127", pending.getString("address"));
            assertFalse(pending.has("token"));
        });
    }

    public void testActivityRestartDoesNotReintroducePermissionPrompt() throws Exception {
        choose(); assertPicker(1);
        onMain(() -> { downloads.close(); activity.finish(); });
        getInstrumentation().waitForIdleSync();
        activity = startActivity();
        onMain(() -> downloads = new ArtifactDownloads(activity, null));
        choose(); assertPicker(2);
    }

    public void testProgressDoesNotOfferNotificationSettings() throws Exception {
        onMain(() -> {
            stateField.set(null, new ArtifactDownloadService.State("report.pdf", "test", 1024, 4096, "running", ""));
            downloads.showProgress();
        });
        getInstrumentation().waitForIdleSync();
        onMain(() -> {
            var field = ArtifactDownloads.class.getDeclaredField("dialog"); field.setAccessible(true);
            ArtifactSheet sheet = (ArtifactSheet) field.get(downloads);
            View root = sheet.getWindow().getDecorView();
            View settings = root.findViewWithTag("downloadNotificationSettings");
            assertNull("The progress sheet must not offer an Enable download notifications action", settings);
            assertEquals("Opening progress must not request permission or open settings", 0, launches.size());
            boolean enabled = activity.getSystemService(NotificationManager.class).areNotificationsEnabled();
            String detail = ((TextView) root.findViewWithTag("downloadDetail")).getText().toString();
            assertEquals(enabled, detail.contains("notifications") || detail.contains("通知栏"));
            assertTrue("Opening progress must leave the download running", ArtifactDownloadService.snapshot().active());
            stateField.set(null, new ArtifactDownloadService.State("report.pdf", "test", 4096, 4096, "complete", "Saved."));
        });
        // The progress sheet refreshes every 500ms as the download completes.
        android.os.SystemClock.sleep(650);
        onMain(() -> {
            var field = ArtifactDownloads.class.getDeclaredField("dialog"); field.setAccessible(true);
            ArtifactSheet sheet = (ArtifactSheet) field.get(downloads);
            View root = sheet.getWindow().getDecorView();
            assertNull(root.findViewWithTag("downloadNotificationSettings"));
            assertEquals("Saved.", ((TextView) root.findViewWithTag("downloadDetail")).getText().toString());
        });
    }

    public void testCompletedDownloadOffersSystemDefaultOpen() throws Exception {
        Uri destination = Uri.parse("content://app.camellia.mobile.test.document/report-1");
        onMain(() -> {
            stateField.set(null, new ArtifactDownloadService.State("report.pdf", "test", 4096, 4096,
                "complete", "Saved.", destination));
            downloads.showProgress();
        });
        getInstrumentation().waitForIdleSync();
        android.os.SystemClock.sleep(650);
        onMain(() -> {
            try {
                var field = ArtifactDownloads.class.getDeclaredField("dialog");
                field.setAccessible(true);
                ArtifactSheet sheet = (ArtifactSheet) field.get(downloads);
                View root = sheet.getWindow().getDecorView();
                View open = root.findViewWithTag("downloadOpen");
                View done = root.findViewWithTag("downloadDone");
                assertNotNull("Completed downloads need an Open action", open);
                assertNotNull("Completed downloads keep a separate Done action", done);
                assertTrue(open.performClick());
            } catch (Exception error) {
                throw new AssertionError(error);
            }
        });
        getInstrumentation().waitForIdleSync();
        onMain(() -> {
            assertEquals(1, launches.size());
            Intent intent = launches.get(0);
            assertEquals(Intent.ACTION_VIEW, intent.getAction());
            assertEquals(destination, intent.getData());
            assertEquals("application/pdf", intent.getType());
            assertTrue((intent.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0);
        });
    }

    public void testSystemOpenFallbackKeepsTheDownloadedUri() throws Exception {
        Uri destination = Uri.parse("content://app.camellia.mobile.test.document/report-1");
        List<Intent> attempts = new ArrayList<>();
        Activity opener = new Activity() {
            @Override public void startActivity(Intent intent) {
                attempts.add(new Intent(intent));
                if (attempts.size() == 1) throw new android.content.ActivityNotFoundException();
            }
        };
        onMain(() -> assertTrue(ArtifactOpen.open(opener, destination, "report.pdf", false)));
        assertEquals(2, attempts.size());
        Intent fallback = attempts.get(1);
        assertEquals(destination, fallback.getData());
        assertEquals("*/*", fallback.getType());
        assertEquals(destination, fallback.getClipData().getItemAt(0).getUri());
        assertTrue((fallback.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0);
    }

    private Activity startActivity() {
        return getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), PopupTestActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    private void choose() throws Exception {
        onMain(() -> {
            var method = ArtifactDownloads.class.getDeclaredMethod("choose", JSONObject.class, String.class, String.class, String.class);
            method.setAccessible(true);
            method.invoke(downloads, new JSONObject().put("name", "report.pdf").put("id", "a".repeat(64)).put("size", 4096),
                "http://100.64.0.1:43127", "b".repeat(43), "12345678-1234-1234-1234-123456789abc");
        });
        getInstrumentation().waitForIdleSync();
    }

    private void assertPicker(int count) throws Exception {
        onMain(() -> {
            assertEquals("Every download tap must open exactly one save picker", count, launches.size());
            for (Intent intent : launches) {
                assertEquals("A permission prompt must never interrupt the download", Intent.ACTION_CREATE_DOCUMENT, intent.getAction());
                assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE));
                assertEquals("application/octet-stream", intent.getType());
                assertEquals("report.pdf", intent.getStringExtra(Intent.EXTRA_TITLE));
            }
        });
    }

    private interface CheckedAction { void run() throws Exception; }
    private void onMain(CheckedAction action) throws Exception {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() instanceof Exception) throw (Exception) failure.get();
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
}
