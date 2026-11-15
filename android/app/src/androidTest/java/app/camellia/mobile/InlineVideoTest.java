package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.test.InstrumentationTestCase;
import android.widget.TextView;
import android.widget.VideoView;
import java.io.File;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

public class InlineVideoTest extends InstrumentationTestCase {
    private Activity activity;
    private InlineRemoteImages loader;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context);
        EmbeddedNetwork.setEnabled(false);
        new CredentialStore(context).clear();
        activity = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    @Override protected void tearDown() throws Exception {
        getInstrumentation().runOnMainSync(() -> {
            if (loader != null) loader.close();
            if (activity != null) activity.finish();
        });
        super.tearDown();
    }

    public void testMissingArtifactExplainsTheOriginalFileIsUnavailable() throws Exception {
        loader = new InlineRemoteImages(activity, "http://100.64.0.1:43127", "t".repeat(43), "conversation", 18,
            address -> new RemoteApi(address) {
                @Override public JSONObject json(String path, String token, JSONObject payload) {
                    try { return new JSONObject().put("artifacts", new JSONArray()); }
                    catch (Exception error) { throw new AssertionError(error); }
                }
            });
        InlineVideoView[] view = new InlineVideoView[1];
        getInstrumentation().runOnMainSync(() -> {
            view[0] = new InlineVideoView(activity, "Missing video", "old/output.mp4", Color.BLACK, Color.WHITE, loader);
            activity.setContentView(view[0]);
            view[0].findViewWithTag("markdownInlineVideoCard").performClick();
        });
        await(() -> {
            TextView caption = view[0].findViewWithTag("markdownInlineVideoCaption");
            return caption != null && (caption.getText().toString().contains("moved or deleted")
                || caption.getText().toString().contains("移动或删除"));
        });
        getInstrumentation().runOnMainSync(() -> {
            assertNull(view[0].findViewWithTag("markdownInlineVideoView"));
            assertTrue(view[0].findViewWithTag("markdownInlineVideoCard").isClickable());
        });
    }

    public void testWebVideoDownloadsPlaysAndReusesItsCache() throws Exception {
        byte[] bytes;
        try (var input = getInstrumentation().getContext().getAssets().open("inline-video-h264.mp4")) {
            var output = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            bytes = output.toByteArray();
        }
        AtomicInteger requests = new AtomicInteger();
        AtomicReference<Throwable> serverError = new AtomicReference<>();
        try (ServerSocket server = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
            Thread serving = new Thread(() -> {
                try (var socket = server.accept()) {
                    var input = new java.io.BufferedReader(new java.io.InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
                    String line;
                    while ((line = input.readLine()) != null && !line.isEmpty()) { }
                    requests.incrementAndGet();
                    var output = socket.getOutputStream();
                    output.write(("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: "
                        + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    output.write(bytes);
                    output.flush();
                } catch (Exception error) { if (!server.isClosed()) serverError.set(error); }
            }, "inline-video-fixture");
            serving.setDaemon(true);
            serving.start();
            String reference = "http://127.0.0.1:" + server.getLocalPort() + "/" + java.util.UUID.randomUUID() + ".mp4";
            loader = new InlineRemoteImages(activity, "http://100.64.0.1:43127", "t".repeat(43), "conversation", 18);
            InlineVideoView[] view = new InlineVideoView[1];
            getInstrumentation().runOnMainSync(() -> {
                view[0] = new InlineVideoView(activity, "Playable video", reference, Color.BLACK, Color.WHITE, loader);
                activity.setContentView(view[0]);
            });
            await(() -> {
                android.widget.ImageView poster = view[0].findViewWithTag("markdownInlineVideoPoster");
                return poster != null && poster.getDrawable() != null;
            });
            getInstrumentation().runOnMainSync(() -> {
                android.widget.ImageView poster = view[0].findViewWithTag("markdownInlineVideoPoster");
                android.graphics.Bitmap bitmap = ((android.graphics.drawable.BitmapDrawable) poster.getDrawable()).getBitmap();
                assertTrue(bitmap.getWidth() > 0 && bitmap.getHeight() > 0);
                assertTrue(Math.max(bitmap.getWidth(), bitmap.getHeight()) <= 960);
                java.util.Set<Integer> colors = new java.util.HashSet<>();
                for (int y = 0; y < bitmap.getHeight(); y += Math.max(1, bitmap.getHeight() / 8))
                    for (int x = 0; x < bitmap.getWidth(); x += Math.max(1, bitmap.getWidth() / 8))
                        colors.add(bitmap.getPixel(x, y));
                assertTrue("The fixture poster must contain the actual video frame", colors.size() > 3);
                assertTrue(poster.getWidth() > 0 && poster.getHeight() > 0);
                assertNull("Preparing the cover must not start video playback", view[0].findViewWithTag("markdownInlineVideoView"));
                assertTrue(view[0].findViewWithTag("markdownInlineVideoCard").isEnabled());
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().getUiAutomation().waitForIdle(200, 3000);
            android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
            try (var output = new java.io.FileOutputStream(new File(activity.getExternalCacheDir(), "inline-video-poster.png"))) {
                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
            } finally { screenshot.recycle(); }
            getInstrumentation().runOnMainSync(() -> view[0].findViewWithTag("markdownInlineVideoCard").performClick());
            await(() -> {
                VideoView video = view[0].findViewWithTag("markdownInlineVideoView");
                return video != null && video.isPlaying();
            });
            assertNull(serverError.get());
            assertEquals(1, requests.get());
            AtomicReference<File> cached = new AtomicReference<>();
            CountDownLatch ready = new CountDownLatch(1);
            getInstrumentation().runOnMainSync(() -> loader.loadVideo(reference, new MarkdownView.VideoCallback() {
                @Override public void loaded(File file) { cached.set(file); ready.countDown(); }
                @Override public void failed() { ready.countDown(); }
            }));
            assertTrue(ready.await(3, TimeUnit.SECONDS));
            assertNotNull("Successful downloads must not be turned into failures during cleanup", cached.get());
            assertEquals(bytes.length, cached.get().length());
            assertEquals(1, requests.get());
            getInstrumentation().runOnMainSync(() -> ((VideoView) view[0].findViewWithTag("markdownInlineVideoView")).stopPlayback());
            assertTrue(cached.get().delete());
        }
    }

    private void await(java.util.function.BooleanSupplier condition) throws Exception {
        long end = android.os.SystemClock.uptimeMillis() + 15_000;
        boolean[] ready = { false };
        while (android.os.SystemClock.uptimeMillis() < end) {
            getInstrumentation().runOnMainSync(() -> ready[0] = condition.getAsBoolean());
            if (ready[0]) return;
            Thread.sleep(30);
        }
        fail("Timed out waiting for inline video");
    }
}
