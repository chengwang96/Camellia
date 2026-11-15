package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.SystemClock;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public class SentImageGalleryTest extends InstrumentationTestCase {
    private static final String ID = "12345678-1234-1234-1234-123456789abc", TOKEN = "a".repeat(43);
    private Activity activity;
    private boolean embedded;
    private final List<String> references = new ArrayList<>();
    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        var error = new AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable failure) { error.set(failure); } });
        if (error.get() != null) throw new AssertionError(error.get());
    }
    @Override protected void setUp() throws Exception {
        super.setUp(); var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); embedded = EmbeddedNetwork.enabled(); EmbeddedNetwork.setEnabled(false);
        new CredentialStore(context).clear();
        activity = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }
    @Override protected void tearDown() throws Exception {
        ui(() -> { InlineImageGallery.close(activity); activity.finish(); }); getInstrumentation().waitForIdleSync();
        for (String reference : references) AttachmentStore.remove(getInstrumentation().getTargetContext(), reference);
        EmbeddedNetwork.setEnabled(embedded); super.tearDown();
    }
    private InlineImageGallery.GalleryView gallery() throws Exception {
        var field = InlineImageGallery.class.getDeclaredField("active"); field.setAccessible(true);
        return (InlineImageGallery.GalleryView) field.get(null);
    }
    private void ready(String name) throws Exception {
        AtomicBoolean ready = new AtomicBoolean(); long deadline = SystemClock.elapsedRealtime() + 6000;
        do {
            ui(() -> { var current = gallery(); ready.set(current != null && current.current().alt().equals(name) && current.current().bitmap() != null && current.share.isEnabled()); });
            if (!ready.get()) SystemClock.sleep(20);
        } while (!ready.get() && SystemClock.elapsedRealtime() < deadline);
        assertTrue("Gallery should load the larger image: " + name, ready.get());
    }
    private static byte[] jpeg(int color, int width, int height) {
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888); bitmap.eraseColor(color);
        ByteArrayOutputStream output = new ByteArrayOutputStream(); bitmap.compress(Bitmap.CompressFormat.JPEG, 90, output); bitmap.recycle();
        return output.toByteArray();
    }

    public void testRemoteSentImagesJoinReplyGalleryAndReuseAuthenticatedDownloads() throws Exception {
        try (Server server = new Server(jpeg(Color.RED, 1200, 900), jpeg(Color.GREEN, 900, 1500))) {
            String address = "http://100.64.0.1:" + server.socket.getLocalPort();
            ui(() -> {
                JSONArray files = new JSONArray()
                    .put(new JSONObject().put("name", "first.jpg").put("isImage", true).put("size", server.first.length))
                    .put(new JSONObject().put("name", "notes.pdf").put("isImage", false))
                    .put(new JSONObject().put("name", "second.jpg").put("isImage", true));
                LinearLayout root = new LinearLayout(activity); root.setOrientation(LinearLayout.VERTICAL);
                View attachments = RemoteAttachmentTray.create(activity, new ChatStyle(activity), files, 17, address, TOKEN, ID, false, target -> {
                    try { return localApi(target, server); } catch (Exception error) { throw new IllegalStateException(error); }
                });
                root.addView(attachments);
                Bitmap reply = Bitmap.createBitmap(40, 30, Bitmap.Config.ARGB_8888); reply.eraseColor(Color.BLUE);
                root.addView(new InlineImageView(activity, "Reply", "reply.png", Color.BLACK, new MarkdownView.ImageLoader() {
                    @Override public void load(String reference, MarkdownView.ImageCallback callback) { callback.loaded(reply); }
                    @Override public void close() { }
                }));
                activity.setContentView(root);
                assertTrue(attachments.findViewWithTag("remoteAttachmentImage:2").performClick());
                assertEquals(3, gallery().images.size()); assertEquals("2 / 3", gallery().counter.getText().toString());
            });
            ready("second.jpg");
            ui(() -> {
                Bitmap bitmap = gallery().current().bitmap(); assertTrue(bitmap.getHeight() > 288);
                assertTrue(Color.green(bitmap.getPixel(0, 0)) > 200); assertTrue(gallery().save.isEnabled());
                ImageView thumbnail = activity.getWindow().getDecorView().<View>findViewWithTag("remoteAttachmentImage:2").findViewWithTag("attachmentImagePreview");
                assertEquals(ImageView.ScaleType.FIT_CENTER, thumbnail.getScaleType());
                gallery().previous();
            });
            ready("first.jpg");
            ui(() -> { assertTrue(Color.red(gallery().current().bitmap().getPixel(0, 0)) > 200); gallery().next(); gallery().next(); });
            ready("Reply");
            ui(() -> {
                // Revisit an evicted large image: it must load again, using
                // cached bytes rather than getting stuck in the requested set.
                var cache = AttachmentImages.class.getDeclaredField("IMAGES"); cache.setAccessible(true);
                ((android.util.LruCache<?, ?>) cache.get(null)).evictAll(); gallery().previous();
            });
            ready("second.jpg");
            assertEquals(2, server.paths.size());
            assertTrue(server.paths.contains("/v1/conversations/" + ID + "/attachments/17/0"));
            assertTrue(server.paths.contains("/v1/conversations/" + ID + "/attachments/17/2"));
            assertEquals(0, server.invalid.get());
            getInstrumentation().waitForIdleSync(); SystemClock.sleep(200);
            Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
            try (FileOutputStream output = new FileOutputStream(new File(activity.getExternalFilesDir(null), "sent-image-gallery.png"))) {
                screenshot.compress(Bitmap.CompressFormat.PNG, 100, output);
            } finally { screenshot.recycle(); }
        }
    }

    public void testLocalSentImagesUseFullEncryptedAttachmentAndExcludeComposerImages() throws Exception {
        String first = AttachmentStore.save(activity, jpeg(Color.RED, 1200, 900)); references.add(first);
        String second = AttachmentStore.save(activity, jpeg(Color.GREEN, 900, 1500)); references.add(second);
        AttachmentStore.savePreview(activity, first, jpeg(Color.RED, 60, 45)); AttachmentStore.savePreview(activity, second, jpeg(Color.GREEN, 36, 60));
        ui(() -> {
            LinearLayout root = new LinearLayout(activity); root.setOrientation(LinearLayout.VERTICAL);
            LinearLayout sent = new LinearLayout(activity), pending = new LinearLayout(activity);
            ChatImageTray.fill(activity, sent, List.of(first, second), Color.WHITE, false, null);
            ChatImageTray.fill(activity, pending, List.of(first), Color.WHITE, false, index -> fail("Opening sent images must not remove a pending attachment"));
            root.addView(sent); root.addView(pending); activity.setContentView(root);
            AttachmentImageView tile = (AttachmentImageView) ((android.view.ViewGroup) sent.getChildAt(1)).getChildAt(0);
            assertTrue(tile.performClick()); assertEquals(2, gallery().images.size()); assertEquals("2 / 2", gallery().counter.getText().toString());
        });
        ready("Image 2");
        ui(() -> { assertTrue(gallery().current().bitmap().getHeight() > 288); assertTrue(gallery().save.isEnabled()); assertTrue(gallery().share.isEnabled()); });
    }

    public void testAttachmentCacheSeparatesCredentialsAndRejectsOversizedImages() throws Exception {
        AtomicInteger calls = new AtomicInteger(); String address = "http://100.80.1.2:43127";
        java.util.function.Function<String, RemoteApi> clients = target -> new RemoteApi(target) {
            @Override public byte[] bytes(String path, String token, int limit) { calls.incrementAndGet(); return jpeg(token.equals(TOKEN) ? Color.RED : Color.GREEN, 400, 300); }
        };
        long seq = SystemClock.elapsedRealtime();
        Bitmap first = load(AttachmentImages.remote(address, TOKEN, ID, seq, 0, -1, clients));
        Bitmap second = load(AttachmentImages.remote(address, "b".repeat(43), ID, seq, 0, -1, clients));
        assertTrue(Color.red(first.getPixel(0, 0)) > 200); assertTrue(Color.green(second.getPixel(0, 0)) > 200); assertEquals(2, calls.get());
        assertNull(load(AttachmentImages.remote(address, TOKEN, ID, seq, 0, ChatAttachments.IMAGE_MAX_BYTES + 1L, clients)));
        assertEquals(2, calls.get());
    }
    private Bitmap load(AttachmentImages.Source source) throws Exception {
        CountDownLatch complete = new CountDownLatch(1); AtomicReference<Bitmap> result = new AtomicReference<>();
        ui(() -> source.load(new MarkdownView.ImageCallback() {
            @Override public void loaded(Bitmap bitmap) { result.set(bitmap); complete.countDown(); }
            @Override public void failed() { complete.countDown(); }
        }));
        assertTrue(complete.await(6, TimeUnit.SECONDS)); return result.get();
    }
    private RemoteApi localApi(String address, Server server) throws Exception {
        RemoteApi client = new RemoteApi(address);
        var endpoint = RemoteApi.class.getDeclaredField("endpoint"); endpoint.setAccessible(true);
        var origin = Endpoint.class.getDeclaredField("origin"); origin.setAccessible(true);
        origin.set(endpoint.get(client), "http://127.0.0.1:" + server.socket.getLocalPort()); return client;
    }
    private static final class Server implements AutoCloseable {
        final byte[] first, second;
        final ServerSocket socket = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        final ExecutorService workers = Executors.newFixedThreadPool(3);
        final List<String> paths = new CopyOnWriteArrayList<>(); final AtomicInteger invalid = new AtomicInteger();
        final Thread accept;
        Server(byte[] first, byte[] second) throws Exception {
            this.first = first; this.second = second;
            accept = new Thread(() -> {
                while (!socket.isClosed()) try { Socket peer = socket.accept(); workers.execute(() -> serve(peer)); }
                catch (IOException closed) { break; }
            }); accept.start();
        }
        private void serve(Socket peer) {
            try (peer) {
                peer.setSoTimeout(5000); var input = new BufferedReader(new InputStreamReader(peer.getInputStream(), StandardCharsets.US_ASCII));
                String path = input.readLine().split(" ")[1]; paths.add(path); boolean authorized = false;
                String header; while ((header = input.readLine()) != null && !header.isEmpty()) if (header.equals("Authorization: Bearer " + TOKEN)) authorized = true;
                if (!authorized || !(path.endsWith("/17/0") || path.endsWith("/17/2"))) { invalid.incrementAndGet(); return; }
                byte[] bytes = path.endsWith("/0") ? first : second; var output = peer.getOutputStream();
                output.write(("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                output.write(bytes); output.flush();
            } catch (IOException ignored) { }
        }
        @Override public void close() throws Exception { socket.close(); accept.join(2000); workers.shutdownNow(); workers.awaitTermination(5, TimeUnit.SECONDS); }
    }
}
