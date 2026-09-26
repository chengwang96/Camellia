package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import org.json.JSONObject;

public class ArtifactDownloadsTest extends InstrumentationTestCase {
    public void testFilesHeaderFitsIconAndFullTextHeight() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var id = MainActivity.class.getDeclaredField("conversationId"); id.setAccessible(true); id.set(activity, "artifact-layout-test");
                    var credentials = MainActivity.class.getDeclaredField("credentials"); credentials.setAccessible(true); credentials.set(activity, new JSONObject());
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                    android.widget.TextView entry = activity.getWindow().getDecorView().findViewWithTag("remoteArtifacts");
                    assertEquals(android.view.ViewGroup.LayoutParams.WRAP_CONTENT, entry.getLayoutParams().height);
                    float originalSize = entry.getTextSize();
                    for (String label : new String[]{"产物", "Files"}) for (float scale : new float[]{1f, 1.3f, 2f}) {
                        entry.setText(label);
                        entry.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, originalSize * scale);
                        entry.measure(View.MeasureSpec.makeMeasureSpec(entry.getLayoutParams().width, View.MeasureSpec.EXACTLY),
                            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
                        entry.layout(0, 0, entry.getMeasuredWidth(), entry.getMeasuredHeight());
                        int required = entry.getLayout().getHeight() + entry.getCompoundPaddingTop() + entry.getCompoundPaddingBottom();
                        assertTrue(label + " must fit at scale " + scale, entry.getHeight() >= required);
                    }
                } catch (Throwable error) { failure.set(error); }
            });
            if (failure.get() != null) throw new AssertionError(failure.get());
        } finally {
            getInstrumentation().runOnMainSync(activity::finish); getInstrumentation().waitForIdleSync();
        }
    }

    public void testFilesEntryStaysInHeaderAndSavePickerPreservesSelection() throws Exception {
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
                    View entry = root.findViewWithTag("remoteArtifacts"); assertNotNull(entry);
                    assertTrue(entry.isEnabled()); assertNotNull(entry.getContentDescription());
                    assertTrue(entry instanceof android.widget.TextView);
                    String entryText = ((android.widget.TextView) entry).getText().toString();
                    assertTrue(entryText.equals("产物") || entryText.equals("Files"));
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
