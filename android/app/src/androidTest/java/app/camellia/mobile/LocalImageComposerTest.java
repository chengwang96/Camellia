package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageButton;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.List;

// The local composer offers the same picture flow as the remote one: one attach
// button in the tools row, the same 88 dp tiles, and a message that may consist
// of images alone.
public class LocalImageComposerTest extends InstrumentationTestCase {
    private CredentialStore encrypted;

    @Override protected void setUp() throws Exception {
        super.setUp();
        encrypted = new CredentialStore(getInstrumentation().getTargetContext(), "local-chat-private");
        encrypted.clear();
        MobilePreferences.set(getInstrumentation().getTargetContext(), "language", "zh-CN");
    }

    @Override protected void tearDown() throws Exception { encrypted.clear(); super.tearDown(); }

    public void testLocalComposerAttachesImagesAndRendersThem() throws Throwable {
        Context context = getInstrumentation().getTargetContext();
        LocalChatStore store = new LocalChatStore(context);
        JSONObject provider = new JSONObject().put("id", "example").put("name", "Example").put("protocol", "openai")
            .put("baseUrl", "https://example.com/v1").put("keys", new JSONArray().put(new JSONObject().put("key", "test-key")))
            .put("models", new JSONArray().put(new JSONObject().put("id", "gpt-5.6-sol").put("upstream", "gpt-5.6-sol")));
        store.importConfig(LocalChatConfig.parse(new JSONObject().put("format", "camellia-api-routes").put("version", 2)
            .put("config", new JSONObject().put("providers", new JSONArray().put(provider))).toString()));
        String routeId = LocalChatConfig.routes(store.config()).get(0).id;
        JSONObject conversation = store.createConversation("", routeId);
        String id = conversation.getString("id");
        LocalChatActivity activity = (LocalChatActivity) getInstrumentation().startActivitySync(new Intent(context, LocalChatActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            idle();
            ui(() -> activity.getWindow().getDecorView().findViewWithTag("localConversation:" + id).performClick());
            ui(() -> {
                View root = activity.getWindow().getDecorView();
                ViewGroup tools = (ViewGroup) root.findViewWithTag("composerTools");
                View attach = root.findViewWithTag("localAttach");
                assertTrue("The local composer needs the shared attach button", attach instanceof ImageButton);
                assertEquals(dp(activity, 48), attach.getLayoutParams().height);
                assertTrue("Attach sits with the other tools before the model button",
                    tools.indexOfChild(attach) < tools.indexOfChild(root.findViewWithTag("localModel")));
                attach.performClick();
            });
            ui(() -> {
                View decor = dialog(activity).getWindow().getDecorView();
                assertNotNull("The source sheet must match the remote one", decor.findViewWithTag("localImageGallery"));
                assertNotNull(decor.findViewWithTag("localImageCamera"));
                // The "+" sheet follows the attachment reference: square tiles on
                // top and the capability rows underneath, sharing one header.
                ViewGroup tiles = (ViewGroup) decor.findViewWithTag("attachTiles");
                assertNotNull("The tiles row must sit above the capability rows", tiles);
                assertEquals(2, tiles.getChildCount());
                for (int index = 0; index < tiles.getChildCount(); index++) {
                    View tile = tiles.getChildAt(index);
                    assertTrue("Tiles must be equal-width cards", tile.getLayoutParams().width == 0);
                    assertEquals(dp(activity, 96), tile.getLayoutParams().height);
                }
                assertNotNull("The capability rows must include web search", decor.findViewWithTag("localAttachTools"));
                ViewGroup row = (ViewGroup) decor.findViewWithTag("localAttachTools");
                assertEquals("Capability rows carry an icon, copy block and chevron", 3, row.getChildCount());
                assertTrue("Rows start with the line icon", row.getChildAt(0) instanceof android.widget.ImageView);
                assertTrue("Rows end with a chevron", row.getChildAt(2) instanceof android.widget.ImageView);
                // The value sits beside the title, never beside the subtitle, so a
                // narrow phone cannot squeeze the two into each other.
                assertEquals("The title and subtitle live in one copy block",
                    2, ((ViewGroup) row.getChildAt(1)).getChildCount());
            });
            screenshot(activity, "local-attach-sheet");
            ui(() -> dialog(activity).cancel());
            java.io.File photo = photo(activity);
            ui(() -> {
                Intent result = new Intent();
                android.content.ClipData clips = android.content.ClipData.newRawUri("images", CameraFileProvider.uri(activity, photo));
                result.setClipData(clips);
                activity.onActivityResult(61, Activity.RESULT_OK, result);
            });
            awaitImages(activity, 1);
            ui(() -> {
                View root = activity.getWindow().getDecorView();
                assertEquals(View.VISIBLE, root.findViewWithTag("localImageStrip").getVisibility());
                assertEquals(1, ((ViewGroup) root.findViewWithTag("localImageTray")).getChildCount());
                assertTrue("Images alone can be sent", root.findViewWithTag("localSend").isEnabled());
                assertEquals("", ((TextView) root.findViewWithTag("localComposer")).getText().toString());
            });
            screenshot(activity, "local-image-composer");
            String encoded = ((List<String>) field(activity, "selectedImages")).get(0);
            ui(() -> {
                try {
                    LocalChatStore activityStore = (LocalChatStore) field(activity, "store");
                    JSONObject stored = activityStore.conversation(id);
                    stored.getJSONArray("messages").put(new JSONObject().put("role", "user").put("content", "看这张图")
                        .put("images", new JSONArray().put(encoded)).put("at", System.currentTimeMillis()));
                    activityStore.save();
                    invoke(activity, "renderMessages");
                } catch (Exception error) { throw new AssertionError(error); }
            });
            ui(() -> {
                View row = activity.getWindow().getDecorView().findViewWithTag("localMessageImages:0");
                assertNotNull("A sent picture must stay visible in the transcript", row);
                ViewGroup tray = (ViewGroup) row;
                assertEquals(1, tray.getChildCount());
                ViewGroup tile = (ViewGroup) tray.getChildAt(0);
                assertTrue(tile.getChildAt(0) instanceof android.widget.ImageView);
                assertTrue(tile.getChildAt(0).getContentDescription().toString().startsWith("图片"));
                assertEquals("A sent picture has no remove button", 1, tile.getChildCount());
            });
            screenshot(activity, "local-image-message");
        } finally { getInstrumentation().runOnMainSync(activity::finish); idle(); }
    }

    private java.io.File photo(Activity activity) throws Exception {
        java.io.File directory = new java.io.File(activity.getCacheDir(), "camera");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        java.io.File file = java.io.File.createTempFile("local-image-", ".jpg", directory);
        Bitmap bitmap = Bitmap.createBitmap(160, 160, Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(0xff75a9dd);
        try (var output = new java.io.FileOutputStream(file)) { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, output); }
        finally { bitmap.recycle(); }
        return file;
    }

    private void awaitImages(Activity activity, int expected) throws Exception {
        long deadline = android.os.SystemClock.uptimeMillis() + 10_000;
        do {
            idle();
            getInstrumentation().runOnMainSync(() -> {});
            if (((List<?>) field(activity, "selectedImages")).size() >= expected) return;
            Thread.sleep(50);
        } while (android.os.SystemClock.uptimeMillis() < deadline);
        assertEquals(expected, ((List<?>) field(activity, "selectedImages")).size());
    }

    private Object field(Activity activity, String name) {
        try {
            var member = LocalChatActivity.class.getDeclaredField(name); member.setAccessible(true); return member.get(activity);
        } catch (Exception error) { throw new AssertionError(error); }
    }

    private void invoke(Activity activity, String name) {
        try {
            var method = LocalChatActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity);
        } catch (Exception error) { throw new AssertionError(error); }
    }

    private AlertDialog dialog(Activity activity) {
        try {
            var member = LocalChatActivity.class.getDeclaredField("dialog"); member.setAccessible(true); return (AlertDialog) member.get(activity);
        } catch (Exception error) { throw new AssertionError(error); }
    }

    private int dp(Activity activity, int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }

    private void screenshot(Activity activity, String name) throws Exception {
        android.os.SystemClock.sleep(600); idle();
        Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(image);
        try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), name + ".png"))) {
            image.compress(Bitmap.CompressFormat.PNG, 100, output);
        } finally { image.recycle(); }
    }

    private void ui(Runnable action) throws Throwable {
        Throwable[] failure = new Throwable[1];
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure[0] = error; } });
        idle(); if (failure[0] != null) throw failure[0];
    }

    // The local composer decodes images on a worker thread; waiting for a fully
    // idle looper is unbounded, so every wait here is capped.
    private void idle() {
        try { getInstrumentation().getUiAutomation().waitForIdle(200, 3000); }
        catch (Exception ignored) { }
    }
}
