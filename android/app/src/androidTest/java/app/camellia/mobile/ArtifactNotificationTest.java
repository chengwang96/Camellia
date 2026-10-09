package app.camellia.mobile;

import android.app.Activity;
import android.app.Instrumentation;
import android.app.NotificationManager;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
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

    public void testNotificationSettingsOnlyOpenAfterExplicitTap() throws Exception {
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
            assertNotNull(settings);
            assertEquals("Opening progress must not request permission or open settings", 0, launches.size());
            boolean enabled = activity.getSystemService(NotificationManager.class).areNotificationsEnabled();
            assertEquals(enabled ? View.GONE : View.VISIBLE, settings.getVisibility());
            String detail = ((TextView) root.findViewWithTag("downloadDetail")).getText().toString();
            assertEquals(enabled, detail.contains("notifications") || detail.contains("通知栏"));
            if (!enabled) {
                assertTrue(settings.performClick());
                assertEquals(1, launches.size());
                assertEquals(Settings.ACTION_APP_NOTIFICATION_SETTINGS, launches.get(0).getAction());
                assertEquals(activity.getPackageName(), launches.get(0).getStringExtra(Settings.EXTRA_APP_PACKAGE));
                assertTrue("Opening settings must leave the download running", ArtifactDownloadService.snapshot().active());
            }
            stateField.set(null, new ArtifactDownloadService.State("report.pdf", "test", 4096, 4096, "complete", "Saved."));
        });
        // The progress sheet refreshes every 500ms, including after returning from settings.
        android.os.SystemClock.sleep(650);
        onMain(() -> {
            var field = ArtifactDownloads.class.getDeclaredField("dialog"); field.setAccessible(true);
            ArtifactSheet sheet = (ArtifactSheet) field.get(downloads);
            View root = sheet.getWindow().getDecorView();
            assertEquals(View.GONE, root.findViewWithTag("downloadNotificationSettings").getVisibility());
            assertEquals("Saved.", ((TextView) root.findViewWithTag("downloadDetail")).getText().toString());
        });
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
