package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

public class InlineImageTest extends InstrumentationTestCase {
    private Activity start() {
        return getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    public void testOnlyExplicitMarkdownImagesLoadAndFailuresKeepAltText() throws Exception {
        Activity activity = start();
        try {
            getInstrumentation().runOnMainSync(() -> {
                List<String> loaded = new ArrayList<>();
                Bitmap bitmap = Bitmap.createBitmap(40, 24, Bitmap.Config.ARGB_8888); bitmap.eraseColor(Color.BLUE);
                MarkdownView.ImageLoader loader = new MarkdownView.ImageLoader() {
                    @Override public void load(String reference, MarkdownView.ImageCallback callback) {
                        loaded.add(reference);
                        if (reference.equals("missing.png")) callback.failed(); else callback.loaded(bitmap);
                    }
                    @Override public void close() { }
                };
                MarkdownView renderer = new MarkdownView(activity, Color.BLACK, Color.GRAY, Color.LTGRAY, Color.BLUE, loader);
                View root = renderer.render("Before\n\n![chart](assets/chart.png)\n\n[ordinary file](assets/other.png)\n\n"
                    + "![missing](missing.png)\n\n![not an image](assets/readme.txt)\n\n```text\n![code](code.png)\n```");
                assertEquals(2, tagged(root, "markdownInlineImage").size());
                assertEquals(1, tagged(root, "markdownInlineImageBitmap").size());
                assertEquals(1, tagged(root, "markdownInlineImageFallback").size());
                assertEquals(List.of("assets/chart.png", "missing.png"), loaded);
                assertNotNull(findText(root, "Before")); assertNotNull(findText(root, "ordinary file"));
                assertNotNull(findText(root, "missing")); assertNotNull(findText(root, "not an image")); assertNotNull(findText(root, "code"));
                renderer.close();
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testStreamingCompletionBindsImageAndDisposeClosesLoader() throws Exception {
        Activity activity = start();
        AtomicReference<StreamingMarkdownView> body = new AtomicReference<>();
        List<String> loaded = new ArrayList<>(); AtomicReference<Boolean> closed = new AtomicReference<>(false);
        try {
            getInstrumentation().runOnMainSync(() -> {
                MarkdownView renderer = new MarkdownView(activity, Color.BLACK, Color.GRAY, Color.LTGRAY, Color.BLUE);
                body.set(new StreamingMarkdownView(activity, renderer, new StreamingMarkdownView.Listener() {
                    @Override public void before() { }
                    @Override public void after() { }
                }));
                activity.setContentView(body.get()); body.get().update("![chart](assets/chart.png)", false);
            });
            await(() -> body.get().idle());
            getInstrumentation().runOnMainSync(() -> {
                assertEquals(0, tagged(body.get(), "markdownInlineImage").size());
                Bitmap bitmap = Bitmap.createBitmap(32, 32, Bitmap.Config.ARGB_8888); bitmap.eraseColor(Color.GREEN);
                body.get().imageLoader(new MarkdownView.ImageLoader() {
                    @Override public void load(String reference, MarkdownView.ImageCallback callback) { loaded.add(reference); callback.loaded(bitmap); }
                    @Override public void close() { closed.set(true); }
                });
                body.get().update("![chart](assets/chart.png)", true);
            });
            await(() -> body.get().idle() && !tagged(body.get(), "markdownInlineImageBitmap").isEmpty());
            getInstrumentation().runOnMainSync(() -> {
                assertEquals(List.of("assets/chart.png"), loaded); assertNotNull(body.get().findViewWithTag("markdownInlineImageBitmap"));
                body.get().dispose(); assertTrue(closed.get());
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testOnlyExplicitMarkdownVideosRenderAsInlineCards() throws Exception {
        Activity activity = start();
        try {
            getInstrumentation().runOnMainSync(() -> {
                List<String> loaded = new ArrayList<>();
                MarkdownView.ImageLoader loader = new MarkdownView.ImageLoader() {
                    @Override public void load(String reference, MarkdownView.ImageCallback callback) { callback.failed(); }
                    @Override public void loadVideo(String reference, MarkdownView.VideoCallback callback) { loaded.add(reference); }
                    @Override public void close() { }
                };
                MarkdownView renderer = new MarkdownView(activity, Color.BLACK, Color.GRAY, Color.LTGRAY, Color.BLUE, loader);
                View root = renderer.render("Before\n\n![演示](assets/demo.mp4)\n\n[ordinary file](assets/demo.mp4)\n\n"
                    + "![not a video](assets/readme.txt)\n\n```text\n![code](code.webm)\n```");
                assertEquals(1, tagged(root, "markdownInlineVideo").size());
                assertEquals(1, tagged(root, "markdownInlineVideoCard").size());
                assertNotNull(root.findViewWithTag("markdownInlineVideoCard"));
                root.findViewWithTag("markdownInlineVideoCard").performClick();
                assertEquals(List.of("assets/demo.mp4"), loaded);
                assertNotNull(findText(root, "Before")); assertNotNull(findText(root, "ordinary file"));
                assertNotNull(findText(root, "not a video")); assertNotNull(findText(root, "code"));
                renderer.close();
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testRemoteSnapshotCompletionDisplaysInlineImage() throws Exception {
        Activity activity = start(); String id = "12345678-1234-1234-1234-123456789abc";
        List<String> loaded = new ArrayList<>(); AtomicReference<StreamingMarkdownView> body = new AtomicReference<>();
        JSONObject snapshot = new JSONObject().put("instanceId", "inline-image-test").put("cursor", 1).put("permission", "read")
            .put("conversation", new JSONObject().put("id", id).put("seq", 1)).put("nextBefore", JSONObject.NULL)
            .put("messages", new org.json.JSONArray().put(new JSONObject().put("seq", 1).put("role", "user").put("text", "Question")))
            .put("live", new JSONObject().put("runId", 44).put("userSeq", 1).put("startedAt", 1790056900000L).put("text", "![chart](assets/chart.png)"));
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var conversation = MainActivity.class.getDeclaredField("conversationId"); conversation.setAccessible(true); conversation.set(activity, id);
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                    var factory = MainActivity.class.getDeclaredField("inlineImageFactory"); factory.setAccessible(true);
                    factory.set(activity, (java.util.function.Function<Long, MarkdownView.ImageLoader>) seq -> new MarkdownView.ImageLoader() {
                        @Override public void load(String reference, MarkdownView.ImageCallback callback) {
                            loaded.add(reference); Bitmap bitmap = Bitmap.createBitmap(40, 24, Bitmap.Config.ARGB_8888); bitmap.eraseColor(Color.BLUE); callback.loaded(bitmap);
                        }
                        @Override public void close() { }
                    });
                    var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true); apply.invoke(activity, snapshot);
                } catch (Exception error) { throw new AssertionError(error); }
            });
            await(() -> findText(activity.getWindow().getDecorView(), "chart") != null);
            getInstrumentation().runOnMainSync(() -> body.set((StreamingMarkdownView) findText(activity.getWindow().getDecorView(), "chart").getParent()));
            await(() -> body.get().idle());
            getInstrumentation().runOnMainSync(() -> {
                try {
                    assertEquals(0, tagged(activity.getWindow().getDecorView(), "markdownInlineImage").size());
                    snapshot.put("cursor", 2).put("live", JSONObject.NULL);
                    snapshot.getJSONObject("conversation").put("seq", 2);
                    snapshot.getJSONArray("messages").put(new JSONObject().put("seq", 2).put("role", "assistant").put("at", 1790057010000L).put("text", "![chart](assets/chart.png)"));
                    var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true); apply.invoke(activity, snapshot);
                } catch (Exception error) { throw new AssertionError(error); }
            });
            await(() -> !tagged(activity.getWindow().getDecorView(), "markdownInlineImageBitmap").isEmpty());
            getInstrumentation().runOnMainSync(() -> {
                assertEquals(List.of("assets/chart.png"), loaded);
                assertNotNull(activity.getWindow().getDecorView().findViewWithTag("messageArtifacts:message:2"));
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testRemoteLoaderResolvesSelectedArtifactAndDecodesImage() throws Exception {
        Activity activity = start();
        String conversation = "12345678-1234-1234-1234-123456789abc", id = "a".repeat(64);
        ByteArrayOutputStream png = new ByteArrayOutputStream();
        Bitmap source = Bitmap.createBitmap(48, 32, Bitmap.Config.ARGB_8888); source.eraseColor(Color.RED); source.compress(Bitmap.CompressFormat.PNG, 100, png);
        AtomicReference<String> query = new AtomicReference<>(), download = new AtomicReference<>();
        InlineRemoteImages loader = new InlineRemoteImages(activity, "http://100.64.0.1:43127", "t".repeat(43), conversation, 17,
            address -> new RemoteApi(address) {
                @Override public JSONObject json(String path, String token, JSONObject payload) {
                    query.set(path);
                    try {
                        JSONObject file = new JSONObject().put("name", "chart.png").put("id", id).put("size", png.size()).put("extension", "png");
                        return new JSONObject().put("artifacts", new org.json.JSONArray().put(file)).put("nextOffset", JSONObject.NULL);
                    } catch (Exception error) { throw new AssertionError(error); }
                }
                @Override public void download(String path, String token, java.io.OutputStream output, long expectedSize, DownloadProgress progress) throws java.io.IOException {
                    download.set(path); output.write(png.toByteArray()); progress.update(expectedSize, expectedSize);
                }
            });
        AtomicReference<Bitmap> decoded = new AtomicReference<>(); CountDownLatch ready = new CountDownLatch(1);
        try {
            getInstrumentation().runOnMainSync(() -> loader.load("assets/chart.png", new MarkdownView.ImageCallback() {
                @Override public void loaded(Bitmap bitmap) { decoded.set(bitmap); ready.countDown(); }
                @Override public void failed() { ready.countDown(); }
            }));
            assertTrue("Image callback timed out", ready.await(10, TimeUnit.SECONDS));
            assertNotNull(decoded.get()); assertEquals(48, decoded.get().getWidth()); assertEquals(32, decoded.get().getHeight());
            assertEquals("/v1/conversations/" + conversation + "/artifacts?offset=0&seq=17&reference=assets%2Fchart.png", query.get());
            assertEquals("/v1/conversations/" + conversation + "/artifacts/" + id, download.get());
        } finally { loader.close(); getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testImageReferenceRecognitionSkipsOrdinaryLinksAndCodeFences() {
        assertTrue(InlineRemoteImages.supported("assets/icon.png"));
        assertTrue(InlineRemoteImages.supported("D:/Code/Camellia/assets/photo.JPEG"));
        assertTrue(InlineRemoteImages.supported("https://example.com/chart.png?size=large"));
        assertTrue(InlineRemoteImages.supported("assets/demo.mp4"));
        assertTrue(InlineRemoteImages.supportedVideo("D:/Code/Camellia/assets/demo.MOV"));
        assertTrue(InlineRemoteImages.supportedVideo("https://example.com/demo.webm?download=1"));
        assertFalse(InlineRemoteImages.supported("assets/vector.svg"));
        assertFalse(InlineRemoteImages.supportedImage("assets/demo.mp4"));
        assertFalse(InlineRemoteImages.supported("https://user:secret@example.com/chart.png"));
        assertTrue(InlineRemoteImages.hasSupportedImage("![chart](assets/chart.png)"));
        assertTrue(InlineRemoteImages.hasSupportedMedia("![demo](assets/demo.mp4)"));
        assertFalse(InlineRemoteImages.hasSupportedImage("[ordinary](assets/chart.png)"));
        assertFalse(InlineRemoteImages.hasSupportedImage("```text\n![chart](assets/chart.png)\n```"));
    }

    public void testRemoteLoaderDownloadsVideoArtifactToCache() throws Exception {
        Activity activity = start();
        String conversation = "12345678-1234-1234-1234-123456789abc";
        String id = (java.util.UUID.randomUUID().toString() + java.util.UUID.randomUUID()).replace("-", "");
        byte[] bytes = new byte[2048]; java.util.Arrays.fill(bytes, (byte) 7);
        AtomicReference<String> query = new AtomicReference<>(), download = new AtomicReference<>();
        InlineRemoteImages loader = new InlineRemoteImages(activity, "http://100.64.0.1:43127", "t".repeat(43), conversation, 18,
            address -> new RemoteApi(address) {
                @Override public JSONObject json(String path, String token, JSONObject payload) {
                    query.set(path);
                    try {
                        JSONObject file = new JSONObject().put("name", "demo.mp4").put("id", id).put("size", bytes.length).put("extension", "mp4");
                        return new JSONObject().put("artifacts", new org.json.JSONArray().put(file)).put("nextOffset", JSONObject.NULL);
                    } catch (Exception error) { throw new AssertionError(error); }
                }
                @Override public void download(String path, String token, java.io.OutputStream output, long expectedSize, DownloadProgress progress) throws java.io.IOException {
                    download.set(path); output.write(bytes); progress.update(expectedSize, expectedSize);
                }
            });
        AtomicReference<java.io.File> saved = new AtomicReference<>(), failure = new AtomicReference<>();
        CountDownLatch ready = new CountDownLatch(1);
        try {
            getInstrumentation().runOnMainSync(() -> loader.loadVideo("assets/demo.mp4", new MarkdownView.VideoCallback() {
                @Override public void loaded(java.io.File file) { saved.set(file); ready.countDown(); }
                @Override public void failed() { failure.set(new java.io.File("failed")); ready.countDown(); }
            }));
            assertTrue("Video callback timed out", ready.await(10, TimeUnit.SECONDS));
            assertNull(failure.get()); assertNotNull(saved.get());
            assertEquals(bytes.length, saved.get().length());
            assertEquals("/v1/conversations/" + conversation + "/artifacts?offset=0&seq=18&reference=assets%2Fdemo.mp4", query.get());
            assertEquals("/v1/conversations/" + conversation + "/artifacts/" + id, download.get());
        } finally { loader.close(); getInstrumentation().runOnMainSync(activity::finish); }
    }

    private void await(java.util.function.BooleanSupplier condition) throws Exception {
        long end = android.os.SystemClock.uptimeMillis() + 10_000;
        while (android.os.SystemClock.uptimeMillis() < end) {
            getInstrumentation().runOnMainSync(() -> { });
            if (condition.getAsBoolean()) return;
            Thread.sleep(30);
        }
        fail("Timed out waiting for inline image");
    }

    private static List<View> tagged(View root, String tag) {
        List<View> result = new ArrayList<>();
        if (tag.equals(root.getTag())) result.add(root);
        if (root instanceof ViewGroup) for (int index = 0; index < ((ViewGroup) root).getChildCount(); index++)
            result.addAll(tagged(((ViewGroup) root).getChildAt(index), tag));
        return result;
    }

    private static android.widget.TextView findText(View root, String value) {
        if (root instanceof android.widget.TextView && ((android.widget.TextView) root).getText().toString().contains(value)) return (android.widget.TextView) root;
        if (root instanceof ViewGroup) for (int index = 0; index < ((ViewGroup) root).getChildCount(); index++) {
            android.widget.TextView found = findText(((ViewGroup) root).getChildAt(index), value);
            if (found != null) return found;
        }
        return null;
    }
}
