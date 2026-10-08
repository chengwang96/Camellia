package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.test.InstrumentationTestRunner;
import android.view.View;
import android.widget.EditText;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

public class RemoteDiscussionsTest extends InstrumentationTestCase {
    private RemoteDiscussionsActivity activity;
    private JSONObject oldCredentials, oldState;
    private boolean oldEmbedded;
    private String oldTheme, oldLanguage;
    private CredentialStore credentials, state;
    private final String groupId = "00000000-0000-0000-0000-000000000001";
    private final String memberId = "00000000-0000-0000-0000-000000000002";
    interface Checked { void run() throws Exception; }
    interface Check { boolean ready() throws Exception; }
    private void ui(Checked action) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private static Object field(Object target, String name) throws Exception { var f = target.getClass().getDeclaredField(name); f.setAccessible(true); return f.get(target); }
    private static void field(Object target, String name, Object value) throws Exception { var f = target.getClass().getDeclaredField(name); f.setAccessible(true); f.set(target, value); }
    private void invoke(String name, Class<?>[] types, Object... args) throws Exception { var method = RemoteDiscussionsActivity.class.getDeclaredMethod(name, types); method.setAccessible(true); method.invoke(activity, args); }
    private View view(String tag) { return activity.getWindow().getDecorView().findViewWithTag(tag); }
    private View dialogView(String tag) throws Exception { return ((AlertDialog) field(activity, "dialog")).getWindow().getDecorView().findViewWithTag(tag); }
    private void waitFor(Check check) throws Exception {
        long end = android.os.SystemClock.uptimeMillis() + 20000;
        while (android.os.SystemClock.uptimeMillis() < end) {
            AtomicReference<Boolean> ready = new AtomicReference<>(false); ui(() -> ready.set(check.ready()));
            if (ready.get()) return; Thread.sleep(100);
        }
        fail("Timed out: " + (view("discussionStatus") instanceof TextView ? ((TextView) view("discussionStatus")).getText() : "no status"));
    }
    @Override protected void setUp() throws Exception {
        super.setUp(); var context = getInstrumentation().getTargetContext(); EmbeddedNetwork.initialize(context);
        oldTheme = MobilePreferences.get(context, "theme"); oldLanguage = MobilePreferences.get(context, "language");
        android.os.Bundle args = ((InstrumentationTestRunner) getInstrumentation()).getArguments();
        if (args.containsKey("discussionTheme")) MobilePreferences.set(context, "theme", args.getString("discussionTheme"));
        if (args.containsKey("discussionLanguage")) MobilePreferences.set(context, "language", args.getString("discussionLanguage"));
        oldEmbedded = EmbeddedNetwork.enabled(); EmbeddedNetwork.setEnabled(false);
        credentials = new CredentialStore(context); state = new CredentialStore(context, "remote-discussions-private");
        oldCredentials = credentials.load(); oldState = state.load(); state.save(new JSONObject());
    }
    @Override protected void tearDown() throws Exception {
        if (activity != null) { ui(() -> activity.finish()); waitFor(() -> activity.isDestroyed()); getInstrumentation().waitForIdleSync(); }
        credentials.save(oldCredentials); state.save(oldState); EmbeddedNetwork.setEnabled(oldEmbedded);
        MobilePreferences.set(getInstrumentation().getTargetContext(), "theme", oldTheme); MobilePreferences.set(getInstrumentation().getTargetContext(), "language", oldLanguage); super.tearDown();
    }
    private void start(JSONObject profile) throws Exception {
        new ComputerStore(credentials).save(profile);
        activity = (RemoteDiscussionsActivity) getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), RemoteDiscussionsActivity.class)
            .putExtra("address", profile.getString("address")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().waitForIdleSync();
    }
    private JSONObject snapshot(long cursor, String title, String answer) throws Exception {
        JSONObject participant = new JSONObject().put("id", memberId).put("name", "Scientist").put("engine", "codex").put("connection", "subscription")
            .put("model", "fixture").put("identityPrompt", "").put("capability", new JSONObject().put("available", true));
        JSONObject group = new JSONObject().put("id", groupId).put("title", title).put("participants", new JSONArray().put(participant))
            .put("messages", new JSONArray().put(new JSONObject().put("id", "reply").put("seq", 1).put("role", "assistant").put("speakerId", memberId).put("speakerName", "Scientist").put("text", answer)))
            .put("deliveries", new JSONArray()).put("requests", new JSONArray());
        return new JSONObject().put("instanceId", "fixture-instance").put("cursor", cursor).put("group", group).put("nextBefore", JSONObject.NULL);
    }
    private void offlineFixture() throws Exception {
        start(new JSONObject().put("address", "http://100.64.0.1:43129").put("token", "a".repeat(43)).put("deviceId", "fixture-device").put("computerName", "Test computer"));
        ui(() -> {
            invoke("disconnect", new Class<?>[0]); field(activity, "foreground", false); field(activity, "lastError", ""); field(activity, "groupId", groupId);
            invoke("shell", new Class<?>[0]); invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, snapshot(10, "Initial title", "Initial reply"), false);
        });
    }

    private static boolean markdownIdle(View view) {
        if (view instanceof StreamingMarkdownView && !((StreamingMarkdownView) view).idle()) return false;
        if (view instanceof android.view.ViewGroup) for (int i = 0; i < ((android.view.ViewGroup) view).getChildCount(); i++)
            if (!markdownIdle(((android.view.ViewGroup) view).getChildAt(i))) return false;
        return true;
    }
    private static TextView renderedText(View view, String value) {
        if (view instanceof TextView && ((TextView) view).getText().toString().equals(value)) return (TextView) view;
        if (view instanceof android.view.ViewGroup) for (int i = 0; i < ((android.view.ViewGroup) view).getChildCount(); i++) {
            TextView found = renderedText(((android.view.ViewGroup) view).getChildAt(i), value); if (found != null) return found;
        }
        return null;
    }
    private JSONObject historySnapshot(long cursor, int first, int count) throws Exception {
        JSONObject result = snapshot(cursor, "History window", ""); JSONObject group = result.getJSONObject("group");
        JSONArray messages = new JSONArray(), deliveries = new JSONArray(), requests = new JSONArray();
        for (int request = first; request < first + count; request++) {
            String id = "history-request-" + request, delivery = "history-delivery-" + request;
            messages.put(new JSONObject().put("seq", 2L * request - 1).put("role", "user").put("requestId", id).put("text", "Question " + request));
            messages.put(new JSONObject().put("seq", 2L * request).put("role", "assistant").put("requestId", id).put("deliveryId", delivery)
                .put("speakerId", memberId).put("speakerName", "Scientist").put("text", "Answer " + request));
            deliveries.put(new JSONObject().put("id", delivery).put("requestId", id).put("participantId", memberId).put("status", "completed").put("partialText", ""));
            requests.put(new JSONObject().put("id", id).put("mode", "parallel"));
        }
        group.put("messages", messages).put("deliveries", deliveries).put("requests", requests);
        return result.put("instanceId", "history-instance").put("nextBefore", first > 1 ? 2L * first - 1 : JSONObject.NULL);
    }
    public void testHistoryWindowEvictsViewsAndPreservesReadingPosition() throws Exception {
        offlineFixture();
        ui(() -> invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, historySnapshot(100, 151, 150), false));
        waitFor(() -> view("discussionRow:message:350").getHeight() > 0);
        AtomicReference<View> anchor = new AtomicReference<>(), removed = new AtomicReference<>(); AtomicReference<Integer> offset = new AtomicReference<>();
        ui(() -> {
            anchor.set(view("discussionRow:message:350")); android.widget.ScrollView scroll = (android.widget.ScrollView) field(activity, "scroll");
            scroll.scrollTo(0, anchor.get().getTop() + 8); offset.set(anchor.get().getTop() - scroll.getScrollY());
            invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, historySnapshot(99, 1, 150), true);
        });
        waitFor(() -> anchor.get().getTop() - ((android.widget.ScrollView) field(activity, "scroll")).getScrollY() == offset.get());
        ui(() -> {
            assertSame(anchor.get(), view("discussionRow:message:350")); assertNotNull(view("discussionHistoryLimit")); assertNull(view("discussionOlder"));
            removed.set(view("discussionRow:message:2"));
            invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, historySnapshot(101, 301, 20), false);
        });
        waitFor(() -> anchor.get().getTop() - ((android.widget.ScrollView) field(activity, "scroll")).getScrollY() == offset.get());
        ui(() -> {
            DiscussionHistory history = (DiscussionHistory) field(activity, "history");
            assertEquals(600, history.messages.size()); assertEquals(Long.valueOf(41), history.messages.firstKey());
            assertEquals(300, history.requests.size()); assertEquals(300, history.deliveries.size()); assertTrue(history.historyBytes() <= DiscussionHistory.MAX_BYTES);
            assertEquals(600, ((java.util.Map<?, ?>) field(activity, "messageRows")).size()); assertNull(view("discussionRow:message:2")); assertNull(removed.get().getParent());
            StreamingMarkdownView oldBody = removed.get().findViewWithTag("markdown"); assertEquals("", oldBody.source()); assertFalse(oldBody.hasStreamState());
            assertSame(anchor.get(), view("discussionRow:message:350")); assertFalse(((JSONObject) field(activity, "group")).has("messages"));
            JSONObject restarted = historySnapshot(1, 10, 1).put("instanceId", "restarted-host"); invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, restarted, false);
            assertEquals(2, history.messages.size()); assertFalse(history.limited()); assertNull(view("discussionHistoryLimit"));
            invoke("openGroup", new Class<?>[] {String.class}, (Object) null); assertEquals(0, history.estimatedBytes()); assertTrue(history.messages.isEmpty());
            assertEquals(0, ((java.util.Map<?, ?>) field(activity, "messageRows")).size());
        });
    }

    public void testToolHeavyHistoryTrimsRecordsAndPreservesCurrentControls() throws Exception {
        offlineFixture(); JSONObject next = historySnapshot(100, 1, 20); JSONObject group = next.getJSONObject("group");
        for (int i = 0; i < 20; i++) group.getJSONArray("deliveries").getJSONObject(i).put("tools", new JSONArray().put(new JSONObject()
            .put("id", "tool-" + i).put("name", "Fixture tool").put("status", "completed").put("inputText", "input").put("output", "x".repeat(150000))));
        for (int i = 0; i < 2; i++) {
            String request = "current-request-" + i, delivery = "current-delivery-" + i;
            // Current work can precede the host's latest message page. Its
            // controls must remain visible even without the initiating message.
            if (i > 0) group.getJSONArray("messages").put(new JSONObject().put("seq", 41 + i).put("role", "user").put("requestId", request).put("text", "Current question " + i));
            group.getJSONArray("requests").put(new JSONObject().put("id", request).put("mode", "serial"));
            group.getJSONArray("deliveries").put(new JSONObject().put("id", delivery).put("requestId", request).put("participantId", memberId)
                .put("status", i == 0 ? "running" : "failed").put("phase", i == 0 ? "approval" : "").put("partialText", "Current answer " + i));
        }
        group.put("active", true).put("pendingApprovals", new JSONArray().put(new JSONObject().put("deliveryId", "current-delivery-0").put("requestId", "approval")));
        ui(() -> { field(activity, "rich", true); invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, next, false); });
        waitFor(() -> markdownIdle(activity.getWindow().getDecorView()));
        ui(() -> {
            DiscussionHistory history = (DiscussionHistory) field(activity, "history"); assertTrue(history.limited()); assertTrue(history.historyBytes() <= DiscussionHistory.MAX_BYTES);
            assertTrue(history.messages.size() < 42); assertFalse(history.requests.containsKey("history-request-1")); assertFalse(history.deliveries.containsKey("history-delivery-1"));
            assertNotNull(view("discussionStop:current-delivery-0")); assertNotNull(view("discussionApproval:approval")); assertNotNull(view("discussionRetry:current-delivery-1")); assertNotNull(view("discussionSkip:current-delivery-1"));
            int size = history.messages.size(); long bytes = history.estimatedBytes();
            next.put("cursor", 101); invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, next, false);
            assertEquals(size, history.messages.size()); assertEquals(bytes, history.estimatedBytes());
            JSONObject retained = (JSONObject) field(activity, "group"); assertFalse(retained.has("messages")); assertFalse(retained.has("requests")); assertEquals(1, retained.getJSONArray("deliveries").length());
        });
    }

    public void testOnlyOneHistoryPageRunsAndSwitchingGroupsDiscardsItsResult() throws Exception {
        offlineFixture(); JSONObject latest = historySnapshot(100, 10, 1), earlier = historySnapshot(99, 9, 1);
        java.util.concurrent.CountDownLatch started = new java.util.concurrent.CountDownLatch(1), release = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicInteger calls = new java.util.concurrent.atomic.AtomicInteger(), finished = new java.util.concurrent.atomic.AtomicInteger();
        RemoteApi client = new RemoteApi("http://100.64.0.1:43129") {
            @Override public JSONObject json(String path, String token, JSONObject payload) throws java.io.IOException {
                calls.incrementAndGet(); started.countDown();
                try { if (!release.await(10, java.util.concurrent.TimeUnit.SECONDS)) throw new java.io.IOException("Fixture was not released"); return earlier; }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new java.io.IOException(error); }
                finally { finished.incrementAndGet(); }
            }
        };
        try {
            ui(() -> {
                invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, latest, false);
                field(activity, "api", client); field(activity, "connected", true); field(activity, "foreground", true); invoke("controls", new Class<?>[0]);
                view("discussionOlder").performClick();
                invoke("readPage", new Class<?>[] {String.class}, "/v1/discussions/" + groupId + "?before=19");
                assertFalse(view("discussionOlder").isEnabled()); assertTrue((boolean) field(activity, "pageLoading"));
            });
            assertTrue(started.await(3, java.util.concurrent.TimeUnit.SECONDS)); assertEquals(1, calls.get());
            ui(() -> {
                field(activity, "foreground", false); String nextGroup = "00000000-0000-0000-0000-000000000004";
                invoke("openGroup", new Class<?>[] {String.class}, nextGroup);
                JSONObject fresh = historySnapshot(1, 30, 1).put("instanceId", "new-host"); fresh.getJSONObject("group").put("id", nextGroup).put("title", "New group");
                invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, fresh, false); field(activity, "foreground", true);
            });
            release.countDown(); waitFor(() -> finished.get() == 1); getInstrumentation().waitForIdleSync();
            ui(() -> {
                DiscussionHistory history = (DiscussionHistory) field(activity, "history"); assertEquals(2, history.messages.size()); assertEquals(Long.valueOf(59), history.messages.firstKey());
                assertEquals("New group", ((TextView) view("discussionTitle")).getText().toString()); assertFalse((boolean) field(activity, "pageLoading"));
            });
        } finally { release.countDown(); }
    }
    public void testParallelStreamingKeepsHistoryRosterAndCompletionViews() throws Exception {
        offlineFixture(); String secondId = "00000000-0000-0000-0000-000000000003";
        JSONObject next = snapshot(20, "Parallel", "## History"); JSONObject group = next.getJSONObject("group");
        group.getJSONArray("participants").put(new JSONObject(group.getJSONArray("participants").getJSONObject(0).toString()).put("id", secondId).put("name", "Reviewer"));
        group.getJSONArray("messages").put(new JSONObject().put("seq", 2).put("role", "user").put("requestId", "request").put("text", "Question"));
        String alpha = "**Alpha**\n\n```java\nline one\n", beta = "## Beta\n\nFirst";
        JSONObject first = new JSONObject().put("id", "alpha").put("requestId", "request").put("participantId", memberId).put("runId", 1).put("status", "running").put("partialText", alpha);
        JSONObject second = new JSONObject().put("id", "beta").put("requestId", "request").put("participantId", secondId).put("runId", 1).put("status", "running").put("partialText", beta);
        group.put("deliveries", new JSONArray().put(first).put(second)).put("requests", new JSONArray().put(new JSONObject().put("id", "request").put("mode", "parallel")));
        ui(() -> invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, next, false));
        waitFor(() -> markdownIdle(activity.getWindow().getDecorView()) && renderedText(activity.getWindow().getDecorView(), "Alpha") != null);
        AtomicReference<View> history = new AtomicReference<>(), chip = new AtomicReference<>(), code = new AtomicReference<>(), betaHeading = new AtomicReference<>();
        ui(() -> { history.set(renderedText(activity.getWindow().getDecorView(), "History")); chip.set(view("discussionSelect:" + memberId)); code.set(view("markdownCodeText")); betaHeading.set(renderedText(activity.getWindow().getDecorView(), "Beta")); });
        first.put("partialText", alpha + "line two\n"); second.put("partialText", beta + "\n\nSecond"); next.put("cursor", 21);
        ui(() -> invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, next, false)); waitFor(() -> markdownIdle(activity.getWindow().getDecorView()));
        ui(() -> { assertSame(history.get(), renderedText(activity.getWindow().getDecorView(), "History")); assertSame(chip.get(), view("discussionSelect:" + memberId)); assertSame(code.get(), view("markdownCodeText")); assertSame(betaHeading.get(), renderedText(activity.getWindow().getDecorView(), "Beta")); });
        String completed = alpha + "line two\n```\n";
        first.put("status", "completed").put("partialText", ""); next.put("cursor", 22);
        group.getJSONArray("messages").put(new JSONObject().put("seq", 3).put("role", "assistant").put("speakerId", memberId).put("speakerName", "Scientist").put("deliveryId", "alpha").put("text", completed));
        ui(() -> invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, next, false)); waitFor(() -> markdownIdle(activity.getWindow().getDecorView()));
        ui(() -> { assertSame(code.get(), view("markdownCodeText")); assertEquals("line one\nline two", ((TextView) code.get()).getText().toString()); assertSame(chip.get(), view("discussionSelect:" + memberId)); assertNull(view("discussionStop:alpha")); });
        second.put("runId", 2).put("partialText", "## Restarted"); next.put("cursor", 23);
        ui(() -> invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, next, false)); waitFor(() -> markdownIdle(activity.getWindow().getDecorView()));
        ui(() -> { assertNotNull(renderedText(activity.getWindow().getDecorView(), "Restarted")); assertNull(renderedText(activity.getWindow().getDecorView(), "Beta")); assertSame(history.get(), renderedText(activity.getWindow().getDecorView(), "History")); });
        ui(() -> invoke("openGroup", new Class<?>[] {String.class}, (Object) null));
        ui(() -> assertEquals(0, ((java.util.Map<?, ?>) field(activity, "messageRows")).size()));
    }
    public void testUnreadableStateSurvivesSavingRecreationAndSuccessfulRetry() throws Exception {
        var context = getInstrumentation().getTargetContext();
        assertTrue(android.os.Build.HARDWARE.equals("ranchu") || android.os.Build.HARDWARE.equals("goldfish"));
        JSONObject computer = new JSONObject().put("address", "http://100.64.0.1:43129").put("token", "a".repeat(43)).put("deviceId", "fixture-device");
        String key = computer.getString("address") + "#fixture-device";
        String requestId = UUID.randomUUID().toString();
        JSONObject stored = new JSONObject().put(key, new JSONObject()
            .put("drafts", new JSONObject().put(groupId, new JSONObject().put("text", "Keep the group draft")))
            .put("pending", new JSONObject().put(requestId, new JSONObject().put("requestId", requestId).put("action", "send"))))
            .put("another-computer", new JSONObject().put("drafts", new JSONObject().put("other", "Keep other data")));
        state.save(stored);
        var preferences = context.getSharedPreferences("remote-discussions-private", 0);
        String original = preferences.getString("credential", null);
        JSONObject envelope = new JSONObject(original);
        byte[] damaged = android.util.Base64.decode(envelope.getString("data"), android.util.Base64.NO_WRAP); damaged[0] ^= 1;
        String unreadable = envelope.put("data", android.util.Base64.encodeToString(damaged, android.util.Base64.NO_WRAP)).toString();
        assertTrue(preferences.edit().putString("credential", unreadable).commit());
        start(computer);
        ui(() -> {
            assertNotNull(view("discussionStateLoadError")); assertNull(view("discussionCreate"));
            assertFalse((boolean) field(activity, "stateReady")); assertNull(field(activity, "api"));
            var save = RemoteDiscussionsActivity.class.getDeclaredMethod("persist"); save.setAccessible(true);
            assertEquals(false, save.invoke(activity));
            invoke("submit", new Class<?>[]{String.class, String.class, JSONObject.class}, "create", null, new JSONObject().put("title", "Must not overwrite"));
        });
        assertEquals(unreadable, preferences.getString("credential", null));
        recreateFromError();
        assertEquals(unreadable, preferences.getString("credential", null));
        ui(() -> assertNotNull(view("discussionStateLoadError")));
        assertTrue(preferences.edit().putString("credential", original).commit());
        recreateFromError();
        ui(() -> {
            invoke("disconnect", new Class<?>[0]);
            assertTrue((boolean) field(activity, "stateReady"));
            assertEquals("Keep the group draft", ((JSONObject) field(activity, "drafts")).getJSONObject(groupId).getString("text"));
            assertEquals(requestId, ((JSONObject) field(activity, "pending")).getJSONObject(requestId).getString("requestId"));
            assertEquals(stored.toString(), ((JSONObject) field(activity, "state")).toString());
        });
        assertEquals(original, preferences.getString("credential", null));
    }

    private void recreateFromError() throws Exception {
        var monitor = getInstrumentation().addMonitor(RemoteDiscussionsActivity.class.getName(), null, false);
        try {
            ui(() -> view("discussionStateRetry").performClick());
            Activity next = getInstrumentation().waitForMonitorWithTimeout(monitor, 6000);
            assertNotNull("Retry must reopen the discussion with a fresh state read", next);
            activity = (RemoteDiscussionsActivity) next; getInstrumentation().waitForIdleSync();
        } finally { getInstrumentation().removeMonitor(monitor); }
    }

    public void testFirstUseWithoutStoredDiscussionStateStillInitializes() throws Exception {
        state.clear();
        start(new JSONObject().put("address", "http://100.64.0.1:43129").put("token", "a".repeat(43)).put("deviceId", "fixture-device"));
        ui(() -> {
            invoke("disconnect", new Class<?>[0]);
            assertTrue((boolean) field(activity, "stateReady")); assertNull(view("discussionStateLoadError"));
            assertNotNull(view("discussionCreate"));
        });
    }

    public void testMalformedProfileIsNotReplacedWithAnEmptyDraft() throws Exception {
        state.save(new JSONObject().put("http://100.64.0.1:43129#fixture-device", new JSONObject().put("drafts", "invalid draft object")));
        var preferences = getInstrumentation().getTargetContext().getSharedPreferences("remote-discussions-private", 0);
        String original = preferences.getString("credential", null);
        start(new JSONObject().put("address", "http://100.64.0.1:43129").put("token", "a".repeat(43)).put("deviceId", "fixture-device"));
        ui(() -> { assertNotNull(view("discussionStateLoadError")); activity.onBackPressed(); });
        getInstrumentation().waitForIdleSync();
        assertEquals(original, preferences.getString("credential", null));
    }

    public void testStreamRefreshPreservesDraftSelectionAndComposerAndRejectsStaleSnapshot() throws Exception {
        offlineFixture();
        ui(() -> {
            field(activity, "connected", true); invoke("controls", new Class<?>[0]);
            String note = ((TextView) view("discussionStatus")).getText().toString();
            assertTrue(note, note.contains("note") || note.contains("仅保存"));
            EditText composer = (EditText) view("discussionComposer"); composer.setText("Unsent draft"); composer.setSelection(4);
            view("discussionSelect:" + memberId).performClick();
            invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, snapshot(12, "Renamed on desktop", "Updated reply"), false);
            assertSame(composer, view("discussionComposer")); assertEquals("Unsent draft", composer.getText().toString()); assertEquals(4, composer.getSelectionStart());
            assertTrue(view("discussionSelect:" + memberId).isSelected());
            invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, snapshot(11, "Stale title", "Old reply"), false);
            assertEquals("Renamed on desktop", ((TextView) view("discussionTitle")).getText().toString());
            invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, snapshot(13, "Wrong group", "Wrong").put("group", snapshot(13, "Wrong group", "Wrong").getJSONObject("group").put("id", UUID.randomUUID().toString())), false);
            assertEquals("Renamed on desktop", ((TextView) view("discussionTitle")).getText().toString());
        });
    }
    public void testIdentityEditorOptionalAndDraftSurvivesSwitchingGroups() throws Exception {
        offlineFixture();
        ui(() -> {
            view("discussionSpeaker:" + memberId).performClick();
            EditText prompt = (EditText) dialogView("discussionIdentityInput"); assertEquals("", prompt.getText().toString());
            assertTrue(prompt.getMaxLines() > 1); ((AlertDialog) field(activity, "dialog")).dismiss();
            ((EditText) view("discussionComposer")).setText("Saved group draft"); view("discussionSelect:" + memberId).performClick();
            invoke("openGroup", new Class<?>[] {String.class}, UUID.randomUUID().toString());
            assertEquals("", ((EditText) view("discussionComposer")).getText().toString());
            invoke("openGroup", new Class<?>[] {String.class}, groupId);
            invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, snapshot(20, "Returned", "Reply"), false);
            assertEquals("Saved group draft", ((EditText) view("discussionComposer")).getText().toString());
            assertTrue(view("discussionSelect:" + memberId).isSelected());
            assertEquals(android.view.View.GONE, view("discussionStop").getVisibility());
        });
    }

    public void testDiscussionUsesConnectionHeaderAndFixedWorkStatus() throws Exception {
        offlineFixture();
        ui(() -> {
            field(activity, "connected", true); field(activity, "chinese", true);
            JSONObject next = snapshot(20, "Working", "Reply");
            next.getJSONObject("group").put("active", true).put("deliveries", new JSONArray().put(new JSONObject()
                .put("id", "delivery").put("participantId", memberId).put("status", "running").put("tools", new JSONArray()
                    .put(new JSONObject().put("id", "tool").put("name", "read").put("status", "running")))));
            invoke("apply", new Class<?>[]{JSONObject.class, boolean.class}, next, false);
            TextView status = (TextView) view("discussionStatus"), header = (TextView) view("headerConnectionState");
            assertEquals("已连接", header.getText().toString()); assertEquals("正在执行工具…", status.getText().toString());
            status.measure(View.MeasureSpec.makeMeasureSpec(280, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
            int height = status.getMeasuredHeight();
            invoke("showError", new Class<?>[]{String.class}, "操作未确认，请检查回执");
            invoke("apply", new Class<?>[]{JSONObject.class, boolean.class}, snapshot(21, "Idle", "Reply"), false);
            assertEquals("操作未确认，请检查回执", status.getText().toString()); assertTrue(status.isClickable());
            status.measure(View.MeasureSpec.makeMeasureSpec(280, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
            assertEquals(height, status.getMeasuredHeight()); assertEquals(View.VISIBLE, status.getVisibility()); assertEquals(1, status.getMaxLines());
            assertEquals("已连接", header.getText().toString());
        });
    }
    public void testAndroidDiscussionGatewayWorkflow() throws Exception {
        if (!"true".equals(((InstrumentationTestRunner) getInstrumentation()).getArguments().getString("discussionIntegration"))) return;
        String address = "http://100.64.0.1:43129";
        RemoteApi client = new RemoteApi(address);
        JSONObject request = client.json("/v1/pair/request", null, new JSONObject().put("code", "discussion-fixture-only").put("name", "Discussion test phone"));
        JSONObject profile = client.json("/v1/pair/claim", null, new JSONObject().put("id", request.getString("id")).put("claim", request.getString("claim")));
        profile.put("address", address).put("computerName", "Discussion test host"); String token = profile.getString("token");
        start(profile); waitFor(() -> (boolean) field(activity, "connected"));
        ui(() -> {
            view("discussionCreate").performClick(); ((EditText) dialogView("discussionNameInput")).setText("Android discussion");
            ((AlertDialog) field(activity, "dialog")).getButton(AlertDialog.BUTTON_POSITIVE).performClick();
        });
        waitFor(() -> !((java.util.Set<?>) field(activity, "uncertain")).isEmpty());
        ui(() -> {
            String pendingId = ((JSONObject) field(activity, "pending")).keys().next();
            assertNotNull(view("discussionPending:" + pendingId)); view("discussionPending:" + pendingId).performClick();
        });
        waitFor(() -> field(activity, "groupId") != null && field(activity, "group") != null);
        String id = (String) field(activity, "groupId");
        ui(() -> { view("discussionMembers").performClick(); dialogView("discussionAddMember").performClick(); });
        waitFor(() -> field(activity, "dialog") != null && ((AlertDialog) field(activity, "dialog")).isShowing() && dialogView("camelliaDialogItem:5") != null);
        ui(() -> {
            dialogView("camelliaDialogItem:1").performClick(); // Codex
            dialogView("camelliaDialogItem:0").performClick(); // model
            ((EditText) dialogView("discussionMemberName")).setText("Scientist");
            ((EditText) dialogView("discussionIdentityInput")).setText("You are a scientist.");
            ((AlertDialog) field(activity, "dialog")).getButton(AlertDialog.BUTTON_POSITIVE).performClick();
        });
        waitFor(() -> ((JSONObject) field(activity, "group")).getJSONArray("participants").length() == 1);
        JSONObject catalog = client.json("/v1/discussions/catalog", token, null);
        operation(client, token, "add-member", id, new JSONObject().put("bindingId", catalog.getJSONArray("bindings").getJSONObject(0).getString("id")).put("name", "Developer"));
        waitFor(() -> ((JSONObject) field(activity, "group")).getJSONArray("participants").length() == 2 && ((JSONObject) field(activity, "pending")).length() == 0);
        JSONObject group = client.json("/v1/discussions/" + id, token, null).getJSONObject("group");
        String first = group.getJSONArray("participants").getJSONObject(0).getString("id"), second = group.getJSONArray("participants").getJSONObject(1).getString("id");
        ui(() -> {
            view("discussionSelect:" + first).performClick(); view("discussionSelect:" + second).performClick();
            ((ChatComposer) field(activity, "composer")).model.performClick(); dialogView("settingsChoice:1").performClick();
            ((EditText) view("discussionComposer")).setText("Discuss the design"); view("discussionSend").performClick();
        });
        waitFor(() -> ((java.util.Map<?, ?>) field(activity, "messages")).size() == 3 && ((EditText) view("discussionComposer")).length() == 0);
        AtomicReference<View> composer = new AtomicReference<>();
        ui(() -> { composer.set(view("discussionComposer")); ((EditText) composer.get()).setText("Keep this draft"); ((EditText) composer.get()).setSelection(4); });
        operation(client, token, "rename", id, new JSONObject().put("title", "Synced from desktop"));
        operation(client, token, "pin", id, new JSONObject().put("pinned", true));
        waitFor(() -> ((TextView) view("discussionTitle")).getText().toString().equals("Synced from desktop"));
        ui(() -> {
            assertSame(composer.get(), view("discussionComposer")); assertEquals("Keep this draft", ((EditText) composer.get()).getText().toString());
            assertEquals(4, ((EditText) composer.get()).getSelectionStart()); view("discussionSpeaker:" + first).performClick();
            ((EditText) dialogView("discussionIdentityInput")).setText("");
            ((AlertDialog) field(activity, "dialog")).getButton(AlertDialog.BUTTON_POSITIVE).performClick();
        });
        waitFor(() -> ((JSONObject) field(activity, "group")).getJSONArray("participants").getJSONObject(0).optString("identityPrompt").isEmpty() && ((JSONObject) field(activity, "pending")).length() == 0);
        ui(() -> { var manager = (android.view.inputmethod.InputMethodManager) activity.getSystemService(Activity.INPUT_METHOD_SERVICE); manager.hideSoftInputFromWindow(view("discussionComposer").getWindowToken(), 0); });
        getInstrumentation().waitForIdleSync(); Thread.sleep(300);
        android.graphics.Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot();
        if (image != null) try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), "discussion-integration.png"))) { image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output); image.recycle(); }
        // Return a real image URI through the activity's picker callback. The
        // document follows the shared document reader used by ordinary chat.
        java.io.File camera = new java.io.File(activity.getCacheDir(), "camera"); camera.mkdirs();
        java.io.File photo = new java.io.File(camera, "rich-photo.jpg"), notes = new java.io.File(camera, "rich-notes.txt");
        android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(24, 24, android.graphics.Bitmap.Config.ARGB_8888); bitmap.eraseColor(android.graphics.Color.BLUE);
        try (var output = new java.io.FileOutputStream(photo)) { bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 90, output); } bitmap.recycle();
        try (var output = new java.io.FileOutputStream(notes)) { output.write("Mobile document bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
        ui(() -> {
            field(activity, "pickerGroup", id);
            invoke("onActivityResult", new Class<?>[]{int.class, int.class, Intent.class}, 811, Activity.RESULT_OK, new Intent().setData(CameraFileProvider.uri(activity, photo)));
        });
        waitFor(() -> ((java.util.List<?>) field(activity, "images")).size() == 1 && !(boolean) field(activity, "loadingAttachments"));
        JSONObject document = ChatDocument.read(activity, CameraFileProvider.uri(activity, notes), false);
        ui(() -> {
            ((java.util.List<JSONObject>) field(activity, "documents")).add(document); invoke("renderAttachments", new Class<?>[0]);
            view("discussionSelect:" + second).performClick(); ((EditText) view("discussionComposer")).setText("RICH_REQUEST"); view("discussionSend").performClick();
        });
        waitFor(() -> view("discussionApproval:rich-question") != null && ((JSONObject) field(activity, "pending")).length() == 0);
        ui(() -> {
            view("discussionApproval:rich-question").performClick(); AlertDialog approval = (AlertDialog) field(activity, "approvalDialog");
            android.view.View root = approval.getWindow().getDecorView();
            // Use the actual choice widgets, including both multi-select boxes.
            clickChoice(root, "Scientist"); clickChoice(root, "Text"); clickChoice(root, "Image");
            ((EditText) root.findViewWithTag("approvalAnswer:notes")).setText("Mobile answer");
        });
        screenshot("discussion-questions.png");
        ui(() -> ((AlertDialog) field(activity, "approvalDialog")).getButton(AlertDialog.BUTTON_POSITIVE).performClick());
        waitFor(() -> ((java.util.Map<?, ?>) field(activity, "messages")).size() == 5 && ((JSONObject) field(activity, "pending")).length() == 0);
        ui(() -> { assertTrue(((java.util.List<?>) field(activity, "images")).isEmpty()); assertTrue(((java.util.List<?>) field(activity, "documents")).isEmpty()); });
        JSONArray artifacts = client.json("/v1/discussions/" + id + "/artifacts", token, null).getJSONArray("artifacts");
        JSONObject artifact = null; for (int i = 0; i < artifacts.length(); i++) if (artifacts.getJSONObject(i).optString("name").equals("mobile-result.txt")) artifact = artifacts.getJSONObject(i);
        assertNotNull(artifact); java.io.ByteArrayOutputStream downloaded = new java.io.ByteArrayOutputStream();
        client.download("/v1/discussions/" + id + "/artifacts/" + artifact.getString("id"), token, downloaded, artifact.getLong("size"), (received, total) -> {});
        assertEquals("Confirmed from phone", downloaded.toString("UTF-8")); photo.delete(); notes.delete();
        JSONObject photoArtifact = null;
        for (int i = 0; i < artifacts.length(); i++) if (artifacts.getJSONObject(i).optString("extension").matches("(?i)\\.?jpe?g")) photoArtifact = artifacts.getJSONObject(i);
        assertNotNull(photoArtifact); String previewTag = "artifactPreview:" + photoArtifact.getString("id");
        ui(() -> invoke("showFiles", new Class<?>[0]));
        Object downloads = field(activity, "downloads");
        waitFor(() -> ((android.app.Dialog) field(downloads, "dialog")).getWindow().getDecorView().findViewWithTag(previewTag) != null);
        ui(() -> ((android.app.Dialog) field(downloads, "dialog")).getWindow().getDecorView().findViewWithTag(previewTag).performClick());
        waitFor(() -> field(downloads, "imagePreview") != null);
        ui(() -> {
            AlertDialog preview = (AlertDialog) field(downloads, "imagePreview");
            android.widget.ImageView picture = preview.getWindow().getDecorView().findViewWithTag("artifactImage");
            assertEquals(24, ((android.graphics.drawable.BitmapDrawable) picture.getDrawable()).getBitmap().getWidth()); preview.dismiss();
            ((android.app.Dialog) field(downloads, "dialog")).dismiss();
        });
        screenshot("discussion-rich-result.png");
        operation(client, token, "delete", id, new JSONObject()); waitFor(() -> field(activity, "groupId") == null);
        client.cancel();
    }
    private void screenshot(String name) throws Exception {
        getInstrumentation().waitForIdleSync();
        Thread.sleep(350); // Let the platform's dialog enter/exit animation finish.
        android.graphics.Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot();
        if (image != null) try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), name))) {
            image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output); image.recycle();
        }
    }
    private void clickChoice(View root, String text) {
        View view = root.findViewWithTag(text); assertNotNull(view); view.performClick();
    }
    private JSONObject operation(RemoteApi api, String token, String action, String id, JSONObject parameters) throws Exception {
        String instance = api.json("/v1/status", token, null).getString("instanceId"), requestId = UUID.randomUUID().toString();
        JSONObject command = new JSONObject().put("requestId", requestId).put("instanceId", instance).put("action", action).put("parameters", parameters);
        if (id != null) command.put("id", id);
        JSONObject receipt = api.json("/v1/discussions/commands", token, command);
        for (int i = 0; i < 80 && receipt.optString("state").equals("pending"); i++) {
            Thread.sleep(100); receipt = api.json("/v1/discussions/commands/" + requestId, token, null);
        }
        assertEquals(receipt.toString(), "completed", receipt.optString("state")); return receipt;
    }
}
