package app.camellia.mobile;

import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;

public class RemoteFeedbackTest extends InstrumentationTestCase {
    private static final String ID = "12345678-1234-1234-1234-123456789abc";
    private MainActivity activity;
    private CredentialStore encrypted;
    private CredentialStore cacheStorage;
    private RemoteListCache cache;
    private DelayedApi client;

    private static final class DelayedApi extends RemoteApi {
        final CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        JSONObject result;
        IOException failure;
        final java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger();
        final CountDownLatch retried = new CountDownLatch(1);
        boolean pendingFirst;
        String requestId;
        DelayedApi() { super("http://100.64.0.1:43128"); }
        @Override public JSONObject json(String path, String token, JSONObject payload) throws IOException {
            entered.countDown();
            try { if (!release.await(10, TimeUnit.SECONDS)) throw new IOException("Test timeout"); }
            catch (InterruptedException error) { throw new IOException(error); }
            if (failure != null) throw failure;
            if (pendingFirst) {
                if (calls.incrementAndGet() == 1) {
                    requestId = payload.optString("requestId");
                    try { return new JSONObject().put("state", "pending"); }
                    catch (Exception error) { throw new IOException(error); }
                }
                if (!requestId.equals(payload.optString("requestId"))) throw new IOException("Request changed on retry");
                retried.countDown();
            }
            return result;
        }
    }

    private Object field(String name) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); return member.get(activity);
    }

    private void field(String name, Object value) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); member.set(activity, value);
    }

    private void invoke(String name) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity);
    }

    private void invoke(String name, JSONObject value) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name, JSONObject.class); method.setAccessible(true); method.invoke(activity, value);
    }

    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Exception error) { throw new AssertionError(error); } });
    }

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        encrypted = new CredentialStore(context, "remote-feedback-test"); encrypted.clear();
        cacheStorage = new CredentialStore(context, "remote-feedback-cache-test"); cacheStorage.clear();
        cache = new RemoteListCache(cacheStorage);
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            invoke("stopNetwork");
            ((RemoteListCache) field("listCache")).close(); field("listCache", cache);
            field("store", new ComputerStore(encrypted));
            field("credentials", new JSONObject().put("address", "http://100.64.0.1:43128").put("token", "a".repeat(43)));
            field("conversationId", ID); invoke("detailScreen");
            field("foreground", true); field("connected", true); field("controlAllowed", true);
            field("instance", "server"); field("conversationSeq", 10L);
            client = new DelayedApi(); field("api", client);
        });
    }

    @Override protected void tearDown() throws Exception {
        if (client != null) client.release.countDown();
        ui(() -> activity.finish()); getInstrumentation().waitForIdleSync();
        cache.close();
        var writer = RemoteListCache.class.getDeclaredField("writer"); writer.setAccessible(true);
        assertTrue(((ExecutorService) writer.get(cache)).awaitTermination(5, TimeUnit.SECONDS));
        encrypted.clear(); cacheStorage.clear(); super.tearDown();
    }

    private JSONObject payload() throws Exception {
        return new JSONObject().put("action", "send").put("requestId", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
            .put("instanceId", "server").put("expectedSeq", 10).put("prompt", "instant message");
    }

    private void send() throws Exception {
        ui(() -> {
            ((EditText) field("composer")).setText("instant message");
            invoke("submitCommand", payload());
            assertEquals("", ((EditText) field("composer")).getText().toString());
            assertEquals(1, countText((View) field("messages"), "instant message"));
            assertNotNull(((View) field("messages")).findViewWithTag("outgoingDelivery"));
            assertFalse(((View) field("sendButton")).isEnabled());
        });
        assertTrue(client.entered.await(2, TimeUnit.SECONDS));
        assertEquals("instant message", new ComputerStore(encrypted).load().getJSONObject("pendingCommand").getString("draft"));
    }

    private int countText(View view, String value) {
        int count = view instanceof TextView && ((TextView) view).getText().toString().equals(value) ? 1 : 0;
        if (view instanceof ViewGroup) for (int index = 0; index < ((ViewGroup) view).getChildCount(); index++) count += countText(((ViewGroup) view).getChildAt(index), value);
        return count;
    }

    private void awaitResult() throws Exception {
        client.release.countDown();
        ((ExecutorService) field("commandWorker")).submit(() -> {}).get(3, TimeUnit.SECONDS);
        getInstrumentation().waitForIdleSync();
    }

    private JSONObject snapshot() throws Exception {
        return new JSONObject().put("instanceId", "server").put("cursor", 1).put("permission", "control")
            .put("conversation", new JSONObject().put("id", ID).put("seq", 11))
            .put("messages", new JSONArray().put(new JSONObject().put("seq", 11).put("role", "user").put("text", "instant message")));
    }

    public void testImmediateFeedbackAndSnapshotBeforeAcknowledgement() throws Exception {
        client.result = new JSONObject().put("ok", true).put("userSeq", 11);
        send();
        ui(() -> { invoke("applySnapshot", snapshot()); assertEquals(1, countText((View) field("messages"), "instant message")); });
        awaitResult();
        ui(() -> {
            assertEquals(1, countText((View) field("messages"), "instant message"));
            assertNull(field("outgoingMessage"));
            assertFalse(((JSONObject) field("credentials")).has("pendingCommand"));
        });
    }

    public void testAcknowledgementBeforeSnapshot() throws Exception {
        client.result = new JSONObject().put("ok", true).put("userSeq", 11);
        send(); awaitResult();
        ui(() -> {
            assertEquals("accepted", ((JSONObject) field("outgoingMessage")).getString("delivery"));
            assertEquals(1, countText((View) field("messages"), "instant message"));
            invoke("applySnapshot", snapshot());
            assertEquals(1, countText((View) field("messages"), "instant message"));
            assertNull(field("outgoingMessage"));
        });
    }

    public void testTimeoutKeepsSameRequestAndPendingBubble() throws Exception {
        client.failure = new java.net.SocketTimeoutException("fixture timeout");
        send(); awaitResult();
        ui(() -> {
            assertEquals("unconfirmed", ((JSONObject) field("outgoingMessage")).getString("delivery"));
            assertEquals(payload().getString("requestId"), ((JSONObject) field("credentials")).getJSONObject("pendingCommand").getJSONObject("payload").getString("requestId"));
            assertEquals(1, countText((View) field("messages"), "instant message"));
            assertFalse(((View) field("sendButton")).isEnabled());
        });
    }

    public void testRejectedSendRestoresDraftAndImage() throws Exception {
        client.result = new JSONObject().put("ok", false).put("error", "rejected");
        ui(() -> {
            ((EditText) field("composer")).setText("instant message");
            invoke("submitCommand", payload().put("image", "fixture-image"));
        });
        awaitResult();
        ui(() -> {
            assertEquals("failed", ((JSONObject) field("outgoingMessage")).getString("delivery"));
            assertEquals("instant message", ((EditText) field("composer")).getText().toString());
            assertEquals(java.util.List.of("fixture-image"), field("selectedImages"));
            assertFalse(((JSONObject) field("credentials")).has("pendingCommand"));
        });
    }

    public void testUnsentDraftSurvivesReturningToTheListAndReopeningTheConversation() throws Exception {
        ui(() -> ((EditText) field("composer")).setText("unsent remote draft"));
        ui(() -> {
            field("foreground", false);
            invoke("onBackPressed");
        });
        assertEquals("unsent remote draft", new ComputerStore(encrypted).load().getJSONObject("drafts").getString(ID));
        ui(() -> {
            field("foreground", true);
            field("conversationId", ID); field("conversationTitle", "Remote session"); invoke("detailScreen");
        });
        ui(() -> assertEquals("unsent remote draft", ((EditText) field("composer")).getText().toString()));
    }

    public void testAcceptedSendClearsTheSavedDraft() throws Exception {
        client.result = new JSONObject().put("ok", true).put("userSeq", 11);
        ui(() -> {
            ((EditText) field("composer")).setText("instant message");
            invoke("persistDraft");
        });
        assertEquals("instant message", new ComputerStore(encrypted).load().getJSONObject("drafts").getString(ID));
        send(); awaitResult();
        JSONObject drafts = new ComputerStore(encrypted).load().optJSONObject("drafts");
        assertTrue(drafts == null || !drafts.has(ID));
    }

    private TextView messageBody(View view, String value) {
        if (view instanceof TextView && ((TextView) view).getText().toString().equals(value) && view.hasOnClickListeners()) return (TextView) view;
        if (view instanceof ViewGroup) for (int index = 0; index < ((ViewGroup) view).getChildCount(); index++) {
            TextView found = messageBody(((ViewGroup) view).getChildAt(index), value);
            if (found != null) return found;
        }
        return null;
    }

    public void testTappingSentMessageBodyStartsEditingThatMessage() throws Exception {
        ui(() -> {
            invoke("applySnapshot", snapshot());
            TextView body = messageBody((View) field("messages"), "instant message");
            assertNotNull("the message text itself must accept the tap", body);
            assertTrue(body.performClick());
            assertEquals("instant message", ((EditText) field("composer")).getText().toString());
            assertEquals(11L, ((Long) field("editingSeq")).longValue());
            String status = ((TextView) field("status")).getText().toString().toLowerCase(java.util.Locale.ROOT);
            assertTrue(status.contains("编辑") || status.contains("editing"));
        });
    }

    public void testUnfinishedEditKeepsItsTargetAndClearsAfterAcceptance() throws Exception {
        client.result = new JSONObject().put("ok", true).put("userSeq", 11);
        ui(() -> {
            invoke("applySnapshot", snapshot());
            messageBody((View) field("messages"), "instant message").performClick();
            field("foreground", false);
            invoke("onBackPressed");
        });
        assertEquals(11L, new ComputerStore(encrypted).load().getJSONObject("draftEdits").getLong(ID));
        ui(() -> {
            field("foreground", true);
            field("conversationId", ID); field("conversationTitle", "Remote session"); invoke("detailScreen");
        });
        ui(() -> {
            assertEquals("instant message", ((EditText) field("composer")).getText().toString());
            assertEquals(11L, ((Long) field("editingSeq")).longValue());
            invoke("applySnapshot", snapshot());
            var send = MainActivity.class.getDeclaredMethod("sendMessage", String.class); send.setAccessible(true); send.invoke(activity, "");
            JSONObject payload = ((JSONObject) field("credentials")).getJSONObject("pendingCommand").getJSONObject("payload");
            assertEquals("resend", payload.getString("action"));
            assertEquals(11L, payload.getLong("editSeq"));
        });
        awaitResult();
        ui(() -> {
            JSONObject stored = new ComputerStore(encrypted).load();
            JSONObject drafts = stored.optJSONObject("drafts");
            assertTrue(drafts == null || !drafts.has(ID));
            JSONObject edits = stored.optJSONObject("draftEdits");
            assertTrue(edits == null || !edits.has(ID));
        });
    }

    public void testRejectedEditRestoresTheDraftAsAnEdit() throws Exception {
        client.result = new JSONObject().put("ok", false).put("error", "rejected");
        ui(() -> {
            invoke("applySnapshot", snapshot());
            messageBody((View) field("messages"), "instant message").performClick();
            var send = MainActivity.class.getDeclaredMethod("sendMessage", String.class); send.setAccessible(true); send.invoke(activity, "");
        });
        awaitResult();
        ui(() -> {
            assertEquals("instant message", ((EditText) field("composer")).getText().toString());
            assertEquals(11L, ((Long) field("editingSeq")).longValue());
        });
        assertEquals(11L, new ComputerStore(encrypted).load().getJSONObject("draftEdits").getLong(ID));
    }

    public void testClearingEditAndReopeningStillResendsTheOriginalMessage() throws Exception {
        client.result = new JSONObject().put("ok", true).put("userSeq", 12);
        ui(() -> {
            invoke("applySnapshot", snapshot());
            messageBody((View) field("messages"), "instant message").performClick();
            ((EditText) field("composer")).setText("");
            assertEquals(11L, field("editingSeq"));
            assertFalse(((View) field("sendButton")).isEnabled());
            field("foreground", false);
            invoke("onBackPressed");
        });
        assertEquals(11L, new ComputerStore(encrypted).load().getJSONObject("draftEdits").getLong(ID));
        ui(() -> {
            field("foreground", true);
            field("conversationId", ID); invoke("detailScreen");
            invoke("applySnapshot", snapshot());
            assertEquals(11L, field("editingSeq"));
            ((EditText) field("composer")).setText("Replacement message");
            var send = MainActivity.class.getDeclaredMethod("sendMessage", String.class);
            send.setAccessible(true); send.invoke(activity, "");
            JSONObject payload = ((JSONObject) field("credentials")).getJSONObject("pendingCommand").getJSONObject("payload");
            assertEquals("resend", payload.getString("action"));
            assertEquals(11L, payload.getLong("editSeq"));
            assertEquals("Replacement message", payload.getString("prompt"));
        });
        awaitResult();
    }

    public void testCachedBubblesFollowLatestUserAfterNewMessageAndHistoryReplacement() throws Exception {
        ui(() -> {
            invoke("applySnapshot", snapshot());
            JSONObject newer = snapshot().put("cursor", 2);
            newer.getJSONObject("conversation").put("seq", 12);
            newer.getJSONArray("messages").put(new JSONObject().put("seq", 12).put("role", "user").put("text", "New question"));
            invoke("applySnapshot", newer);
            assertEquals(1, countText((View) field("messages"), "instant message"));
            assertNull(messageBody((View) field("messages"), "instant message"));
            assertTrue(messageBody((View) field("messages"), "New question").performClick());
            assertEquals(12L, field("editingSeq"));
            invoke("cancelEdit");
            invoke("applySnapshot", snapshot().put("cursor", 3));
            assertTrue(messageBody((View) field("messages"), "instant message").performClick());
            assertEquals(11L, field("editingSeq"));
        });
    }

    public void testMessageCannotBeEditedWhileReplyingOrReadOnly() throws Exception {
        ui(() -> {
            invoke("applySnapshot", snapshot());
            field("lastLive", new JSONObject().put("runId", 1));
            messageBody((View) field("messages"), "instant message").performClick();
            assertEquals(-1L, field("editingSeq"));
            field("lastLive", null); field("controlAllowed", false);
            messageBody((View) field("messages"), "instant message").performClick();
            assertEquals(-1L, field("editingSeq"));
        });
    }

    @SuppressWarnings("unchecked")
    public void testMultipleImageTrayRemovesOnlySelectedImageAndHidesWhenEmpty() throws Exception {
        ui(() -> {
            java.util.ArrayList<String> images = (java.util.ArrayList<String>) field("selectedImages");
            images.addAll(java.util.List.of("aaaa", "bbbb", "cccc"));
            field("imageConversation", ID); field("imageComputer", "http://100.64.0.1:43128");
            invoke("renderImage"); invoke("updateControls");
            ViewGroup tray = (ViewGroup) field("imageTray");
            View strip = (View) field("imageStrip");
            assertEquals(3, tray.getChildCount()); assertEquals(View.VISIBLE, strip.getVisibility());
            assertTrue(((View) field("sendButton")).isEnabled());
            ((ViewGroup) tray.getChildAt(1)).getChildAt(1).performClick();
            assertEquals(java.util.List.of("aaaa", "cccc"), images);
            assertEquals(2, tray.getChildCount());
            ((ViewGroup) tray.getChildAt(0)).getChildAt(1).performClick();
            ((ViewGroup) tray.getChildAt(0)).getChildAt(1).performClick();
            assertTrue(images.isEmpty()); assertEquals(View.GONE, strip.getVisibility());
            assertFalse(((View) field("sendButton")).isEnabled());
        });
    }

    public void testGalleryMultipleSelectionAppendsAndCameraKeepsExistingImages() throws Exception {
        java.io.File directory = new java.io.File(activity.getCacheDir(), "camera");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        java.io.File photo = java.io.File.createTempFile("attachment-test-", ".jpg", directory);
        android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(160, 160, android.graphics.Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(0xff75a9dd);
        try (var output = new java.io.FileOutputStream(photo)) { bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 90, output); }
        finally { bitmap.recycle(); }
        android.net.Uri uri = CameraFileProvider.uri(activity, photo);
        try {
            ui(() -> {
                field("canMultiImage", true); field("canImage", true);
                field("imageConversation", ID); field("imageComputer", "http://100.64.0.1:43128");
                android.content.ClipData clips = android.content.ClipData.newRawUri("images", uri);
                clips.addItem(new android.content.ClipData.Item(uri));
                Intent result = new Intent(); result.setClipData(clips);
                activity.onActivityResult(42, android.app.Activity.RESULT_OK, result);
                assertFalse(((View) field("sendButton")).isEnabled());
            });
            awaitImages(2);
            ui(() -> activity.onActivityResult(42, android.app.Activity.RESULT_OK, new Intent().setData(uri)));
            awaitImages(3);
            ui(() -> {
                field("cameraImageUri", uri); field("cameraImageFile", photo);
                activity.onActivityResult(43, android.app.Activity.RESULT_OK, null);
            });
            awaitImages(4);
            getInstrumentation().waitForIdleSync();
            android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
            assertNotNull(screenshot);
            try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), "multi-image-composer.png"))) {
                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
            } finally { screenshot.recycle(); }
            ui(() -> {
                assertTrue(((View) field("sendButton")).isEnabled());
                field("conversationId", "other-conversation"); invoke("renderImage");
                assertTrue(((java.util.List<?>) field("selectedImages")).isEmpty());
                assertEquals(View.GONE, ((View) field("imageStrip")).getVisibility());
            });
        } finally { photo.delete(); }
    }

    private void awaitImages(int count) throws Exception {
        long deadline = android.os.SystemClock.elapsedRealtime() + 5000;
        boolean[] loading = {true};
        while (loading[0] && android.os.SystemClock.elapsedRealtime() < deadline) {
            getInstrumentation().waitForIdleSync();
            ui(() -> loading[0] = (boolean) field("loadingImages"));
            if (loading[0]) Thread.sleep(20);
        }
        ui(() -> {
            assertFalse((boolean) field("loadingImages"));
            assertEquals(count, ((java.util.List<?>) field("selectedImages")).size());
            assertEquals(count, ((ViewGroup) field("imageTray")).getChildCount());
        });
    }

    @SuppressWarnings("unchecked")
    public void testMultiImageSendClearsTrayAndRestoresEntireRejectedBatch() throws Exception {
        client.result = new JSONObject().put("ok", false).put("error", "rejected");
        ui(() -> {
            java.util.ArrayList<String> images = (java.util.ArrayList<String>) field("selectedImages");
            images.addAll(java.util.List.of("aaaa", "bbbb"));
            field("canMultiImage", true);
            field("imageConversation", ID); field("imageComputer", "http://100.64.0.1:43128");
            invoke("renderImage");
            ((EditText) field("composer")).setText("instant message");
            var send = MainActivity.class.getDeclaredMethod("sendMessage", String.class); send.setAccessible(true); send.invoke(activity, "");
            JSONObject payload = ((JSONObject) field("credentials")).getJSONObject("pendingCommand").getJSONObject("payload");
            assertFalse(payload.has("image")); assertEquals(2, payload.getJSONArray("images").length());
            assertTrue(images.isEmpty()); assertEquals(View.GONE, ((View) field("imageStrip")).getVisibility());
        });
        awaitResult();
        ui(() -> {
            assertEquals(java.util.List.of("aaaa", "bbbb"), field("selectedImages"));
            assertEquals("instant message", ((EditText) field("composer")).getText().toString());
            assertEquals(2, ((ViewGroup) field("imageTray")).getChildCount());
        });
    }

    public void testPendingConfirmationDeadlineAndRestoreAfterNavigation() throws Exception {
        client.result = new JSONObject().put("state", "pending");
        send();
        ui(() -> field("commandCheckDeadline", android.os.SystemClock.elapsedRealtime() - 1));
        awaitResult();
        ui(() -> {
            assertEquals("unconfirmed", ((JSONObject) field("outgoingMessage")).getString("delivery"));
            assertTrue(((JSONObject) field("credentials")).has("pendingCommand"));
            invoke("detailScreen");
            assertEquals(1, countText((View) field("messages"), "instant message"));
            assertEquals("unconfirmed", ((JSONObject) field("outgoingMessage")).getString("delivery"));
        });
    }

    public void testUnknownOutcomeRetainsRequest() throws Exception {
        client.result = new JSONObject().put("state", "unknown");
        send(); awaitResult();
        ui(() -> {
            assertEquals("unconfirmed", ((JSONObject) field("outgoingMessage")).getString("delivery"));
            assertTrue(((JSONObject) field("credentials")).has("pendingCommand"));
            assertEquals("", ((EditText) field("composer")).getText().toString());
        });
    }

    public void testPreparingAutomaticallyChecksSameRequest() throws Exception {
        client.pendingFirst = true;
        client.result = new JSONObject().put("ok", true).put("userSeq", 11);
        send(); awaitResult();
        assertTrue(client.retried.await(5, TimeUnit.SECONDS));
        ((ExecutorService) field("commandWorker")).submit(() -> {}).get(3, TimeUnit.SECONDS);
        getInstrumentation().waitForIdleSync();
        ui(() -> {
            assertFalse(((JSONObject) field("credentials")).has("pendingCommand"));
            assertEquals("accepted", ((JSONObject) field("outgoingMessage")).getString("delivery"));
        });
    }

    public void testLateAcknowledgementDoesNotChangeAnotherScreen() throws Exception {
        client.result = new JSONObject().put("ok", true).put("userSeq", 11);
        send();
        ui(() -> invoke("listScreen"));
        awaitResult();
        ui(() -> {
            assertEquals("list", field("screen"));
            assertTrue(((JSONObject) field("credentials")).has("pendingCommand"));
            assertEquals(0, countText((View) field("content"), "instant message"));
        });
    }

    public void testCachedListDisplaysBeforeNetworkAndIsScopedToCredential() throws Exception {
        ui(() -> {
            JSONObject credential = (JSONObject) field("credentials");
            cache.put(credential, new JSONArray().put(new JSONObject().put("id", ID).put("title", "Cached conversation")), -1, new JSONArray(), true);
            invoke("listScreen");
            assertNotNull(((View) field("content")).findViewWithTag("conversation:" + ID));
            assertFalse((Boolean) field("canCreate"));
            var failure = MainActivity.class.getDeclaredMethod("showFailure", Exception.class, boolean.class);
            failure.setAccessible(true); failure.invoke(activity, new java.net.SocketTimeoutException(), true);
            assertNotNull(((View) field("content")).findViewWithTag("conversation:" + ID));
            var apply = MainActivity.class.getDeclaredMethod("applyConversationPage", JSONObject.class, boolean.class);
            apply.setAccessible(true);
            apply.invoke(activity, new JSONObject().put("conversations", new JSONArray().put(new JSONObject().put("id", ID).put("title", "Fresh conversation"))), false);
            invoke("cacheConversations");
            invoke("listScreen");
            assertEquals(1, countText((View) field("content"), "Fresh conversation"));
            assertEquals(0, countText((View) field("content"), "Cached conversation"));
            field("credentials", new JSONObject(credential.toString()).put("token", "b".repeat(43)));
            invoke("listScreen");
            assertNull(((View) field("content")).findViewWithTag("conversation:" + ID));
        });
    }

    public void testCachePersistsAndRemoves() throws Exception {
        JSONObject credential = new JSONObject().put("address", "computer").put("token", "token");
        cache.put(credential, new JSONArray().put(new JSONObject().put("id", ID)), -1, new JSONArray(), true);
        cache.close();
        var writer = RemoteListCache.class.getDeclaredField("writer"); writer.setAccessible(true);
        assertTrue(((ExecutorService) writer.get(cache)).awaitTermination(5, TimeUnit.SECONDS));
        cache = new RemoteListCache(cacheStorage);
        assertEquals(ID, cache.get(credential).getJSONArray("conversations").getJSONObject(0).getString("id"));
        assertNull(cache.get(new JSONObject(credential.toString()).put("token", "another-token")));
        cache.remove(credential); assertNull(cache.get(credential));
        ui(() -> field("listCache", cache));
    }

    private void prefetch(JSONObject computer, JSONObject info, int ticket) throws Exception {
        var method = MainActivity.class.getDeclaredMethod("prefetchComputerList", RemoteApi.class, JSONObject.class, JSONObject.class, int.class);
        method.setAccessible(true); method.invoke(activity, client, computer, info, ticket);
    }

    private JSONObject historySnapshot(long sequence, Long before) throws Exception {
        return new JSONObject().put("instanceId", "server").put("cursor", 10).put("permission", "control")
            .put("conversation", new JSONObject().put("id", ID).put("seq", 10))
            .put("messages", new JSONArray().put(new JSONObject().put("seq", sequence).put("role", "assistant").put("text", "History " + sequence)))
            .put("nextBefore", before == null ? JSONObject.NULL : before);
    }

    private boolean refreshing() throws Exception {
        var member = RefreshScrollView.class.getDeclaredField("refreshing"); member.setAccessible(true);
        return member.getBoolean(field("scroll"));
    }

    private void awaitOlder() throws Exception {
        client.release.countDown();
        long deadline = android.os.SystemClock.uptimeMillis() + 5000;
        boolean[] loading = {true};
        while (loading[0] && android.os.SystemClock.uptimeMillis() < deadline) {
            ui(() -> loading[0] = (Boolean) field("olderLoading"));
            if (loading[0]) android.os.SystemClock.sleep(20);
        }
        assertFalse(loading[0]);
        getInstrumentation().waitForIdleSync();
    }

    public void testPullLoadsOlderWithSpinnerAndDisablesAtEnd() throws Exception {
        client.result = historySnapshot(1, null);
        ui(() -> {
            invoke("applySnapshot", historySnapshot(10, 10L));
            RefreshScrollView scroll = (RefreshScrollView) field("scroll");
            assertTrue(scroll.performAccessibilityAction(android.R.id.button1, null));
            assertTrue((Boolean) field("olderLoading")); assertTrue(refreshing());
            assertFalse(((View) field("older")).isEnabled());
            invoke("applySnapshot", historySnapshot(10, 10L));
            assertFalse(((View) field("older")).isEnabled());
        });
        assertTrue(client.entered.await(2, TimeUnit.SECONDS));
        awaitOlder();
        ui(() -> {
            assertFalse(refreshing());
            assertNull(field("nextBefore"));
            assertEquals(View.GONE, ((View) field("older")).getVisibility());
            assertEquals(1, countText((View) field("messages"), "History 1"));
            assertEquals(1, countText((View) field("messages"), "History 10"));
        });
    }

    public void testOlderFailureStopsSpinnerAndAllowsRetry() throws Exception {
        client.failure = new java.net.SocketTimeoutException();
        ui(() -> {
            invoke("applySnapshot", historySnapshot(10, 10L));
            ((View) field("older")).performClick();
            assertTrue(refreshing());
        });
        assertTrue(client.entered.await(2, TimeUnit.SECONDS));
        awaitOlder();
        ui(() -> {
            assertFalse(refreshing());
            assertTrue(((View) field("older")).isEnabled());
            assertEquals(10L, field("nextBefore"));
            assertEquals(1, countText((View) field("messages"), "History 10"));
        });
    }

    public void testPrependingHistoryKeepsVisibleMessagePosition() throws Exception {
        JSONObject initial = historySnapshot(10, 10L);
        initial.getJSONArray("messages").getJSONObject(0).put("text", "Current message\n\n".repeat(50));
        client.result = historySnapshot(1, null);
        client.result.getJSONArray("messages").getJSONObject(0).put("text", "Earlier message\n\n".repeat(40));
        ui(() -> invoke("applySnapshot", initial));
        getInstrumentation().waitForIdleSync();
        View[] anchor = {null}; int[] position = {0};
        ui(() -> {
            android.widget.ScrollView scroll = (android.widget.ScrollView) field("scroll");
            ViewGroup messages = (ViewGroup) field("messages");
            anchor[0] = messages.getChildAt(0);
            scroll.scrollTo(0, messages.getTop() + 100);
            position[0] = messages.getTop() + anchor[0].getTop() - scroll.getScrollY();
            invoke("loadOlder");
        });
        assertTrue(client.entered.await(2, TimeUnit.SECONDS));
        awaitOlder();
        android.os.SystemClock.sleep(350);
        ui(() -> {
            android.widget.ScrollView scroll = (android.widget.ScrollView) field("scroll");
            ViewGroup messages = (ViewGroup) field("messages");
            assertSame(messages, anchor[0].getParent());
            assertEquals(position[0], messages.getTop() + anchor[0].getTop() - scroll.getScrollY());
        });
    }

    public void testComputerPrefetchCachesWorkspacesAndIndependentConversations() throws Exception {
        JSONObject computer = new JSONObject().put("address", "http://100.64.0.2:43128").put("token", "b".repeat(43));
        JSONObject info = new JSONObject().put("workspaces", new JSONArray().put(new JSONObject().put("id", "workspace").put("name", "Cached workspace")))
            .put("includeUnassigned", true);
        client.result = new JSONObject().put("conversations", new JSONArray().put(new JSONObject().put("id", ID).put("title", "Prefetched independent")))
            .put("nextOffset", 50);
        client.release.countDown();
        ui(() -> prefetch(computer, info, (Integer) field("generation")));
        getInstrumentation().waitForIdleSync();
        ui(() -> {
            assertNull(cache.get((JSONObject) field("credentials")));
            JSONObject cached = cache.get(computer);
            assertEquals(50, cached.getInt("nextOffset"));
            assertTrue(cached.getBoolean("includeUnassigned"));
            assertEquals("workspace", cached.getJSONArray("workspaces").getJSONObject(0).getString("id"));
            field("credentials", computer); invoke("listScreen");
            assertEquals(1, countText((View) field("content"), "Cached workspace"));
            assertEquals(1, countText((View) field("content"), "Prefetched independent"));
            assertFalse((Boolean) field("canCreate"));
        });
    }

    public void testStalePrefetchDoesNotReplaceCacheAfterLeavingPage() throws Exception {
        client.result = new JSONObject().put("conversations", new JSONArray());
        client.release.countDown();
        ui(() -> {
            JSONObject computer = (JSONObject) field("credentials");
            cache.put(computer, new JSONArray().put(new JSONObject().put("id", ID)), -1, new JSONArray(), true);
            prefetch(computer, new JSONObject(), (Integer) field("generation"));
            invoke("stopNetwork");
        });
        getInstrumentation().waitForIdleSync();
        ui(() -> assertEquals(ID, cache.get((JSONObject) field("credentials")).getJSONArray("conversations").getJSONObject(0).getString("id")));
    }
}
