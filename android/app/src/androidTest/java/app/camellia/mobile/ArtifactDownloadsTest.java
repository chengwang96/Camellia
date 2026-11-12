package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import org.json.JSONObject;

public class ArtifactDownloadsTest extends InstrumentationTestCase {
    public void testFileCardOpensOnlyItsReferenceAndAllFilesRemainsSeparate() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        String conversation = "12345678-1234-1234-1234-123456789abc";
        var downloadState = ArtifactDownloadService.class.getDeclaredField("state"); downloadState.setAccessible(true);
        Object previousState = downloadState.get(null);
        java.util.concurrent.atomic.AtomicReference<String> requested = new java.util.concurrent.atomic.AtomicReference<>();
        ArtifactDownloads downloads = new ArtifactDownloads(activity, null, address -> new RemoteApi(address) {
            @Override public JSONObject json(String path, String token, JSONObject payload) throws java.io.IOException {
                requested.set(path);
                try {
                    JSONObject apk = new JSONObject().put("name", "phone.apk").put("id", "a".repeat(64)).put("size", 100).put("extension", "APK");
                    JSONObject doc = new JSONObject().put("name", "report.md").put("id", "b".repeat(64)).put("size", 30).put("extension", "MD");
                    org.json.JSONArray files = new org.json.JSONArray().put(apk);
                    if (!path.contains("&reference=")) files.put(doc);
                    return new JSONObject().put("artifacts", files).put("nextOffset", JSONObject.NULL);
                } catch (Exception error) { throw new java.io.IOException(error); }
            }
        });
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    downloadState.set(null, new ArtifactDownloadService.State("unrelated.pdf", "http://100.64.0.1:43127", 1, 1, "completed", ""));
                    var field = MainActivity.class.getDeclaredField("artifactDownloads"); field.setAccessible(true);
                    ((ArtifactDownloads) field.get(activity)).close(); field.set(activity, downloads);
                    var id = MainActivity.class.getDeclaredField("conversationId"); id.setAccessible(true); id.set(activity, conversation);
                    var credentials = MainActivity.class.getDeclaredField("credentials"); credentials.setAccessible(true);
                    credentials.set(activity, new JSONObject().put("address", "http://100.64.0.1:43127").put("token", "t".repeat(43)));
                    DownloadDirectory.clear(activity);
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                    var history = MainActivity.class.getDeclaredField("history"); history.setAccessible(true);
                    @SuppressWarnings("unchecked") java.util.TreeMap<Long, JSONObject> rows = (java.util.TreeMap<Long, JSONObject>) history.get(activity);
                    rows.clear(); rows.put(17L, new JSONObject().put("seq", 17).put("role", "assistant").put("text", "[Installer](<new build/phone.apk>)"));
                    var render = MainActivity.class.getDeclaredMethod("renderMessages", JSONObject.class); render.setAccessible(true); render.invoke(activity, new Object[]{null});
                    activity.getWindow().getDecorView().findViewWithTag("artifactAction:phone.apk").performClick();
                } catch (Exception error) { throw new AssertionError(error); }
            });
            awaitFile(downloads, "a".repeat(64));
            assertEquals("/v1/conversations/" + conversation + "/artifacts?offset=0&seq=17&reference=new+build%2Fphone.apk", requested.get());
            getInstrumentation().runOnMainSync(() -> {
                try {
                    assertEquals("the selected file name should appear once", 1,
                        exactTextCount(artifactSheet(downloads).getWindow().getDecorView(), "phone.apk"));
                    View status = artifactSheet(downloads).getWindow().getDecorView().findViewWithTag("artifactStatus");
                    assertNotNull(status);
                    assertEquals("file details should not show save-location guidance", View.GONE, status.getVisibility());
                } catch (Exception error) { throw new AssertionError(error); }
            });
            screenshot(activity, "artifact-selected-file");
            getInstrumentation().runOnMainSync(() -> {
                try {
                    ArtifactSheet sheet = artifactSheet(downloads);
                    assertNull(sheet.getWindow().getDecorView().findViewWithTag("artifactFile:" + "b".repeat(64)));
                    assertNull(sheet.getWindow().getDecorView().findViewWithTag("artifactCurrentTask"));
                    downloadState.set(null, new ArtifactDownloadService.State("unrelated.pdf", "http://100.64.0.1:43127", 0, 10, "running", ""));
                    sheet.getWindow().getDecorView().findViewWithTag("artifactDownload:" + "a".repeat(64)).performClick();
                    assertSame("a different running download must not replace the selected file", sheet, artifactSheet(downloads));
                    assertNull(sheet.getWindow().getDecorView().findViewWithTag("downloadPercent"));
                    downloadState.set(null, new ArtifactDownloadService.State("unrelated.pdf", "http://100.64.0.1:43127", 1, 1, "completed", ""));
                    View all = sheet.getWindow().getDecorView().findViewWithTag("artifactViewAll");
                    assertNotNull(all);
                    all.performClick();
                } catch (Exception error) { throw new AssertionError(error); }
            });
            awaitFile(downloads, "b".repeat(64));
            assertEquals("/v1/conversations/" + conversation + "/artifacts?offset=0", requested.get());
            screenshot(activity, "artifact-all-files");
        } finally { downloadState.set(null, previousState); getInstrumentation().runOnMainSync(() -> { downloads.close(); activity.finish(); }); }
    }

    private void screenshot(Activity activity, String name) throws Exception {
        android.os.SystemClock.sleep(600); getInstrumentation().waitForIdleSync();
        android.graphics.Bitmap bitmap = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(bitmap);
        try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), name + ".png"))) {
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
        } finally { bitmap.recycle(); }
    }

    private ArtifactSheet artifactSheet(ArtifactDownloads downloads) throws Exception {
        var field = ArtifactDownloads.class.getDeclaredField("dialog"); field.setAccessible(true); return (ArtifactSheet) field.get(downloads);
    }

    private void awaitFile(ArtifactDownloads downloads, String id) throws Exception {
        for (int attempt = 0; attempt < 60; attempt++) {
            java.util.concurrent.atomic.AtomicBoolean found = new java.util.concurrent.atomic.AtomicBoolean();
            getInstrumentation().runOnMainSync(() -> {
                try { found.set(artifactSheet(downloads).getWindow().getDecorView().findViewWithTag("artifactFile:" + id) != null); }
                catch (Exception error) { throw new AssertionError(error); }
            });
            if (found.get()) return;
            android.os.SystemClock.sleep(50);
        }
        fail("The expected artifact did not load");
    }

    private static int exactTextCount(View root, String value) {
        int count = root instanceof android.widget.TextView && value.contentEquals(((android.widget.TextView) root).getText()) ? 1 : 0;
        if (root instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup) root;
            for (int index = 0; index < group.getChildCount(); index++) count += exactTextCount(group.getChildAt(index), value);
        }
        return count;
    }

    public void testComputerSwitcherHasAccessibleTouchTarget() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var id = MainActivity.class.getDeclaredField("conversationId"); id.setAccessible(true); id.set(activity, "artifact-layout-test");
                    var credentials = MainActivity.class.getDeclaredField("credentials"); credentials.setAccessible(true); credentials.set(activity, new JSONObject());
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                    View root = activity.getWindow().getDecorView();
                    assertNull(root.findViewWithTag("remoteArtifacts"));
                    View entry = root.findViewWithTag("remoteComputerPicker");
                    assertNotNull(entry); assertNotNull(entry.getContentDescription());
                    int target = Math.round(48 * activity.getResources().getDisplayMetrics().density);
                    assertTrue(entry.getLayoutParams().width >= target); assertTrue(entry.getLayoutParams().height >= target);
                } catch (Throwable error) { failure.set(error); }
            });
            if (failure.get() != null) throw new AssertionError(failure.get());
        } finally {
            getInstrumentation().runOnMainSync(activity::finish); getInstrumentation().waitForIdleSync();
        }
    }

    public void testInlineFilesRemainAvailableAndSavePickerPreservesSelection() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var id = MainActivity.class.getDeclaredField("conversationId"); id.setAccessible(true); id.set(activity, "12345678-1234-1234-1234-123456789abc");
                    var credentials = MainActivity.class.getDeclaredField("credentials"); credentials.setAccessible(true); credentials.set(activity, new JSONObject());
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                    View root = activity.getWindow().getDecorView();
                    View entry = root.findViewWithTag("remoteComputerPicker"); assertNotNull(entry);
                    assertTrue(entry.isEnabled()); assertNotNull(entry.getContentDescription());
                    View header = (View) root.findViewWithTag("pageTitle").getParent().getParent();
                    assertSame(header, entry.getParent());
                    var history = MainActivity.class.getDeclaredField("history"); history.setAccessible(true);
                    @SuppressWarnings("unchecked")
                    java.util.TreeMap<Long, JSONObject> rows = (java.util.TreeMap<Long, JSONObject>) history.get(activity);
                    rows.put(1L, new JSONObject().put("seq", 1).put("role", "assistant").put("text", "安装包：`dist/Camellia-Android-0.3.37-debug.apk`"));
                    var render = MainActivity.class.getDeclaredMethod("renderMessages", JSONObject.class); render.setAccessible(true); render.invoke(activity, new Object[]{null});
                    View inline = root.findViewWithTag("messageArtifacts:message:1");
                    assertTrue(inline instanceof ArtifactMessageView);
                    assertNotNull(inline.findViewWithTag("artifactName:Camellia-Android-0.3.37-debug.apk"));
                    assertTrue(inline.findViewWithTag("artifactAction:Camellia-Android-0.3.37-debug.apk").hasOnClickListeners());
                    var field = MainActivity.class.getDeclaredField("artifactDownloads"); field.setAccessible(true);
                    ArtifactDownloads downloads = (ArtifactDownloads) field.get(activity);
                    var pending = ArtifactDownloads.class.getDeclaredField("pending"); pending.setAccessible(true);
                    pending.set(downloads, new JSONObject().put("name", "报告.pdf").put("id", "a".repeat(64)).put("address", "http://100.64.0.1:43127"));
                    android.os.Bundle saved = new android.os.Bundle(); downloads.save(saved); downloads.stop();
                    ArtifactDownloads restored = new ArtifactDownloads(activity, saved);
                    assertEquals("报告.pdf", ((JSONObject) pending.get(restored)).getString("name"));
                    assertFalse(saved.getString("artifactSave").contains("token"));
                    restored.result(Activity.RESULT_CANCELED, null, "", ""); assertNull(pending.get(restored)); restored.close();
                } catch (Throwable error) { failure.set(error); }
            });
            if (failure.get() != null) throw new AssertionError(failure.get());
        } finally {
            getInstrumentation().runOnMainSync(activity::finish); getInstrumentation().waitForIdleSync();
        }
    }

    public void testStreamingRejectsTruncationOverflowAndCancellation() throws Exception {
        RemoteApi client = new RemoteApi("http://100.64.0.1:43127");
        var copy = RemoteApi.class.getDeclaredMethod("copyDownload", java.io.InputStream.class, java.io.OutputStream.class, long.class, RemoteApi.DownloadProgress.class);
        copy.setAccessible(true);
        byte[] bytes = new byte[130000]; for (int index = 0; index < bytes.length; index++) bytes[index] = (byte) (index % 251);
        var output = new java.io.ByteArrayOutputStream();
        RemoteApi.DownloadProgress progress = (received, total) -> {};
        copy.invoke(client, new java.io.ByteArrayInputStream(bytes), output, (long) bytes.length, progress);
        assertTrue(java.util.Arrays.equals(bytes, output.toByteArray()));
        for (long expected : new long[]{bytes.length - 1, bytes.length + 1}) {
            try { copy.invoke(client, new java.io.ByteArrayInputStream(bytes), new java.io.ByteArrayOutputStream(), expected, progress); fail("Invalid length accepted"); }
            catch (java.lang.reflect.InvocationTargetException error) { assertTrue(error.getCause() instanceof java.io.IOException); }
        }
        client.cancel();
        try { copy.invoke(client, new java.io.ByteArrayInputStream(bytes), new java.io.ByteArrayOutputStream(), (long) bytes.length, progress); fail("Cancelled transfer accepted"); }
        catch (java.lang.reflect.InvocationTargetException error) { assertTrue(error.getCause() instanceof java.io.IOException); }
    }
}
