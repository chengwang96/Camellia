package app.camellia.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.StrictMode;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.EditText;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public class LocalChatStorageTest extends InstrumentationTestCase {
    private Context context;
    private LocalChatWriter writer;
    private static final LocalChatStore.Callback<Void> IGNORE = new LocalChatStore.Callback<>() {
        public void done(Void value) {}
        public void failed(Exception error) {}
    };

    @Override protected void setUp() throws Exception {
        super.setUp(); context = getInstrumentation().getTargetContext();
        LocalChatFixture.clear(context); writer = LocalChatWriter.get(context);
    }

    @Override protected void tearDown() throws Exception {
        LocalChatFixture.clear(context); super.tearDown();
    }

    private interface Async<T> { void run(LocalChatStore.Callback<T> callback) throws Exception; }
    private <T> T await(Async<T> action) throws Exception {
        CompletableFuture<T> result = new CompletableFuture<>();
        getInstrumentation().runOnMainSync(() -> {
            try { action.run(new LocalChatStore.Callback<>() {
                public void done(T value) { result.complete(value); }
                public void failed(Exception error) { result.completeExceptionally(error); }
            }); } catch (Exception error) { result.completeExceptionally(error); }
        });
        return result.get(20, TimeUnit.SECONDS);
    }

    private LocalChatStore open() throws Exception {
        return await(callback -> LocalChatStore.open(context, null, callback));
    }

    private void flush(LocalChatStore store) throws Exception { this.<Void>await(store::flush); }
    private static JSONObject message(String role, String text) throws Exception {
        return new JSONObject().put("role", role).put("content", text).put("at", 1791360000000L);
    }
    private static JSONObject conversation(String id) throws Exception {
        return new JSONObject().put("id", id).put("title", "Private title").put("workspaceId", "")
            .put("routeId", "route").put("draft", "").put("messages", new JSONArray());
    }
    private static JSONObject legacy(JSONObject conversation) throws Exception {
        return new JSONObject().put("config", new JSONObject().put("privateKey", "retained secret"))
            .put("workspaces", new JSONArray()).put("conversations", new JSONArray().put(conversation));
    }
    private String envelope() { return context.getSharedPreferences("local-chat-private", 0).getString("credential", null); }
    private Map<String, byte[]> ciphertexts() throws Exception {
        return writer.call(database -> {
            Map<String, byte[]> result = new LinkedHashMap<>();
            try (Cursor rows = database.db.rawQuery("SELECT kind,owner,position,payload FROM records ORDER BY rowid", null)) {
                while (rows.moveToNext()) result.put(rows.getString(0) + "/" + rows.getString(1) + "/" + rows.getInt(2), rows.getBlob(3));
            }
            return result;
        }).get(20, TimeUnit.SECONDS);
    }

    public void testVerifiedMigrationKeepsDataAttachmentsAndSharedKey() throws Exception {
        String reference = AttachmentStore.save(context, "private attachment".getBytes(StandardCharsets.UTF_8));
        CredentialStore sentinel = new CredentialStore(context, "local-storage-sentinel");
        sentinel.save(new JSONObject().put("value", "unrelated credentials"));
        JSONObject chat = conversation("migrated");
        chat.getJSONArray("messages").put(message("user", "original").put("images", new JSONArray().put(reference)));
        chat.put("draft", "edited").put("draftEditIndex", 0).put("draftImages", new JSONArray());
        JSONObject old = legacy(chat).put("futureSetting", new JSONObject().put("enabled", true));
        new CredentialStore(context, "local-chat-private").save(old);
        try {
            LocalChatStore store = open();
            assertFalse(store.conversations().getJSONObject(0).has("messages"));
            JSONObject loaded = await(callback -> store.readConversation("migrated", callback));
            assertTrue(LocalChatRecord.same(chat, loaded)); assertNull(envelope());
            assertEquals("retained secret", store.config().getString("privateKey"));
            assertEquals("private attachment", new String(AttachmentStore.read(context, reference), StandardCharsets.UTF_8));
            assertEquals("unrelated credentials", sentinel.load().getString("value"));
            assertTrue(writer.call(database -> database.get("extra", "main", 0).getJSONObject("futureSetting").getBoolean("enabled")).get());
            for (byte[] bytes : ciphertexts().values()) assertFalse(new String(bytes, StandardCharsets.UTF_8).contains("retained secret"));
            // A leftover old copy after a crash cannot overwrite committed v2 data.
            new CredentialStore(context, "local-chat-private").save(legacy(conversation("stale")));
            writer.close(); writer = LocalChatWriter.get(context);
            assertEquals("migrated", open().conversations().getJSONObject(0).getString("id")); assertNull(envelope());
        } finally { sentinel.clear(); AttachmentStore.remove(context, reference); }
    }

    public void testFailedMigrationPreservesCiphertextAndRollsBackThenRetries() throws Exception {
        JSONObject old = legacy(conversation("duplicate"));
        old.getJSONArray("conversations").put(conversation("duplicate"));
        new CredentialStore(context, "local-chat-private").save(old); String before = envelope();
        try { open(); fail("Duplicate history was accepted"); } catch (java.util.concurrent.ExecutionException expected) {}
        assertEquals(before, envelope());
        try (SQLiteDatabase database = SQLiteDatabase.openDatabase(LocalChatDatabase.file(context).getPath(), null, SQLiteDatabase.OPEN_READONLY);
             Cursor records = database.rawQuery("SELECT count(*) FROM records", null);
             Cursor migrated = database.rawQuery("SELECT count(*) FROM flags WHERE name='migrated' AND value=1", null)) {
            records.moveToFirst(); migrated.moveToFirst(); assertEquals(0, records.getInt(0)); assertEquals(0, migrated.getInt(0));
        }
        old.getJSONArray("conversations").remove(1);
        new CredentialStore(context, "local-chat-private").save(old);
        assertEquals(1, open().conversations().length()); assertNull(envelope());
    }

    public void testUnreadableLegacyShowsRetryAndDoesNotReplaceData() throws Exception {
        String corrupt = "{\"iv\":\"broken\",\"data\":\"broken\"}";
        context.getSharedPreferences("local-chat-private", 0).edit().putString("credential", corrupt).commit();
        Activity activity = LocalChatFixture.start(getInstrumentation(), new Intent(context, LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().runOnMainSync(() -> assertNotNull(activity.getWindow().getDecorView().findViewWithTag("localStorageLoadRetry")));
            assertEquals(corrupt, envelope());
            new CredentialStore(context, "local-chat-private").save(legacy(conversation("recovered")));
            getInstrumentation().runOnMainSync(() -> activity.getWindow().getDecorView().findViewWithTag("localStorageLoadRetry").performClick());
            LocalChatFixture.idle(getInstrumentation());
            getInstrumentation().runOnMainSync(() -> assertNotNull(activity.getWindow().getDecorView().findViewWithTag("localConversation:recovered")));
        } finally { finish(activity); }
    }

    public void testLargeHistoryWritesOnlyCurrentRecordsAndLoadsOnlyOpenChat() throws Exception {
        writer.call(database -> database.transaction(() -> {
            JSONObject chat = conversation("large");
            database.put("conversation", "large", 0, LocalChatRecord.metadata(chat), "", 0);
            database.put("draft", "large", 0, LocalChatRecord.draft(chat), "", 0);
            for (int position = 0; position < 1000; position++)
                database.put("message", "large", position, message(position % 2 == 0 ? "user" : "assistant", "x".repeat(2048)), "", 0);
            database.put("message", "large", 1000, message("assistant", "partial").put("state", "running"), "run", 0);
            return null;
        })).get(30, TimeUnit.SECONDS);
        Map<String, byte[]> before = ciphertexts();
        LocalChatStore store = open();
        assertFalse(store.conversation("large").has("messages"));
        JSONObject loaded = await(callback -> store.readConversation("large", callback));
        assertEquals(1001, loaded.getJSONArray("messages").length());
        getInstrumentation().runOnMainSync(() -> {
            try {
                store.useConversation(loaded);
                store.saveDraft("large", new JSONObject().put("draft", "new draft"), true, IGNORE);
                store.checkpoint(new LocalChatStore.Reply("large", 1000, "run"), message("assistant", "finished").put("state", "complete"), true, IGNORE);
            } catch (Exception error) { throw new AssertionError(error); }
        });
        flush(store); Map<String, byte[]> after = ciphertexts();
        int changed = 0;
        for (String key : before.keySet()) if (!Arrays.equals(before.get(key), after.get(key))) {
            assertTrue(key, key.equals("draft/large/0") || key.equals("message/large/1000")); changed++;
        }
        assertEquals(2, changed);
        getInstrumentation().runOnMainSync(store::releaseHistory);
        assertFalse(store.hasHistory("large")); assertFalse(store.conversation("large").has("messages"));
        assertTrue(writer.call(database -> {
            try (Cursor sum = database.db.rawQuery("SELECT sum(units) FROM records", null)) { sum.moveToFirst(); return sum.getLong(0) == database.flag("units"); }
        }).get());
    }

    public void testLateCheckpointCannotReplaceFinalReplyOrReusedPosition() throws Exception {
        writer.call(database -> database.transaction(() -> {
            database.put("message", "chat", 0, message("assistant", "").put("state", "running"), "first", 0); return null;
        })).get();
        assertTrue(writer.call(database -> database.reply("chat", 0, "first", 2, message("assistant", "new").put("state", "running"))).get());
        assertFalse(writer.call(database -> database.reply("chat", 0, "first", 1, message("assistant", "old").put("state", "running"))).get());
        assertTrue(writer.call(database -> database.reply("chat", 0, "first", 3, message("assistant", "final").put("state", "complete"))).get());
        assertFalse(writer.call(database -> database.reply("chat", 0, "first", 4, message("assistant", "late").put("state", "running"))).get());
        writer.call(database -> database.transaction(() -> {
            database.remove("message", "chat", 0);
            database.put("message", "chat", 0, message("assistant", "second").put("state", "running"), "second", 0); return null;
        })).get();
        assertFalse(writer.call(database -> database.reply("chat", 0, "first", 99, message("assistant", "late").put("state", "complete"))).get());
        assertEquals("second", writer.call(database -> database.get("message", "chat", 0).getString("content")).get());
    }

    public void testLargeUnicodeRecordsReadBeyondCursorWindow() throws Exception {
        String large = "汉".repeat(800 * 1024);
        JSONObject chat = conversation("unicode");
        chat.getJSONArray("messages").put(message("assistant", large).put("state", "complete"));
        JSONObject old = legacy(chat);
        old.getJSONObject("config").put("large", large);
        old.getJSONArray("workspaces").put(new JSONObject().put("id", "workspace").put("name", large));
        new CredentialStore(context, "local-chat-private").save(old);
        LocalChatStore store = open();
        assertNull(envelope()); assertEquals(large, store.config().getString("large"));
        assertEquals(large, store.workspaces().getJSONObject(0).getString("name"));
        JSONObject loaded = await(callback -> store.readConversation("unicode", callback));
        assertEquals(large, loaded.getJSONArray("messages").getJSONObject(0).getString("content"));
        writer.close(); writer = LocalChatWriter.get(context);
        assertEquals(large, open().config().getString("large"));
    }

    public void testQuotaFailureRollsBackAndNewerSmallDraftReplacesIt() throws Exception {
        LocalChatStore store = open(); JSONObject chat = await(callback -> store.createConversation("", "route", callback));
        String id = chat.getString("id"); CompletableFuture<Exception> failure = new CompletableFuture<>();
        getInstrumentation().runOnMainSync(() -> {
            try { store.saveDraft(id, new JSONObject().put("draft", "x".repeat(LocalChatDatabase.LIMIT)), true, new LocalChatStore.Callback<>() {
                public void done(Void value) { failure.completeExceptionally(new AssertionError("Oversized draft saved")); }
                public void failed(Exception error) { failure.complete(error); }
            }); } catch (Exception error) { throw new AssertionError(error); }
        });
        assertTrue(failure.get(20, TimeUnit.SECONDS).getMessage().contains("存储已满"));
        assertEquals("", writer.call(database -> database.get("draft", id, 0).getString("draft")).get());
        getInstrumentation().runOnMainSync(() -> {
            try { store.saveDraft(id, new JSONObject().put("draft", "small latest draft"), true, IGNORE); }
            catch (Exception error) { throw new AssertionError(error); }
        });
        flush(store);
        assertEquals("small latest draft", writer.call(database -> database.get("draft", id, 0).getString("draft")).get());
    }

    public void testStaleHistoryCannotOverwriteNewerSend() throws Exception {
        LocalChatStore store = open(); JSONObject chat = await(callback -> store.createConversation("", "route", callback));
        String id = chat.getString("id");
        writer.call(database -> database.transaction(() -> {
            database.put("message", id, 0, message("user", "newer turn"), "", 0); return null;
        })).get();
        LocalChatConfig.Route route = new LocalChatConfig.Route("route", "Test", "model", "openai", "https://example.com/v1", "key");
        try { this.<LocalChatStore.Turn>await(callback ->
            store.startTurn(id, 0, 0, message("user", "stale turn"), route, "auto", "", "title", callback));
            fail("Stale history was overwritten");
        } catch (java.util.concurrent.ExecutionException expected) {}
        assertEquals("newer turn", writer.call(database -> database.get("message", id, 0).getString("content")).get());
    }

    public void testClosingBeforeSendCommitPreservesDraftWithoutStartingApi() throws Exception {
        try (java.net.ServerSocket api = new java.net.ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
            JSONObject provider = new JSONObject().put("id", "provider").put("name", "Test").put("protocol", "openai")
                .put("baseUrl", "http://127.0.0.1:" + api.getLocalPort() + "/v1")
                .put("keys", new JSONArray().put(new JSONObject().put("key", "key")))
                .put("models", new JSONArray().put(new JSONObject().put("id", "model").put("upstream", "model")));
            LocalChatFixture fixture = new LocalChatFixture(context);
            fixture.importConfig(new JSONObject().put("providers", new JSONArray().put(provider)));
            String id = fixture.createConversation("", LocalChatConfig.routes(fixture.config()).get(0).id).getString("id");
            Activity activity = LocalChatFixture.start(getInstrumentation(), new Intent(context, LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            getInstrumentation().runOnMainSync(() -> activity.getWindow().getDecorView().findViewWithTag("localConversation:" + id).performClick());
            LocalChatFixture.idle(getInstrumentation());
            CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
            writer.executor.execute(() -> { entered.countDown(); try { release.await(10, TimeUnit.SECONDS); } catch (InterruptedException error) { Thread.currentThread().interrupt(); } });
            assertTrue(entered.await(5, TimeUnit.SECONDS));
            AtomicReference<Throwable> failure = new AtomicReference<>();
            try {
                getInstrumentation().runOnMainSync(() -> {
                    try {
                        ((EditText) activity.getWindow().getDecorView().findViewWithTag("localComposer")).setText("unsent draft");
                        var send = LocalChatActivity.class.getDeclaredMethod("sendMessage", String.class); send.setAccessible(true); send.invoke(activity, "");
                        var pending = LocalChatActivity.class.getDeclaredField("sendPending"); pending.setAccessible(true);
                        assertTrue(pending.getBoolean(activity));
                        activity.finish(); assertFalse(activity.isFinishing());
                    } catch (Throwable error) { failure.set(error); }
                });
            } finally { release.countDown(); }
            if (failure.get() != null) throw new AssertionError(failure.get());
            LocalChatFixture.idle(getInstrumentation());
            JSONObject saved = writer.call(database -> database.conversation(id)).get();
            assertEquals("unsent draft", saved.getString("draft")); assertEquals(0, saved.getInt("draftEditIndex"));
            assertEquals("interrupted", saved.getJSONArray("messages").getJSONObject(1).getString("state"));
            api.setSoTimeout(250);
            try (java.net.Socket ignored = api.accept()) { fail("API request started after closing"); }
            catch (java.net.SocketTimeoutException expected) {}
            finish(activity);
        }
    }

    public void testTypingQueueCoalescesAndDetachesMutableInputs() throws Exception {
        LocalChatStore store = open();
        JSONObject chat = await(callback -> store.createConversation("", "route", callback)); String id = chat.getString("id");
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        writer.executor.execute(() -> { entered.countDown(); try { release.await(10, TimeUnit.SECONDS); } catch (InterruptedException error) { Thread.currentThread().interrupt(); } });
        assertTrue(entered.await(5, TimeUnit.SECONDS));
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    JSONObject draft = new JSONObject();
                    for (int index = 0; index < 500; index++) {
                        draft.put("draft", "draft-" + index); store.saveDraft(id, draft, false, IGNORE);
                    }
                    draft.put("draft", "mutated after enqueue");
                } catch (Exception error) { throw new AssertionError(error); }
            });
            var field = LocalChatWriter.class.getDeclaredField("pending"); field.setAccessible(true);
            Map<?, ?> pending = (Map<?, ?>) field.get(writer);
            synchronized (pending) { assertEquals(1, pending.size()); }
        } finally { release.countDown(); }
        flush(store);
        assertEquals("draft-499", writer.call(database -> database.get("draft", id, 0).getString("draft")).get());
    }

    public void testFailedLatestDraftAndConfigRemainRetryable() throws Exception {
        LocalChatStore store = open(); JSONObject chat = await(callback -> store.createConversation("", "route", callback));
        String id = chat.getString("id"); AtomicReference<Exception> error = new AtomicReference<>();
        writer.call(database -> {
            database.db.execSQL("CREATE TRIGGER reject_write BEFORE UPDATE ON records WHEN NEW.kind IN ('draft','config') BEGIN SELECT RAISE(ABORT,'injected write failure'); END"); return null;
        }).get();
        getInstrumentation().runOnMainSync(() -> {
            try { store.saveDraft(id, new JSONObject().put("draft", "latest unsaved"), true, new LocalChatStore.Callback<>() {
                public void done(Void value) { fail("Blocked write succeeded"); }
                public void failed(Exception value) { error.set(value); }
            }); } catch (Exception value) { throw new AssertionError(value); }
        });
        LocalChatFixture.idle(getInstrumentation()); assertNotNull(error.get()); assertTrue(store.saveFailed());
        LocalChatStore reopened = open();
        assertNotNull(reopened.pendingError);
        JSONObject restored = await(callback -> reopened.readConversation(id, callback));
        assertEquals("latest unsaved", restored.getString("draft"));
        JSONObject config = new JSONObject().put("privateKey", "unsaved key");
        try { this.<JSONObject>await(callback -> store.importConfig(config, callback)); fail("Blocked config succeeded"); }
        catch (java.util.concurrent.ExecutionException expected) {}
        assertEquals("unsaved key", store.config().getString("privateKey"));
        try { flush(store); fail("Failed flush claimed success"); } catch (java.util.concurrent.ExecutionException expected) {}
        writer.call(database -> { database.db.execSQL("DROP TRIGGER reject_write"); return null; }).get();
        flush(store); assertFalse(store.saveFailed());
        assertEquals("latest unsaved", writer.call(database -> database.get("draft", id, 0).getString("draft")).get());
        assertEquals("unsaved key", open().config().getString("privateKey"));
    }

    public void testAttachmentRemovalWaitsForLastCommittedReference() throws Exception {
        String reference = AttachmentStore.save(context, new byte[]{1, 2, 3});
        try {
            writer.call(database -> database.transaction(() -> {
                for (String id : new String[]{"first", "second"}) {
                    database.put("conversation", id, 0, LocalChatRecord.metadata(conversation(id)), "", 0);
                    database.put("draft", id, 0, new JSONObject().put("draftImages", new JSONArray().put(reference)), "", 0);
                }
                return null;
            })).get();
            writer.call(database -> database.transaction(() -> {
                database.put("message", "first", 0, message("user", "sent").put("images", new JSONArray().put(reference)), "", 0);
                database.put("draft", "first", 0, new JSONObject(), "", 0); return null;
            })).get();
            assertEquals(3, AttachmentStore.read(context, reference).length);
            try { writer.call(database -> database.transaction(() -> {
                database.remove("draft", "second", 0); database.remove("message", "first", 0);
                throw new java.io.IOException("rollback");
            })).get(); fail("Transaction did not roll back"); } catch (java.util.concurrent.ExecutionException expected) {}
            assertEquals(3, AttachmentStore.read(context, reference).length);
            writer.call(database -> { database.deleteConversations(java.util.Set.of("first")); return null; }).get();
            assertEquals(3, AttachmentStore.read(context, reference).length);
            writer.call(database -> { database.deleteConversations(java.util.Set.of("second")); return null; }).get();
            AttachmentMaintenance.get(context).collectNow(false).get(10, TimeUnit.SECONDS);
            try { AttachmentStore.read(context, reference); fail("Unreferenced attachment remains"); } catch (java.io.IOException expected) {}
        } finally { AttachmentStore.remove(context, reference); }
    }

    public void testFailedFinalReplySurvivesReopeningAndRecoveryUntilRetry() throws Exception {
        LocalChatStore store = open(); JSONObject chat = await(callback -> store.createConversation("", "route", callback));
        String id = chat.getString("id");
        writer.call(database -> database.transaction(() -> {
            database.put("message", id, 0, message("assistant", "old checkpoint").put("state", "running"), "run", 0);
            database.db.execSQL("CREATE TRIGGER reject_reply BEFORE UPDATE ON records WHEN NEW.kind='message' BEGIN SELECT RAISE(ABORT,'injected reply failure'); END");
            return null;
        })).get();
        getInstrumentation().runOnMainSync(() -> {
            try { store.checkpoint(new LocalChatStore.Reply(id, 0, "run"), message("assistant", "latest final reply").put("state", "complete"), true, IGNORE); }
            catch (Exception error) { throw new AssertionError(error); }
        });
        LocalChatFixture.idle(getInstrumentation());
        LocalChatStore reopened = await(callback -> LocalChatStore.open(context, "interrupted", callback));
        assertNotNull(reopened.pendingError);
        JSONObject restored = await(callback -> reopened.readConversation(id, callback));
        assertEquals("latest final reply", restored.getJSONArray("messages").getJSONObject(0).getString("content"));
        writer.call(database -> { database.db.execSQL("DROP TRIGGER reject_reply"); return null; }).get();
        flush(reopened);
        this.<LocalChatStore>await(callback -> LocalChatStore.open(context, "interrupted", callback));
        assertEquals("latest final reply", writer.call(database -> database.get("message", id, 0).getString("content")).get());
        assertEquals("complete", writer.call(database -> database.get("message", id, 0).getString("state")).get());
    }

    public void testRecoveryChangesOnlyRunningRecords() throws Exception {
        writer.call(database -> database.transaction(() -> {
            database.put("message", "chat", 0, message("assistant", "old").put("state", "complete"), "", 0);
            database.put("message", "chat", 1, message("assistant", "partial").put("state", "running")
                .put("process", new JSONArray().put(new JSONObject().put("status", "running"))), "run", 0); return null;
        })).get();
        Map<String, byte[]> before = ciphertexts();
        writer.call(database -> { database.recover("interrupted"); return null; }).get();
        Map<String, byte[]> after = ciphertexts();
        assertTrue(Arrays.equals(before.get("message/chat/0"), after.get("message/chat/0")));
        assertFalse(Arrays.equals(before.get("message/chat/1"), after.get("message/chat/1")));
        JSONObject recovered = writer.call(database -> database.get("message", "chat", 1)).get();
        assertEquals("partial", recovered.getString("content")); assertEquals("interrupted", recovered.getString("state"));
        assertEquals("cancelled", recovered.getJSONArray("process").getJSONObject(0).getString("status"));
    }

    public void testDeletingLargeHistoryReclaimsDatabasePages() throws Exception {
        writer.call(database -> database.transaction(() -> {
            database.put("conversation", "deleted", 0, LocalChatRecord.metadata(conversation("deleted")), "", 0);
            database.put("draft", "deleted", 0, new JSONObject(), "", 0);
            for (int position = 0; position < 300; position++)
                database.put("message", "deleted", position, message("assistant", "x".repeat(4096)), "", 0);
            return null;
        })).get(30, TimeUnit.SECONDS);
        writer.call(database -> { database.checkpoint(); return null; }).get();
        long before = LocalChatDatabase.file(context).length();
        writer.call(database -> { database.deleteConversations(java.util.Set.of("deleted")); return null; }).get();
        long after = LocalChatDatabase.file(context).length();
        assertTrue("Deleted history did not release disk pages: " + before + " -> " + after, after < before / 2);
        writer.close(); writer = LocalChatWriter.get(context);
        assertTrue(writer.call(database -> {
            try (Cursor setting = database.db.rawQuery("PRAGMA auto_vacuum", null)) { setting.moveToFirst(); return setting.getInt(0) == 2; }
        }).get());
    }

    public void testUiAutosaveAndNormalCloseDoNotTouchDiskOnMainThread() throws Exception {
        LocalChatFixture fixture = new LocalChatFixture(context);
        String id = fixture.createConversation("", "route").getString("id");
        Activity activity = LocalChatFixture.start(getInstrumentation(), new Intent(context, LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().runOnMainSync(() -> activity.getWindow().getDecorView().findViewWithTag("localConversation:" + id).performClick());
        LocalChatFixture.idle(getInstrumentation());
        java.util.List<android.os.strictmode.Violation> violations = new java.util.concurrent.CopyOnWriteArrayList<>();
        AtomicReference<StrictMode.ThreadPolicy> previous = new AtomicReference<>();
        try {
            getInstrumentation().runOnMainSync(() -> {
                previous.set(StrictMode.getThreadPolicy());
                StrictMode.setThreadPolicy(new StrictMode.ThreadPolicy.Builder().detectDiskReads().detectDiskWrites()
                    .penaltyListener(Runnable::run, violations::add).build());
                ((EditText) activity.getWindow().getDecorView().findViewWithTag("localComposer")).setText("autosaved without leaving");
            });
            Thread.sleep(500); LocalChatFixture.idle(getInstrumentation());
            assertEquals("autosaved without leaving", writer.call(database -> database.get("draft", id, 0).getString("draft")).get());
            getInstrumentation().runOnMainSync(() -> {
                ((EditText) activity.getWindow().getDecorView().findViewWithTag("localComposer")).setText("last edit before closing");
                activity.finish();
            });
            LocalChatFixture.idle(getInstrumentation());
            assertEquals("last edit before closing", writer.call(database -> database.get("draft", id, 0).getString("draft")).get());
            assertTrue("Main-thread disk access: " + violations, violations.isEmpty());
        } finally {
            getInstrumentation().runOnMainSync(() -> StrictMode.setThreadPolicy(previous.get()));
            finish(activity);
        }
    }

    private void finish(Activity activity) {
        if (activity.isDestroyed()) return;
        getInstrumentation().runOnMainSync(activity::finish);
        LocalChatFixture.idle(getInstrumentation());
    }
}
