package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Handler;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import org.json.JSONArray;
import org.json.JSONObject;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Real page exits, pending work and persistence; production never forces GC. */
public class ChatViewReleaseTest extends InstrumentationTestCase {
    private static final String CHAT = "view-release-chat", GROUP = "view-release-group", MEMBER = "view-release-member";
    private static final String LONG_REPLY = "# Reply\n\n" + "A long **paragraph** with a list and `code`.\n\n".repeat(18);
    private final List<Activity> activities = new ArrayList<>();
    private final List<String> files = new ArrayList<>();
    private CredentialStore primary, discussionState, privateComputers;
    private JSONObject oldPrimary, oldDiscussion;
    private AttachmentMaintenance.Lease assets;
    private boolean oldEmbedded;

    interface Checked { void run() throws Exception; }
    private void ui(Checked action) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private static Object field(Object owner, String name) throws Exception {
        var value = owner.getClass().getDeclaredField(name); value.setAccessible(true); return value.get(owner);
    }
    private static void field(Object owner, String name, Object value) throws Exception {
        var target = owner.getClass().getDeclaredField(name); target.setAccessible(true); target.set(owner, value);
    }
    private static void invoke(Object owner, String name, Class<?>[] types, Object... values) throws Exception {
        var method = owner.getClass().getDeclaredMethod(name, types); method.setAccessible(true); method.invoke(owner, values);
    }
    private static void invoke(Object owner, String name) throws Exception { invoke(owner, name, new Class<?>[0]); }
    private View root(Activity activity) throws Exception { return (View) field(activity, "root"); }

    @Override protected void setUp() throws Exception {
        super.setUp(); var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); oldEmbedded = EmbeddedNetwork.enabled(); EmbeddedNetwork.setEnabled(false);
        primary = new CredentialStore(context); oldPrimary = primary.load();
        discussionState = new CredentialStore(context, "remote-discussions-private"); oldDiscussion = discussionState.load();
        discussionState.save(new JSONObject());
        privateComputers = new CredentialStore(context, "chat-view-release-computers-test"); privateComputers.clear();
        LocalChatFixture.clear(context); assets = AttachmentMaintenance.protect(context);
    }
    @Override protected void tearDown() throws Exception {
        for (int i = activities.size() - 1; i >= 0; i--) {
            Activity activity = activities.get(i); ui(activity::finish);
            long end = android.os.SystemClock.uptimeMillis() + 10000;
            while (!activity.isDestroyed() && android.os.SystemClock.uptimeMillis() < end) {
                LocalChatFixture.idle(getInstrumentation()); android.os.SystemClock.sleep(20);
            }
            assertTrue("Activity did not finish", activity.isDestroyed());
        }
        primary.save(oldPrimary); discussionState.save(oldDiscussion); privateComputers.clear();
        LocalChatFixture.clear(getInstrumentation().getTargetContext()); assets.close();
        EmbeddedNetwork.setEnabled(oldEmbedded); super.tearDown();
    }

    private JSONObject computer() throws Exception {
        return new JSONObject().put("address", "http://100.64.0.1:43128").put("token", "a".repeat(43)).put("deviceId", "view-release-test");
    }
    private MainActivity remote() throws Exception {
        MainActivity activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(
            getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        activities.add(activity);
        ui(() -> { invoke(activity, "stopNetwork"); field(activity, "foreground", false); field(activity, "store", new ComputerStore(privateComputers)); field(activity, "credentials", computer()); });
        remoteChat(activity); return activity;
    }
    private void remoteChat(MainActivity activity) {
        ui(() -> {
            field(activity, "conversationId", CHAT); field(activity, "conversationTitle", "View release"); invoke(activity, "detailScreen");
            JSONArray rows = new JSONArray();
            for (int i = 1; i <= 20; i++) rows.put(new JSONObject().put("seq", i).put("role", "assistant").put("text", LONG_REPLY));
            invoke(activity, "applySnapshot", new Class<?>[] {JSONObject.class}, new JSONObject()
                .put("conversation", new JSONObject().put("id", CHAT).put("seq", 20)).put("instanceId", "view-release")
                .put("cursor", 20).put("permission", "control").put("messages", rows).put("nextBefore", JSONObject.NULL));
        });
    }
    private void remoteExit(MainActivity activity) {
        ui(() -> { activity.onBackPressed(); invoke(activity, "stopNetwork"); ((PageTransitions) field(activity, "pages")).finishTransition(); });
    }
    private LocalChatActivity local() throws Exception {
        LocalChatFixture fixture = new LocalChatFixture(getInstrumentation().getTargetContext());
        JSONObject chat = fixture.createConversation("", ""); String id = chat.getString("id");
        JSONArray rows = chat.getJSONArray("messages"); rows.put(new JSONObject().put("role", "user").put("content", "Original"));
        for (int i = 0; i < 20; i++) rows.put(new JSONObject().put("role", "assistant").put("content", LONG_REPLY));
        fixture.save();
        LocalChatActivity activity = (LocalChatActivity) LocalChatFixture.start(getInstrumentation(), new Intent(
            getInstrumentation().getTargetContext(), LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        activities.add(activity); localChat(activity, id); return activity;
    }
    private void localChat(LocalChatActivity activity, String id) {
        ui(() -> { field(activity, "conversationId", id); invoke(activity, "detail"); });
        LocalChatFixture.idle(getInstrumentation());
        ui(() -> assertNotNull(field(activity, "messageViews")));
    }
    private void localExit(LocalChatActivity activity) {
        ui(() -> { activity.onBackPressed(); ((PageTransitions) field(activity, "pages")).finishTransition(); });
        LocalChatFixture.idle(getInstrumentation());
    }
    private RemoteDiscussionsActivity discussion() throws Exception {
        JSONObject profile = computer(); new ComputerStore(primary).save(profile);
        RemoteDiscussionsActivity activity = (RemoteDiscussionsActivity) getInstrumentation().startActivitySync(new Intent(
            getInstrumentation().getTargetContext(), RemoteDiscussionsActivity.class).putExtra("address", profile.getString("address"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); activities.add(activity);
        ui(() -> { invoke(activity, "disconnect"); field(activity, "foreground", false); }); discussionChat(activity); return activity;
    }
    private void discussionChat(RemoteDiscussionsActivity activity) {
        ui(() -> {
            invoke(activity, "openGroup", new Class<?>[] {String.class}, GROUP);
            JSONObject member = new JSONObject().put("id", MEMBER).put("name", "Member").put("engine", "codex")
                .put("model", "fixture").put("connection", "subscription").put("capability", new JSONObject().put("available", true));
            JSONArray rows = new JSONArray();
            for (int i = 1; i <= 20; i++) rows.put(new JSONObject().put("id", "reply-" + i).put("seq", i).put("role", "assistant")
                .put("speakerId", MEMBER).put("speakerName", "Member").put("text", LONG_REPLY));
            JSONObject group = new JSONObject().put("id", GROUP).put("title", "View release").put("participants", new JSONArray().put(member))
                .put("messages", rows).put("deliveries", new JSONArray()).put("requests", new JSONArray());
            invoke(activity, "apply", new Class<?>[] {JSONObject.class, boolean.class}, new JSONObject()
                .put("instanceId", "view-release").put("cursor", 20).put("group", group).put("nextBefore", JSONObject.NULL), false);
        });
    }
    private void discussionExit(RemoteDiscussionsActivity activity) { ui(activity::onBackPressed); }

    private String image() throws Exception {
        Bitmap bitmap = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888); bitmap.eraseColor(0xff55aa77);
        java.io.ByteArrayOutputStream encoded = new java.io.ByteArrayOutputStream(); bitmap.compress(Bitmap.CompressFormat.JPEG, 80, encoded); bitmap.recycle();
        String reference = AttachmentStore.save(getInstrumentation().getTargetContext(), encoded.toByteArray());
        files.add(reference); assets.replace(files); return reference;
    }
    @SuppressWarnings("unchecked") private void addImage(Activity activity, String reference) throws Exception {
        String name = activity instanceof RemoteDiscussionsActivity ? "images" : "selectedImages";
        List<String> images = (List<String>) field(activity, name); images.clear(); images.add(reference);
        if (activity instanceof MainActivity) {
            field(activity, "imageConversation", CHAT); field(activity, "imageComputer", computer().getString("address")); invoke(activity, "renderImage");
        } else invoke(activity, activity instanceof LocalChatActivity ? "renderImages" : "renderAttachments");
    }
    private List<StreamingMarkdownView> bodies(View view) {
        List<StreamingMarkdownView> result = new ArrayList<>();
        if (view instanceof StreamingMarkdownView) result.add((StreamingMarkdownView) view);
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) result.addAll(bodies(((ViewGroup) view).getChildAt(i)));
        return result;
    }
    private void descendants(View view, Set<View> result) {
        result.add(view);
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) descendants(((ViewGroup) view).getChildAt(i), result);
    }
    private void released(Activity activity, View old) throws Exception {
        assertNull("Old root is still attached", old.getParent());
        Set<View> previous = Collections.newSetFromMap(new IdentityHashMap<>()); descendants(old, previous);
        for (var entry : activity.getClass().getDeclaredFields()) {
            entry.setAccessible(true); Object value = entry.get(activity);
            if (value instanceof View) assertFalse("Old page held by " + entry.getName(), previous.contains(value));
        }
        for (StreamingMarkdownView body : bodies(old)) assertTrue("Old renderer accepts updates", (boolean) field(body, "disposed"));
        if (activity instanceof MainActivity) {
            assertNull(field(activity, "chatComposer")); assertNull(field(activity, "pendingScrollView")); assertNull(field(activity, "pendingMessageScroll"));
            assertTrue(((java.util.Map<?, ?>) field(activity, "replyMessages")).isEmpty());
        } else if (activity instanceof LocalChatActivity) {
            assertNull(field(activity, "chatComposer")); assertTrue(((java.util.Map<?, ?>) field(activity, "messageBindings")).isEmpty());
        } else {
            assertNull(field(activity, "composer")); assertNull(field(activity, "historyScrollOwner")); assertNull(field(activity, "historyScrollPending"));
            assertTrue(((java.util.Map<?, ?>) field(activity, "messageRows")).isEmpty());
        }
    }

    public void testRemoteExitReleasesViewsScrollAndRestoresDraft() throws Exception {
        MainActivity activity = remote(); String reference = image();
        ui(() -> {
            ((EditText) field(activity, "composer")).setText("Remote draft"); field(activity, "editingSeq", 8L); addImage(activity, reference);
            invoke(activity, "positionMessages", new Class<?>[] {int.class}, 500);
            assertNotNull(field(activity, "pendingMessageScroll"));
        });
        View old = root(activity); remoteExit(activity); ui(() -> released(activity, old));
        remoteChat(activity);
        ui(() -> {
            assertEquals("Remote draft", ((EditText) field(activity, "composer")).getText().toString()); assertEquals(8L, field(activity, "editingSeq"));
            assertEquals(List.of(reference), field(activity, "selectedImages"));
        });
    }
    public void testLocalExitReleasesViewsAndRestoresEditAndAttachment() throws Exception {
        LocalChatActivity activity = local(); String id = (String) field(activity, "conversationId"), reference = image();
        ui(() -> {
            invoke(activity, "beginEdit", new Class<?>[] {int.class}, 0); ((EditText) field(activity, "composer")).setText("Edited draft");
            addImage(activity, reference); invoke(activity, "persistDraft");
        });
        View old = root(activity); localExit(activity); ui(() -> released(activity, old)); localChat(activity, id);
        ui(() -> {
            assertEquals("Edited draft", ((EditText) field(activity, "composer")).getText().toString()); assertEquals(0, field(activity, "editingMessageIndex"));
            assertEquals(List.of(reference), field(activity, "selectedImages"));
        });
    }
    public void testDiscussionExitReleasesViewsAndPreservesDraftAndPendingAction() throws Exception {
        RemoteDiscussionsActivity activity = discussion(); String reference = image();
        ui(() -> {
            ((ChatComposer) field(activity, "composer")).input.setText("Group draft");
            @SuppressWarnings("unchecked") Set<String> selected = (Set<String>) field(activity, "selected"); selected.add(MEMBER);
            field(activity, "mode", "serial"); addImage(activity, reference);
            ((JSONObject) field(activity, "pending")).put("unconfirmed", new JSONObject().put("action", "stop"));
            invoke(activity, "showMembers"); assertNotNull(field(activity, "dialog"));
        });
        View old = root(activity); discussionExit(activity); ui(() -> { released(activity, old); assertNull(field(activity, "dialog")); });
        discussionChat(activity);
        ui(() -> {
            assertEquals("Group draft", ((ChatComposer) field(activity, "composer")).input.getText().toString());
            assertEquals("serial", field(activity, "mode")); assertTrue(((Set<?>) field(activity, "selected")).contains(MEMBER));
            assertEquals(List.of(reference), field(activity, "images")); assertTrue(((JSONObject) field(activity, "pending")).has("unconfirmed"));
        });
    }
    public void testBackgroundKeepsCurrentChatViews() throws Exception {
        MainActivity remote = remote(); View remoteRoot = root(remote); Object remoteComposer = field(remote, "chatComposer");
        ui(() -> { invoke(remote, "onStop"); assertSame(remoteRoot, root(remote)); assertSame(remoteComposer, field(remote, "chatComposer")); });
        LocalChatActivity local = local(); View localRoot = root(local); Object localComposer = field(local, "chatComposer");
        ui(() -> { invoke(local, "onStop"); assertSame(localRoot, root(local)); assertSame(localComposer, field(local, "chatComposer")); });
        RemoteDiscussionsActivity discussion = discussion(); View discussionRoot = root(discussion); Object composer = field(discussion, "composer");
        ui(() -> { invoke(discussion, "onStop"); assertSame(discussionRoot, root(discussion)); assertSame(composer, field(discussion, "composer")); });
    }
    public void testQueuedViewWorkIsCancelledWhenPageChanges() throws Exception {
        MainActivity remote = remote(); LocalChatActivity local = local(); RemoteDiscussionsActivity discussion = discussion();
        java.util.concurrent.atomic.AtomicInteger callbacks = new java.util.concurrent.atomic.AtomicInteger();
        for (Activity activity : List.of(remote, local, discussion)) ui(() -> {
            ((Handler) field(activity, "viewHandler")).post(callbacks::incrementAndGet);
            activity.onBackPressed();
            if (activity instanceof MainActivity) invoke(activity, "stopNetwork");
        });
        getInstrumentation().waitForIdleSync(); assertEquals(0, callbacks.get());
    }
    public void testStreamingCompletionCannotRenderIntoExitedPage() throws Exception {
        MainActivity activity = remote(); AtomicReference<StreamingMarkdownView> oldBody = new AtomicReference<>();
        java.util.concurrent.atomic.AtomicInteger roots = new java.util.concurrent.atomic.AtomicInteger();
        ui(() -> {
            StreamingMarkdownView body = bodies(root(activity)).get(0); oldBody.set(body); roots.set(body.createdRoots());
            body.update(LONG_REPLY.repeat(100), false); invoke(body, "dispatch");
            activity.onBackPressed(); invoke(activity, "stopNetwork");
            assertTrue((boolean) field(body, "disposed")); assertEquals("", body.source()); assertNull(field(body, "listener"));
        });
        long end = android.os.SystemClock.uptimeMillis() + 10000;
        while (!oldBody.get().idle() && android.os.SystemClock.uptimeMillis() < end) { getInstrumentation().waitForIdleSync(); android.os.SystemClock.sleep(20); }
        ui(() -> { assertTrue(oldBody.get().idle()); assertEquals(roots.get(), oldBody.get().createdRoots()); assertNull(field(activity, "chatComposer")); });
    }
    public void testLocalSaveCompletionAfterExitDoesNotRebuildTheList() throws Exception {
        LocalChatActivity activity = local(); String id = (String) field(activity, "conversationId");
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        LocalChatWriter.get(activity).executor.submit(() -> { entered.countDown(); try { release.await(5, TimeUnit.SECONDS); } catch (InterruptedException error) { Thread.currentThread().interrupt(); } });
        assertTrue(entered.await(5, TimeUnit.SECONDS));
        try {
            ui(() -> {
                invoke(activity, "renameConversation", new Class<?>[] {JSONObject.class}, ((LocalChatStore) field(activity, "store")).conversation(id));
                AlertDialog dialog = (AlertDialog) field(activity, "dialog");
                ((EditText) dialog.getWindow().getDecorView().findViewWithTag("localRename")).setText("Saved after exit");
            });
            getInstrumentation().waitForIdleSync();
            ui(() -> { ((AlertDialog) field(activity, "dialog")).getButton(AlertDialog.BUTTON_POSITIVE).performClick(); activity.onBackPressed(); });
            View list = root(activity); release.countDown(); LocalChatFixture.idle(getInstrumentation());
            ui(() -> { assertSame(list, root(activity)); assertEquals("", field(activity, "storageError")); });
            assertEquals("Saved after exit", new LocalChatFixture(activity).conversation(id).getString("title"));
        } finally { release.countDown(); }
    }
    private WeakReference<View> exitAndTrack(Activity activity) throws Exception {
        AtomicReference<WeakReference<View>> reference = new AtomicReference<>();
        ui(() -> {
            View old = root(activity);
            if (activity instanceof MainActivity) { activity.onBackPressed(); invoke(activity, "stopNetwork"); }
            else activity.onBackPressed();
            if (!(activity instanceof RemoteDiscussionsActivity)) ((PageTransitions) field(activity, "pages")).finishTransition();
            released(activity, old); reference.set(new WeakReference<>(old));
        });
        return reference.get();
    }
    private static int retainedRoots(List<WeakReference<View>> roots) {
        int retained = 0;
        for (WeakReference<View> old : roots) if (old.get() != null) retained++;
        return retained;
    }
    public void testRepeatedPageExitsAllowOldRootsToBeCollected() throws Exception {
        List<WeakReference<View>> oldRoots = new ArrayList<>();
        MainActivity remote = remote(); String reference = image();
        for (int i = 0; i < 8; i++) {
            if (i > 0) remoteChat(remote); ui(() -> addImage(remote, reference)); oldRoots.add(exitAndTrack(remote)); getInstrumentation().waitForIdleSync();
        }
        LocalChatActivity local = local(); String id = (String) field(local, "conversationId");
        for (int i = 0; i < 8; i++) {
            if (i > 0) localChat(local, id); ui(() -> addImage(local, reference)); oldRoots.add(exitAndTrack(local)); LocalChatFixture.idle(getInstrumentation());
        }
        RemoteDiscussionsActivity discussion = discussion();
        for (int i = 0; i < 8; i++) {
            if (i > 0) discussionChat(discussion); ui(() -> addImage(discussion, reference)); oldRoots.add(exitAndTrack(discussion)); getInstrumentation().waitForIdleSync();
        }
        long end = android.os.SystemClock.uptimeMillis() + 10000; int retained;
        do {
            Runtime.getRuntime().gc(); System.runFinalization(); getInstrumentation().waitForIdleSync(); android.os.SystemClock.sleep(100);
            retained = retainedRoots(oldRoots);
        } while (retained > 0 && android.os.SystemClock.uptimeMillis() < end);
        android.util.Log.i("ChatViewRelease", "Exited roots=" + oldRoots.size() + ", retained=" + retained);
        android.os.Debug.dumpHprofData(new java.io.File(getInstrumentation().getTargetContext().getCacheDir(), "chat-view-release.hprof").getAbsolutePath());
        assertEquals("Old chat roots retained while their Activities remain alive", 0, retained);
    }
}
