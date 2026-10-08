package app.camellia.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public final class AttachmentMaintenanceTest extends InstrumentationTestCase {
    private Context context;
    private CredentialStore remote, discussions;
    private JSONObject oldRemote, oldDiscussions;
    private final List<String> blobs = new ArrayList<>();
    private final List<AttachmentMaintenance.Lease> leases = new ArrayList<>();
    private Activity activity;
    private boolean oldEmbedded;
    private static final String ADDRESS = "http://100.80.1.2:43127";
    private static final String DEVICE = "attachment-fixture";
    private static final String GROUP_A = "00000000-0000-0000-0000-000000000001";
    private static final String GROUP_B = "00000000-0000-0000-0000-000000000002";

    interface Checked { void run() throws Exception; }
    private void ui(Checked action) {
        AtomicReference<Throwable> error = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable problem) { error.set(problem); } });
        if (error.get() != null) throw new AssertionError(error.get());
    }
    private static Object field(Object target, String name) throws Exception {
        var member = target.getClass().getDeclaredField(name); member.setAccessible(true); return member.get(target);
    }
    private static void field(Object target, String name, Object value) throws Exception {
        var member = target.getClass().getDeclaredField(name); member.setAccessible(true); member.set(target, value);
    }
    private static void invoke(Object target, String name, Class<?>[] types, Object... values) throws Exception {
        var method = target.getClass().getDeclaredMethod(name, types); method.setAccessible(true); method.invoke(target, values);
    }
    @Override protected void setUp() throws Exception {
        super.setUp(); context = getInstrumentation().getTargetContext();
        remote = new CredentialStore(context); discussions = new CredentialStore(context, "remote-discussions-private");
        oldRemote = remote.load(); oldDiscussions = discussions.load();
        remote.save(new JSONObject()); discussions.save(new JSONObject());
        LocalChatFixture.clear(context);
        EmbeddedNetwork.initialize(context); oldEmbedded = EmbeddedNetwork.enabled(); EmbeddedNetwork.setEnabled(false);
        collect(false);
    }
    @Override protected void tearDown() throws Exception {
        if (activity != null) { ui(activity::finish); getInstrumentation().waitForIdleSync(); }
        for (AttachmentMaintenance.Lease lease : leases) lease.close();
        remote.save(oldRemote); discussions.save(oldDiscussions);
        collect(false); LocalChatFixture.clear(context);
        for (String reference : blobs) AttachmentStore.remove(context, reference);
        EmbeddedNetwork.setEnabled(oldEmbedded); super.tearDown();
    }
    private AttachmentMaintenance.Result collect(boolean scan) throws Exception {
        long end = android.os.SystemClock.uptimeMillis() + 10000;
        AttachmentMaintenance.Result result;
        do {
            result = AttachmentMaintenance.get(context).collectNow(scan).get(10, TimeUnit.SECONDS);
            if (result.error != null) throw new AssertionError(result.error);
            if (!result.deferred) return result;
            Thread.sleep(25);
        } while (android.os.SystemClock.uptimeMillis() < end);
        throw new AssertionError("Attachment state never became stable");
    }
    private String blob() throws Exception {
        String reference = AttachmentStore.save(context, "fixture encrypted bytes".getBytes(StandardCharsets.UTF_8));
        blobs.add(reference); return reference;
    }
    private File file(String reference) { return new File(new File(context.getNoBackupFilesDir(), "chat-attachments"), reference.substring(reference.indexOf(':') + 1)); }
    private void old(String reference) {
        long time = System.currentTimeMillis() - AttachmentMaintenance.GRACE_MS - 10000;
        assertTrue(file(reference).setLastModified(time));
        File preview = new File(file(reference).getPath() + ".thumb");
        if (preview.exists()) assertTrue(preview.setLastModified(time));
    }
    private JSONArray files(String reference) throws Exception { return ChatAttachments.remote(List.of(reference), List.of()); }
    private JSONObject draft(String reference) throws Exception { return new JSONObject().put("text", "sent").put("attachments", files(reference)); }
    private JSONObject profile() throws Exception { return new JSONObject().put("address", ADDRESS).put("token", "a".repeat(43)).put("deviceId", DEVICE); }
    private JSONObject command(String action, String group, String reference) throws Exception {
        JSONObject parameters = new JSONObject().put("text", "sent");
        if (reference != null) parameters.put("attachments", files(reference));
        return new JSONObject().put("requestId", UUID.randomUUID().toString()).put("action", action).put("id", group).put("parameters", parameters);
    }
    private AttachmentMaintenance.Lease lease(Object... values) {
        AttachmentMaintenance.Lease lease = AttachmentMaintenance.protect(context, values); leases.add(lease); return lease;
    }

    public void testAllComputersGroupProfilesPendingAndLocalHistoryProtectFiles() throws Exception {
        String local = blob(), otherComputer = blob(), pending = blob(), groupDraft = blob(), groupPending = blob(), legacy = blob();
        LocalChatFixture store = new LocalChatFixture(context); JSONObject chat = store.createConversation("", "fixture");
        chat.getJSONArray("messages").put(new JSONObject().put("role", "user").put("content", "saved").put("images", new JSONArray().put(local))); store.save();
        new ComputerStore(remote).save(new JSONObject().put("address", "http://100.80.1.3:43127").put("token", "b".repeat(43))
            .put("draftAttachments", new JSONObject().put("other", draft(otherComputer))));
        new ComputerStore(remote).save(profile().put("pendingCommand", new JSONObject().put("payload", new JSONObject().put("attachments", files(pending)))));
        discussions.save(new JSONObject().put(ADDRESS + "#older-device", new JSONObject().put("drafts", new JSONObject().put(GROUP_A, draft(groupDraft))))
            .put("http://100.80.1.3:43127#other-device", new JSONObject().put("pending", new JSONObject().put("request", command("send", GROUP_B, groupPending)))));
        new CredentialStore(context, "local-chat-private").save(new JSONObject().put("oldDraft", legacy));
        for (String reference : List.of(local, otherComputer, pending, groupDraft, groupPending, legacy)) old(reference);
        collect(true);
        for (String reference : blobs) assertTrue("Live owner was ignored", file(reference).isFile());
    }

    public void testSharedReferencesAndTextAliasWaitForLastOwner() throws Exception {
        String reference = blob(), text = reference.replace(AttachmentStore.PREFIX, AttachmentStore.TEXT_PREFIX);
        remote.save(profile().put("draftAttachments", new JSONObject().put("chat", draft(reference))));
        discussions.save(new JSONObject().put("second-owner", new JSONObject().put("text", text)));
        remote.save(profile()); collect(false); assertTrue(file(reference).exists());
        discussions.save(new JSONObject()); collect(false); assertFalse(file(reference).exists());
    }

    public void testLocalDeletionRetainsRemoteOwnerAndAcknowledgesGarbage() throws Exception {
        String reference = blob(); LocalChatFixture fixture = new LocalChatFixture(context);
        JSONObject chat = fixture.createConversation("", "fixture"); String id = chat.getString("id");
        chat.put("draftImages", new JSONArray().put(reference)); fixture.save();
        remote.save(profile().put("draftAttachments", new JSONObject().put("chat", draft(reference))));
        LocalChatWriter writer = LocalChatWriter.get(context);
        writer.call(database -> { database.deleteConversations(Set.of(id)); return null; }).get(10, TimeUnit.SECONDS);
        collect(false); assertTrue(file(reference).exists());
        int garbage = writer.call(database -> {
            try (var rows = database.db.rawQuery("SELECT count(*) FROM garbage", null)) { rows.moveToFirst(); return rows.getInt(0); }
        }).get(10, TimeUnit.SECONDS);
        assertEquals("Processed garbage metadata must not accumulate", 0, garbage);
        remote.save(profile()); collect(false); assertFalse(file(reference).exists());
    }

    public void testLeavingLocalPageDoesNotPinADeletedDraftAttachment() throws Exception {
        String reference = blob(); LocalChatFixture fixture = new LocalChatFixture(context);
        JSONObject chat = fixture.createConversation("", "fixture"); String id = chat.getString("id");
        chat.put("draftImages", new JSONArray().put(reference)); fixture.save();
        LocalChatActivity local = (LocalChatActivity) LocalChatFixture.start(getInstrumentation(), new Intent(context, LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        activity = local;
        ui(() -> local.getWindow().getDecorView().findViewWithTag("localConversation:" + id).performClick());
        LocalChatFixture.idle(getInstrumentation());
        ui(local::onBackPressed); LocalChatFixture.idle(getInstrumentation());
        LocalChatWriter.get(context).call(database -> { database.deleteConversations(Set.of(id)); return null; }).get(10, TimeUnit.SECONDS);
        collect(false); assertFalse("A closed page retained its former selection", file(reference).exists());
    }

    public void testSweepRemovesOldOrphansAndThumbnailButKeepsFreshAndForeignFiles() throws Exception {
        String orphan = blob(), fresh = blob(), thumbnailOnly = blob();
        AttachmentStore.savePreview(context, orphan, new byte[]{1, 2});
        AttachmentStore.savePreview(context, thumbnailOnly, new byte[]{3, 4});
        old(orphan); old(thumbnailOnly); assertTrue(file(thumbnailOnly).delete());
        File foreign = new File(file(orphan).getParentFile(), "user-notes.txt");
        java.nio.file.Files.write(foreign.toPath(), "must remain".getBytes(StandardCharsets.UTF_8));
        File outside = new File(context.getCacheDir(), "attachment-fixture-download.txt");
        java.nio.file.Files.write(outside.toPath(), "download".getBytes(StandardCharsets.UTF_8));
        try {
            collect(true);
            assertFalse(file(orphan).exists()); assertFalse(new File(file(orphan).getPath() + ".thumb").exists());
            assertFalse(new File(file(thumbnailOnly).getPath() + ".thumb").exists());
            assertTrue(file(fresh).exists()); assertTrue(foreign.exists()); assertTrue(outside.exists());
        } finally { foreign.delete(); outside.delete(); }
    }

    public void testImportLeaseProtectsFilesBeforeMetadataAndAcrossHandoff() throws Exception {
        AttachmentMaintenance.Lease imported = lease();
        String reference;
        try (AttachmentMaintenance.Import scope = imported.captureImports()) { reference = blob(); AttachmentStore.savePreview(context, reference, new byte[]{1}); }
        old(reference); collect(true); assertTrue(file(reference).exists());
        AttachmentMaintenance.Lease selected = lease(List.of(reference)); imported.close();
        collect(true); assertTrue(file(reference).exists());
        selected.close(); collect(false);
        assertFalse(file(reference).exists()); assertFalse(new File(file(reference).getPath() + ".thumb").exists());
    }

    public void testUploadLeaseUnderstandsProtocolDataUrls() throws Exception {
        String reference = blob(); old(reference);
        AttachmentMaintenance.Lease uploading = lease(new JSONObject().put("file_data", "data:application/pdf;base64," + reference));
        ChatAttachments.discard(context, List.of(reference), List.of()); collect(true); assertTrue(file(reference).exists());
        uploading.close(); collect(false); assertFalse(file(reference).exists());
    }

    public void testActiveStateWriteDefersDeletionUntilCommittedReferencesAreVisible() throws Exception {
        String reference = blob(); old(reference);
        try (AttachmentMaintenance.Write writing = AttachmentMaintenance.writing()) {
            AttachmentMaintenance.release(context, reference);
            AttachmentMaintenance.Result result = AttachmentMaintenance.get(context).collectNow(true).get(10, TimeUnit.SECONDS);
            assertTrue(result.deferred); assertTrue(file(reference).exists());
            remote.save(profile().put("draftAttachments", new JSONObject().put("chat", draft(reference))));
        }
        collect(true); assertTrue(file(reference).exists());
        remote.save(profile()); collect(false); assertFalse(file(reference).exists());
    }

    public void testUnreadableReferenceStoresAbortWholePassAndRetryAfterRecovery() throws Exception {
        String orphan = blob(); old(orphan);
        for (String name : new String[]{"remote-private", "remote-discussions-private", "local-chat-private"}) {
            var preferences = context.getSharedPreferences(name, Context.MODE_PRIVATE);
            String saved = preferences.getString("credential", null);
            try {
                try (AttachmentMaintenance.Write writing = AttachmentMaintenance.writing()) { assertTrue(preferences.edit().putString("credential", "broken envelope").commit()); }
                AttachmentMaintenance.Result result = AttachmentMaintenance.get(context).collectNow(true).get(10, TimeUnit.SECONDS);
                assertNotNull(result.error); assertTrue("Unreadable owner must not be treated as empty", file(orphan).exists());
            } finally {
                try (AttachmentMaintenance.Write writing = AttachmentMaintenance.writing()) {
                    if (saved == null) preferences.edit().remove("credential").commit(); else preferences.edit().putString("credential", saved).commit();
                }
            }
        }
        collect(true); assertFalse(file(orphan).exists());
    }

    public void testUnverifiedLocalIndexPreservesOrphansUntilMigrationCompletes() throws Exception {
        String orphan = blob(); old(orphan);
        try (var db = android.database.sqlite.SQLiteDatabase.openOrCreateDatabase(LocalChatDatabase.file(context), null)) { db.setVersion(1); }
        AttachmentMaintenance.Result result = AttachmentMaintenance.get(context).collectNow(true).get(10, TimeUnit.SECONDS);
        assertNotNull(result.error); assertTrue(file(orphan).exists());
        LocalChatFixture.clear(context); new LocalChatFixture(context); collect(true); assertFalse(file(orphan).exists());
    }

    public void testFailedLocalDraftWriteRetainsAttachmentUntilReplacementCommits() throws Exception {
        String reference = blob(); old(reference);
        LocalChatFixture fixture = new LocalChatFixture(context); String id = fixture.createConversation("", "fixture").getString("id");
        LocalChatWriter writer = LocalChatWriter.get(context); CountDownLatch failed = new CountDownLatch(1);
        JSONObject tooLarge = new JSONObject().put("draft", "x".repeat(LocalChatDatabase.LIMIT)).put("draftImages", new JSONArray().put(reference));
        writer.coalesce(id + "/draft", database -> database.transaction(() -> { database.put("draft", id, 0, tooLarge, "", 0); return null; }), tooLarge, "", 0,
            new LocalChatStore.Callback<>() { public void done(Void result) { fail("Quota write succeeded"); } public void failed(Exception error) { failed.countDown(); } });
        assertTrue(failed.await(10, TimeUnit.SECONDS)); collect(true); assertTrue(file(reference).exists());
        CountDownLatch done = new CountDownLatch(1); JSONObject empty = new JSONObject().put("draft", "");
        writer.coalesce(id + "/draft", database -> database.transaction(() -> { database.put("draft", id, 0, empty, "", 0); return null; }), empty, "", 0,
            new LocalChatStore.Callback<>() { public void done(Void result) { done.countDown(); } public void failed(Exception error) { throw new AssertionError(error); } });
        assertTrue(done.await(10, TimeUnit.SECONDS)); collect(false); assertFalse(file(reference).exists());
    }

    public void testForgettingComputerDropsOnlyItsOrdinaryAndGroupAttachments() throws Exception {
        String ordinary = blob(), group = blob(), other = blob();
        ComputerStore computers = new ComputerStore(remote);
        computers.save(profile().put("draftAttachments", new JSONObject().put("chat", draft(ordinary))));
        computers.save(new JSONObject().put("address", "http://100.80.1.3:43127").put("token", "b".repeat(43)).put("draftAttachments", new JSONObject().put("chat", draft(other))));
        discussions.save(new JSONObject().put(ADDRESS + "#" + DEVICE, new JSONObject().put("drafts", new JSONObject().put(GROUP_A, draft(group)))));
        computers.remove(ADDRESS); collect(false);
        assertFalse(file(ordinary).exists()); assertFalse(file(group).exists()); assertTrue(file(other).exists());
        assertFalse(discussions.load().has(ADDRESS + "#" + DEVICE));
    }

    public void testOpenOtherComputerDoesNotPinOrRestoreForgottenProfiles() throws Exception {
        String forgotten = blob(), active = blob(), secondAddress = "http://100.80.1.3:43127";
        ComputerStore computers = new ComputerStore(remote); computers.save(profile());
        computers.save(profile().put("address", secondAddress));
        discussions.save(new JSONObject()
            .put(ADDRESS + "#" + DEVICE, new JSONObject().put("drafts", new JSONObject().put(GROUP_A, draft(forgotten))))
            .put(secondAddress + "#" + DEVICE, new JSONObject().put("drafts", new JSONObject().put(GROUP_B, draft(active)))));
        RemoteDiscussionsActivity group = (RemoteDiscussionsActivity) getInstrumentation().startActivitySync(new Intent(context, RemoteDiscussionsActivity.class)
            .putExtra("address", secondAddress).putExtra("groupId", GROUP_B).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); activity = group;
        ui(() -> { invoke(group, "disconnect", new Class<?>[0]); field(group, "foreground", false); computers.remove(ADDRESS); });
        collect(false); assertFalse(file(forgotten).exists()); assertTrue(file(active).exists());
        ui(() -> invoke(group, "persist", new Class<?>[0]));
        assertFalse("A stale page restored a forgotten computer", discussions.load().has(ADDRESS + "#" + DEVICE));
        assertTrue(discussions.load().has(secondAddress + "#" + DEVICE));
    }

    private RemoteDiscussionsActivity groupActivity(JSONObject pending, JSONObject drafts, String current) throws Exception {
        new ComputerStore(remote).save(profile());
        discussions.save(new JSONObject().put(ADDRESS + "#" + DEVICE, new JSONObject().put("pending", pending).put("drafts", drafts)));
        RemoteDiscussionsActivity group = (RemoteDiscussionsActivity) getInstrumentation().startActivitySync(new Intent(context, RemoteDiscussionsActivity.class)
            .putExtra("address", ADDRESS).putExtra("groupId", current).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        activity = group;
        ui(() -> { invoke(group, "disconnect", new Class<?>[0]); field(group, "foreground", false); });
        return group;
    }

    public void testGroupReceiptAfterSwitchAndDeletedGroupReleaseOriginalFiles() throws Exception {
        String sent = blob(), current = blob(); JSONObject send = command("send", GROUP_A, sent);
        RemoteDiscussionsActivity group = groupActivity(new JSONObject().put(send.getString("requestId"), send),
            new JSONObject().put(GROUP_A, draft(sent)).put(GROUP_B, draft(current)), GROUP_B);
        ui(() -> invoke(group, "receipt", new Class<?>[]{JSONObject.class, JSONObject.class}, send, new JSONObject().put("state", "completed")));
        collect(false); assertFalse(file(sent).exists()); assertTrue(file(current).exists());
        JSONObject delete = command("delete", GROUP_B, null);
        ui(() -> {
            ((JSONObject) field(group, "pending")).put(delete.getString("requestId"), delete);
            invoke(group, "persist", new Class<?>[0]);
            invoke(group, "receipt", new Class<?>[]{JSONObject.class, JSONObject.class}, delete, new JSONObject().put("state", "completed"));
        });
        collect(false); assertFalse(file(current).exists());
        assertFalse(discussions.load().getJSONObject(ADDRESS + "#" + DEVICE).getJSONObject("drafts").has(GROUP_B));
    }

    public void testGroupUnknownReceiptAndFailedSavePreserveRetryFiles() throws Exception {
        String sent = blob(); JSONObject send = command("send", GROUP_A, sent);
        RemoteDiscussionsActivity group = groupActivity(new JSONObject().put(send.getString("requestId"), send), new JSONObject().put(GROUP_A, draft(sent)), GROUP_A);
        ui(() -> invoke(group, "receipt", new Class<?>[]{JSONObject.class, JSONObject.class}, send, new JSONObject().put("state", "unknown")));
        collect(true); assertTrue(file(sent).exists());
        ui(() -> assertTrue(((JSONObject) field(group, "pending")).has(send.getString("requestId"))));
        var preferences = context.getSharedPreferences("remote-discussions-private", Context.MODE_PRIVATE);
        var refusing = (android.content.SharedPreferences) java.lang.reflect.Proxy.newProxyInstance(getClass().getClassLoader(),
            new Class<?>[]{android.content.SharedPreferences.class}, (proxy, method, arguments) -> {
                if (!method.getName().equals("edit")) return method.invoke(preferences, arguments);
                var editor = preferences.edit();
                return java.lang.reflect.Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{android.content.SharedPreferences.Editor.class},
                    (editorProxy, editorMethod, editorArguments) -> {
                        if (editorMethod.getName().equals("commit")) return false;
                        Object result = editorMethod.invoke(editor, editorArguments); return result == editor ? editorProxy : result;
                    });
            });
        CredentialStore failing = new CredentialStore(new android.content.ContextWrapper(context) {
            @Override public android.content.SharedPreferences getSharedPreferences(String name, int mode) { return refusing; }
        }, "remote-discussions-private");
        ui(() -> {
            field(group, "stateStore", failing);
            invoke(group, "receipt", new Class<?>[]{JSONObject.class, JSONObject.class}, send, new JSONObject().put("state", "completed"));
        });
        collect(false); assertTrue("Failed save must preserve the committed pending owner", file(sent).exists());
        assertTrue(discussions.load().getJSONObject(ADDRESS + "#" + DEVICE).getJSONObject("pending").has(send.getString("requestId")));
        ui(() -> {
            assertTrue(((JSONObject) field(group, "pending")).has(send.getString("requestId")));
            assertEquals(1, ((List<?>) field(group, "images")).size());
            field(group, "stateStore", discussions);
            invoke(group, "receipt", new Class<?>[]{JSONObject.class, JSONObject.class}, send, new JSONObject().put("state", "completed"));
        });
        collect(false); assertFalse(file(sent).exists());
    }

    public void testOrdinaryUnknownAndSuccessfulReceiptPreserveNewerDraft() throws Exception {
        String sent = blob(), next = blob(); String id = UUID.randomUUID().toString();
        JSONObject payload = new JSONObject().put("action", "send").put("requestId", UUID.randomUUID().toString()).put("prompt", "sent").put("attachments", files(sent));
        JSONObject pending = new JSONObject().put("conversationId", id).put("payload", payload).put("draft", "sent");
        new ComputerStore(remote).save(profile().put("pendingCommand", pending));
        MainActivity main = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); activity = main;
        ui(() -> {
            invoke(main, "stopNetwork", new Class<?>[0]); field(main, "foreground", false);
            field(main, "conversationId", id); invoke(main, "detailScreen", new Class<?>[0]);
            field(main, "outgoingMessage", pending);
            invoke(main, "finishCommand", new Class<?>[]{JSONObject.class, JSONObject.class}, payload, new JSONObject().put("state", "unknown"));
        });
        collect(true); assertTrue(file(sent).exists()); assertTrue(remote.load().has("pendingCommand"));
        ui(() -> {
            JSONObject saved = new JSONObject(((JSONObject) field(main, "credentials")).toString())
                .put("drafts", new JSONObject().put(id, "new draft")).put("draftAttachments", new JSONObject().put(id, draft(next)));
            ((ComputerStore) field(main, "store")).save(saved); field(main, "credentials", saved);
            invoke(main, "finishCommand", new Class<?>[]{JSONObject.class, JSONObject.class}, payload, new JSONObject().put("ok", true));
        });
        collect(false); assertFalse(file(sent).exists()); assertTrue(file(next).exists());
        JSONObject saved = remote.load(); assertEquals("new draft", saved.getJSONObject("drafts").getString(id));
        assertEquals(next, saved.getJSONObject("draftAttachments").getJSONObject(id).getJSONArray("attachments").getJSONObject(0).getString("data"));
    }

    public void testLateOrdinaryReceiptCannotDropNewPendingAttachments() throws Exception {
        String original = blob(), newer = blob(); String id = UUID.randomUUID().toString();
        JSONObject first = new JSONObject().put("action", "send").put("requestId", UUID.randomUUID().toString()).put("attachments", files(original));
        JSONObject second = new JSONObject().put("action", "send").put("requestId", UUID.randomUUID().toString()).put("attachments", files(newer));
        new ComputerStore(remote).save(profile().put("pendingCommand", new JSONObject().put("conversationId", id).put("payload", second)));
        MainActivity main = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); activity = main;
        ui(() -> {
            invoke(main, "stopNetwork", new Class<?>[0]); field(main, "foreground", false);
            field(main, "conversationId", id); invoke(main, "detailScreen", new Class<?>[0]);
            invoke(main, "finishCommand", new Class<?>[]{JSONObject.class, JSONObject.class}, first, new JSONObject().put("ok", true));
        });
        collect(false); assertTrue(file(newer).exists());
        assertEquals(second.getString("requestId"), remote.load().getJSONObject("pendingCommand").getJSONObject("payload").getString("requestId"));
    }
}
