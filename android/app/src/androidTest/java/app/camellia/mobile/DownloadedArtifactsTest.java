package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.LinearLayout;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

public class DownloadedArtifactsTest extends InstrumentationTestCase {
    private static final String ADDRESS = "http://100.64.0.1:43127";
    private static final String CONVERSATION = "12345678-1234-1234-1234-123456789abc";
    private final List<Uri> created = new ArrayList<>();
    private Activity activity;
    private Instrumentation.ActivityMonitor monitor;

    @Override protected void setUp() throws Exception {
        super.setUp();
        Context context = getInstrumentation().getTargetContext();
        DownloadDirectory.clear(context);
        ArtifactDownloadHistory.clear(context);
        DownloadDirectoryFixture.grant(getInstrumentation());
    }

    @Override protected void tearDown() throws Exception {
        try {
            if (monitor != null) getInstrumentation().removeMonitor(monitor);
            if (activity != null) {
                final Activity closing = activity;
                getInstrumentation().runOnMainSync(closing::finish);
            }
            Context context = getInstrumentation().getTargetContext();
            for (Uri file : created) {
                try {
                    DocumentsContract.deleteDocument(context.getContentResolver(), file);
                } catch (Exception ignored) { }
            }
            ArtifactDownloadHistory.clear(context);
            DownloadDirectory.clear(context);
            getInstrumentation().waitForIdleSync();
        } finally {
            super.tearDown();
        }
    }

    public void testManagerListsOpensAndDeletesOneFile() throws Exception {
        Context context = getInstrumentation().getTargetContext();
        Uri file = download("report.pdf", "report");
        ArtifactDownloadHistory.complete(context, ADDRESS, CONVERSATION, false, "a".repeat(64),
            "report.pdf", file, 6);
        launchDownloads();
        awaitRows(1);

        final AtomicReference<Intent> opened = new AtomicReference<>();
        monitor = new Instrumentation.ActivityMonitor() {
            @Override public Instrumentation.ActivityResult onStartActivity(Intent intent) {
                opened.set(new Intent(intent));
                return new Instrumentation.ActivityResult(Activity.RESULT_OK, null);
            }
        };
        getInstrumentation().addMonitor(monitor);
        ui(() -> root().findViewWithTag("downloadedArtifactOpen:0").performClick());
        await(() -> opened.get() != null);
        assertEquals(Intent.ACTION_VIEW, opened.get().getAction());
        assertEquals(ArtifactOpen.mimeType("report.pdf"), opened.get().getType());
        assertEquals(file, opened.get().getData());

        ui(() -> root().findViewWithTag("downloadedArtifactDelete:0").performClick());
        ui(() -> dialog().getButton(AlertDialog.BUTTON_POSITIVE).performClick());
        await(() -> ArtifactDownloadHistory.all(context).isEmpty());
        await(() -> root().findViewWithTag("downloadedArtifact:0") == null);
        assertFalse(DownloadDirectoryFixture.files(context).contains(file));
    }

    public void testSelectAllDeletesEveryDownloadedFile() throws Exception {
        Context context = getInstrumentation().getTargetContext();
        Uri report = download("report.pdf", "report");
        Uri image = download("preview.png", "image");
        ArtifactDownloadHistory.complete(context, ADDRESS, CONVERSATION, false, "b".repeat(64),
            "report.pdf", report, 6);
        android.os.SystemClock.sleep(5);
        ArtifactDownloadHistory.complete(context, ADDRESS, CONVERSATION, false, "c".repeat(64),
            "preview.png", image, 5);
        launchDownloads();
        awaitRows(2);

        ui(() -> root().findViewWithTag("downloadedArtifactsSelectAll").performClick());
        ui(() -> {
            View first = root().findViewWithTag("downloadedArtifactSelect:0");
            View second = root().findViewWithTag("downloadedArtifactSelect:1");
            assertTrue(first.isSelected());
            assertTrue(second.isSelected());
            assertTrue(root().findViewWithTag("downloadedArtifactsDeleteSelected").isEnabled());
        });
        ui(() -> root().findViewWithTag("downloadedArtifactsDeleteSelected").performClick());
        ui(() -> dialog().getButton(AlertDialog.BUTTON_POSITIVE).performClick());
        await(() -> ArtifactDownloadHistory.all(context).isEmpty());
        await(() -> root().findViewWithTag("downloadedArtifact:0") == null);
        List<Uri> files = DownloadDirectoryFixture.files(context);
        assertFalse(files.contains(report));
        assertFalse(files.contains(image));
    }

    public void testMissingFileOffersRecordRemovalWithoutOpen() throws Exception {
        Context context = getInstrumentation().getTargetContext();
        Uri file = download("removed.pdf", "report");
        ArtifactDownloadHistory.complete(context, ADDRESS, CONVERSATION, false, "d".repeat(64),
            "removed.pdf", file, 6);
        assertTrue(DocumentsContract.deleteDocument(context.getContentResolver(), file));
        launchDownloads();
        awaitRows(1);
        ui(() -> {
            assertNull(root().findViewWithTag("downloadedArtifactOpen:0"));
            View remove = root().findViewWithTag("downloadedArtifactDelete:0");
            assertNotNull(remove);
            remove.performClick();
        });
        ui(() -> dialog().getButton(AlertDialog.BUTTON_POSITIVE).performClick());
        await(() -> ArtifactDownloadHistory.all(context).isEmpty());
        assertNotNull(root().findViewWithTag("settingsEmptyState"));
    }

    public void testRepeatedDownloadsKeepEveryDestinationAndOpenTheNewest() throws Exception {
        Context context = getInstrumentation().getTargetContext();
        String artifact = "e".repeat(64);
        Uri first = download("report.pdf", "first");
        ArtifactDownloadHistory.complete(context, ADDRESS, CONVERSATION, false, artifact,
            "report.pdf", first, 5);
        android.os.SystemClock.sleep(5);
        Uri second = download("report.pdf", "second");
        ArtifactDownloadHistory.complete(context, ADDRESS, CONVERSATION, false, artifact,
            "report.pdf", second, 6);

        assertEquals(2, ArtifactDownloadHistory.all(context).size());
        assertEquals(second, ArtifactDownloadHistory.find(context, ADDRESS, CONVERSATION, false, artifact).destination);
    }

    private Uri download(String name, String content) throws Exception {
        Context context = getInstrumentation().getTargetContext();
        Uri file = DownloadDirectory.createFile(context, DownloadDirectoryFixture.TREE, name);
        created.add(file);
        try (var output = context.getContentResolver().openOutputStream(file, "wt")) {
            output.write(content.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
        return file;
    }

    private void launchDownloads() throws Exception {
        Context context = getInstrumentation().getTargetContext();
        activity = LocalChatFixture.start(getInstrumentation(), new Intent(context, SettingsActivity.class)
            .putExtra("section", "downloads").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        await(() -> root().findViewWithTag("downloadedArtifactsLoading") == null
            || root().findViewWithTag("downloadedArtifactList") != null
            || root().findViewWithTag("settingsEmptyState") != null);
    }

    private void awaitRows(int count) throws Exception {
        await(() -> {
            View list = root().findViewWithTag("downloadedArtifactList");
            return list instanceof LinearLayout && ((LinearLayout) list).getChildCount() == count;
        });
        getInstrumentation().waitForIdleSync();
    }

    private AlertDialog dialog() throws Exception {
        var field = SettingsActivity.class.getDeclaredField("dialog");
        field.setAccessible(true);
        AlertDialog dialog = (AlertDialog) field.get(activity);
        assertNotNull(dialog);
        return dialog;
    }

    private View root() { return activity.getWindow().getDecorView(); }

    private interface Check { void run() throws Exception; }
    private interface Condition { boolean ready() throws Exception; }

    private void ui(Check check) throws Exception {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> {
            try {
                check.run();
            } catch (Throwable error) {
                failure.set(error);
            }
        });
        if (failure.get() instanceof Exception) throw (Exception) failure.get();
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    private void await(Condition condition) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + 15_000;
        do {
            boolean[] ready = {false};
            ui(() -> ready[0] = condition.ready());
            if (ready[0]) return;
            getInstrumentation().waitForIdleSync();
            android.os.SystemClock.sleep(50);
        } while (android.os.SystemClock.elapsedRealtime() < deadline);
        fail("Downloaded artifact UI did not reach the expected state");
    }
}
