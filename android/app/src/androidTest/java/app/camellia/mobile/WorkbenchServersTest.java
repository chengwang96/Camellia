package app.camellia.mobile;

import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

public class WorkbenchServersTest extends InstrumentationTestCase {
    private MainActivity activity;
    private ComputerStore store;
    private RemoteListCache cache;
    private RemoteReplyState replies;
    private JSONObject hp, other;
    private String originalLanguage, originalTheme;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        originalLanguage = MobilePreferences.get(context, "language"); originalTheme = MobilePreferences.get(context, "theme");
        var arguments = ((android.test.InstrumentationTestRunner) getInstrumentation()).getArguments();
        if (arguments.containsKey("language")) MobilePreferences.set(context, "language", arguments.getString("language"));
        if (arguments.containsKey("theme")) MobilePreferences.set(context, "theme", arguments.getString("theme"));
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        new CredentialStore(context).clear();
        store = new ComputerStore(new CredentialStore(context)); cache = RemoteListCache.workbench(context);
        hp = computer("http://100.80.1.2:43127", "HP"); other = computer("http://100.80.1.3:43127", "Research server");
        for (JSONObject computer : List.of(hp, other)) { cache.remove(computer); RemoteListCache.get(context).remove(computer); }
        // Starting with no pairings prevents real network work in this fixture.
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        var preferences = context.getSharedPreferences("workbench-replies-test", 0);
        preferences.edit().clear().commit();
        replies = new RemoteReplyState(preferences);
        main(() -> field("replyState", replies));
        store.save(other); store.save(hp);
    }
    @Override protected void tearDown() throws Exception {
        if (activity != null) getInstrumentation().runOnMainSync(activity::finish);
        getInstrumentation().waitForIdleSync();
        for (JSONObject computer : List.of(hp, other)) { cache.remove(computer); RemoteListCache.get(getInstrumentation().getTargetContext()).remove(computer); }
        new CredentialStore(getInstrumentation().getTargetContext()).clear();
        getInstrumentation().getTargetContext().getSharedPreferences("workbench-replies-test", 0).edit().clear().commit();
        MobilePreferences.set(getInstrumentation().getTargetContext(), "language", originalLanguage);
        MobilePreferences.set(getInstrumentation().getTargetContext(), "theme", originalTheme);
        super.tearDown();
    }
    private JSONObject computer(String address, String name) throws Exception {
        return new JSONObject().put("address", address).put("computerName", name).put("token", "a".repeat(43));
    }
    private JSONObject row(String id, String title, String state, long at) throws Exception {
        return new JSONObject().put("id", id).put("title", title).put("activity", state).put("engine", "codex")
            .put("modelName", "GPT-6.1-Sol").put("updatedAt", at).put("lastReplyAt", 0).put("replyReadAt", 0);
    }
    private void seed(JSONObject computer, JSONObject... rows) {
        JSONArray values = new JSONArray(); for (JSONObject row : rows) values.put(row);
        cache.put(computer, values, -1, new JSONArray(), false);
    }
    private void home() throws Exception {
        main(() -> { field("credentials", hp); field("foreground", false); invoke("homeScreen"); });
    }
    private String tag(String prefix, JSONObject computer, String id) { return prefix + computer.optString("address") + "#" + id; }
    private View view(String tag) { return activity.getWindow().getDecorView().findViewWithTag(tag); }
    private interface Action { void run() throws Exception; }
    private void main(Action action) {
        Throwable[] failure = { null };
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure[0] = error; } });
        if (failure[0] != null) throw new AssertionError(failure[0]);
    }
    private Object field(String name) throws Exception { var field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); return field.get(activity); }
    private void field(String name, Object value) throws Exception { var field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); field.set(activity, value); }
    private void invoke(String name) throws Exception { var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity); }
    private void capture(String name) throws Exception {
        android.os.SystemClock.sleep(250);
        java.io.File directory = new java.io.File(activity.getExternalFilesDir(null), "workbench-servers");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
        try (var output = new java.io.FileOutputStream(new java.io.File(directory, name + ".png"))) {
            assertTrue(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output));
        } finally { screenshot.recycle(); }
    }

    public void testCachedCardsKeepBothServerIdentitiesAndClickTheCorrectServer() throws Exception {
        long now = System.currentTimeMillis();
        seed(hp, row("same-id", "HP task", "running", now));
        seed(other, row("same-id", "Server task", "running", now - 1000));
        home();
        main(() -> {
            View first = view(tag("homeActive:", hp, "same-id")), second = view(tag("homeActive:", other, "same-id"));
            assertNotNull(first); assertNotNull(second); assertNotSame(first, second);
            assertTrue(((TextView) first.findViewWithTag("conversationRowMeta")).getText().toString().startsWith("HP · "));
            assertTrue(((TextView) second.findViewWithTag("conversationRowMeta")).getText().toString().startsWith("Research server · "));
            assertTrue(uncertainActivity(((TextView) first.findViewWithTag(tag("homeActiveStatus:", hp, "same-id"))).getText().toString()));
            assertEquals(hp.optString("address"), ((JSONObject) field("credentials")).optString("address"));
            second.performClick();
            assertEquals("detail", field("screen")); assertEquals("same-id", field("conversationId"));
            assertEquals("Server task", field("conversationTitle")); assertEquals("home", field("detailReturn"));
            assertEquals(other.optString("address"), ((JSONObject) field("credentials")).optString("address"));
            assertEquals(other.optString("address"), store.load().optString("address"));
        });
    }

    public void testRecentSortsAcrossServersAndViewAllExpandsAcrossServers() throws Exception {
        long now = System.currentTimeMillis();
        seed(hp, row("hp-new", "HP newest", "idle", now), row("hp-old", "HP old", "idle", now - 4000));
        seed(other, row("server-new", "Server newest", "idle", now - 1000), row("server-mid", "Server middle", "idle", now - 2000), row("server-old", "Server old", "idle", now - 3000));
        home();
        main(() -> {
            View first = view(tag("homeRecent:", hp, "hp-new")), second = view(tag("homeRecent:", other, "server-new")), third = view(tag("homeRecent:", other, "server-mid"));
            assertNotNull(first); assertNotNull(second); assertNotNull(third);
            assertTrue(first.getTop() < second.getTop()); assertTrue(second.getTop() < third.getTop());
            assertNull(view(tag("homeRecent:", hp, "hp-old")));
            view("homeRecentAll").performClick();
        });
        getInstrumentation().waitForIdleSync();
        main(() -> {
            assertEquals("home", field("screen"));
            assertNotNull(view(tag("homeRecent:", hp, "hp-old"))); assertNotNull(view(tag("homeRecent:", other, "server-old")));
        });
    }

    public void testRecentUnreadRepliesUseTheirSourceComputerAndRefreshAfterReading() throws Exception {
        long now = System.currentTimeMillis();
        JSONObject hpReply = row("same-id", "Read on HP", "idle", now).put("lastReplyAt", now).put("replyReadAt", 0);
        JSONObject otherReply = row("same-id", "Unread on another server", "idle", now - 1000).put("lastReplyAt", now).put("replyReadAt", 0);
        replies.markRead(hp, hpReply);
        seed(hp, hpReply); seed(other, otherReply); home();
        View[] unchanged = new View[1];
        main(() -> {
            unchanged[0] = view(tag("homeRecent:", hp, "same-id"));
            assertNull("Reading HP must clear its cached unread mark", view(tag("homeRecentStatus:", hp, "same-id")));
            assertNewReply(other, "same-id");
            assertEquals(hp.optString("address"), ((JSONObject) field("credentials")).optString("address"));
            replies.markRead(other, otherReply);
            invoke("updateHomeConversations");
            assertNull("Local reads must override an older server receipt", view(tag("homeRecentStatus:", other, "same-id")));
            assertSame("Unchanged cards should stay attached", unchanged[0], view(tag("homeRecent:", hp, "same-id")));
            assertFalse(view(tag("homeRecent:", other, "same-id")).getContentDescription().toString().matches(".*(未读回复|Unread reply).*"));
        });
        seed(other, new JSONObject(otherReply.toString()).put("lastReplyAt", now + 1));
        main(() -> {
            invoke("updateHomeConversations");
            assertNewReply(other, "same-id");
        });
        getInstrumentation().waitForIdleSync();
        main(() -> {
            View row = view(tag("homeRecent:", other, "same-id"));
            TextView status = (TextView) view(tag("homeRecentStatus:", other, "same-id"));
            TextView title = row.findViewWithTag("conversationRowTitle");
            assertTrue("The title must retain space beside the unread pill", title.getWidth() > 0);
            assertTrue("Unread pill must not overlap the title", title.getRight() <= status.getLeft());
            assertNotNull(status.getLayout());
            assertEquals("The short unread label must fit without clipping", 0, status.getLayout().getEllipsisCount(0));
        });
        capture("recent-unread-source-scoped");
    }

    public void testRecentDoesNotMarkServerReadRepliesOrUserOnlyUpdates() throws Exception {
        long now = System.currentTimeMillis();
        seed(hp, row("server-read", "Already read", "idle", now).put("lastReplyAt", now).put("replyReadAt", now),
            row("user-only", "User-only update", "idle", now - 1).put("lastReplyAt", 0).put("replyReadAt", 0),
            row("legacy", "Older desktop", "idle", now - 2));
        home();
        main(() -> {
            for (String id : List.of("server-read", "user-only", "legacy")) {
                assertNotNull(view(tag("homeRecent:", hp, id)));
                assertNull(view(tag("homeRecentStatus:", hp, id)));
            }
        });
        seed(hp, row("server-read", "Already read", "idle", now).put("lastReplyAt", now + 1).put("replyReadAt", now));
        main(() -> { invoke("updateHomeConversations"); assertNewReply(hp, "server-read"); });
        seed(hp, row("server-read", "Already read", "idle", now).put("lastReplyAt", now + 1).put("replyReadAt", now + 1));
        main(() -> {
            invoke("updateHomeConversations");
            assertNull("A server read receipt alone must remove the pill", view(tag("homeRecentStatus:", hp, "server-read")));
        });
    }

    public void testRecentUnreadClearsAfterOpeningAndDisplayingTheReply() throws Exception {
        long now = System.currentTimeMillis();
        JSONObject reply = row("open-unread", "Open new reply", "idle", now).put("lastReplyAt", now).put("replyReadAt", 0);
        seed(other, reply); home();
        main(() -> {
            assertNewReply(other, "open-unread");
            view(tag("homeRecent:", other, "open-unread")).performClick();
            assertEquals("detail", field("screen"));
            assertTrue("Opening alone must not mark a reply that has not loaded", replies.unread(other, reply));
            JSONObject snapshot = new JSONObject().put("instanceId", "unread-test").put("cursor", 1)
                .put("conversation", reply).put("messages", new JSONArray().put(new JSONObject()
                    .put("role", "assistant").put("text", "New reply content").put("seq", 1).put("at", now)));
            field("foreground", true);
            var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class);
            apply.setAccessible(true); apply.invoke(activity, snapshot);
            assertFalse("A displayed reply must be acknowledged locally", replies.unread(other, reply));
            field("foreground", false);
            activity.onBackPressed();
            assertEquals("home", field("screen"));
            assertNotNull(view(tag("homeRecent:", other, "open-unread")));
            assertNull("Returning Home must clear the unread badge even with an older cached receipt",
                view(tag("homeRecentStatus:", other, "open-unread")));
        });
    }

    private void assertNewReply(JSONObject computer, String id) {
        TextView status = (TextView) view(tag("homeRecentStatus:", computer, id));
        assertNotNull("Unread recent replies need a status pill", status);
        assertTrue(status.getText().toString().matches("未读回复|Unread reply"));
        assertEquals(Palette.of(activity).accent, status.getCurrentTextColor());
        assertTrue(view(tag("homeRecent:", computer, id)).getContentDescription().toString().contains(status.getText()));
    }

    public void testRecentMatchesSessionsEvenWhenHomeSummaryHasNoReplyMarkers() throws Exception {
        long now = System.currentTimeMillis();
        JSONObject summary = row("wm", "WM scope prune sims", "idle", now);
        summary.remove("lastReplyAt"); summary.remove("replyReadAt");
        seed(hp, summary); seed(other, summary);
        JSONObject listed = new JSONObject(summary.toString()).put("lastReplyAt", now).put("replyReadAt", 0);
        var sessions = RemoteListCache.get(getInstrumentation().getTargetContext());
        sessions.put(hp, new JSONArray().put(listed), -1, new JSONArray(), true);
        main(() -> {
            field("credentials", hp); field("foreground", false); invoke("listScreen");
            @SuppressWarnings("unchecked") java.util.Map<String, JSONObject> rows = (java.util.Map<String, JSONObject>) field("conversations");
            rows.clear(); rows.put("wm", listed); field("listLoaded", true); invoke("renderConversations");
            TextView sessionStatus = (TextView) view("conversationStatus:wm");
            assertNotNull(sessionStatus);
            String label = sessionStatus.getText().toString();
            invoke("homeScreen");
            assertNewReply(hp, "wm");
            assertEquals("Home and Sessions must use the same unread label", label,
                ((TextView) view(tag("homeRecentStatus:", hp, "wm"))).getText().toString());
            assertNull("A matching id on another computer must not inherit HP's reply state", view(tag("homeRecentStatus:", other, "wm")));
        });
        getInstrumentation().waitForIdleSync(); capture("recent-matches-sessions-old-summary");
        listed.put("replyReadAt", now);
        sessions.put(hp, new JSONArray().put(listed), -1, new JSONArray(), true);
        main(() -> { invoke("updateHomeConversations"); assertNull(view(tag("homeRecentStatus:", hp, "wm"))); });
        listed.put("lastReplyAt", now + 1);
        sessions.put(hp, new JSONArray().put(listed), -1, new JSONArray(), true);
        main(() -> { invoke("updateHomeConversations"); assertNewReply(hp, "wm"); });
        // A later Home read receipt must also win over an older Sessions cache.
        seed(hp, new JSONObject(listed.toString()).put("lastReplyAt", now + 2).put("replyReadAt", now + 2));
        main(() -> { invoke("updateHomeConversations"); assertNull(view(tag("homeRecentStatus:", hp, "wm"))); });
    }

    public void testOldHomeEndpointGetsUnreadStateFromTheSessionStream() throws Exception {
        long now = System.currentTimeMillis();
        JSONObject summary = row("old-server", "Old desktop new reply", "idle", now);
        summary.remove("lastReplyAt"); summary.remove("replyReadAt");
        JSONObject listed = new JSONObject(summary.toString()).put("lastReplyAt", now).put("replyReadAt", 0);
        seed(hp, summary); home();
        CountDownLatch subscribed = new CountDownLatch(1), closed = new CountDownLatch(1);
        RemoteApi.SnapshotListener[] listListener = new RemoteApi.SnapshotListener[1];
        main(() -> {
            field("homeClientFactory", (Function<String, RemoteApi>) address -> new RemoteApi(address) {
                @Override void workbenchEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws java.io.IOException {
                    try { listener.onSnapshot(new JSONObject().put("workbench", new JSONObject().put("conversations", new JSONArray().put(summary)))); }
                    catch (org.json.JSONException error) { throw new java.io.IOException(error); }
                }
                @Override public void listEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws java.io.IOException {
                    boolean target = address.equals(hp.optString("address"));
                    if (target) listListener[0] = listener;
                    try {
                        listener.onSnapshot(new JSONObject().put("conversationList", new JSONObject().put("conversations", new JSONArray().put(listed))));
                        if (target) subscribed.countDown();
                        closed.await();
                    } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                    catch (org.json.JSONException error) { throw new java.io.IOException(error); }
                }
                @Override public JSONObject json(String path, String token, JSONObject payload) { throw new AssertionError("Home must not load transcripts"); }
                @Override public void cancel() { /* The fixture releases the list stream below. */ }
            });
            field("foreground", true); invoke("refreshHomeConversations");
        });
        try {
            assertTrue("An old Home endpoint must subscribe to the Sessions data", subscribed.await(5, TimeUnit.SECONDS));
            awaitRecentUnread(hp, "old-server", true);
            main(() -> assertNewReply(hp, "old-server"));
            listed.put("replyReadAt", now);
            listListener[0].onSnapshot(new JSONObject().put("conversationList", new JSONObject().put("conversations", new JSONArray().put(listed))));
            awaitRecentUnread(hp, "old-server", false);
            main(() -> assertNull(view(tag("homeRecentStatus:", hp, "old-server"))));
            listed.put("lastReplyAt", now + 1);
            listListener[0].onSnapshot(new JSONObject().put("conversationList", new JSONObject().put("conversations", new JSONArray().put(listed))));
            awaitRecentUnread(hp, "old-server", true);
            main(() -> assertNewReply(hp, "old-server"));
        } finally { main(() -> invoke("settingsScreen")); closed.countDown(); }
    }

    private void awaitRecentUnread(JSONObject computer, String id, boolean expected) {
        for (int attempt = 0; attempt < 120; attempt++) {
            boolean[] shown = { false };
            main(() -> shown[0] = view(tag("homeRecentStatus:", computer, id)) != null);
            if (shown[0] == expected) return;
            android.os.SystemClock.sleep(25);
        }
        fail("Recent unread state did not become " + expected + " for " + id);
    }

    public void testSlowHostKeepsItsCacheWhileFastHostUpdatesWithoutChangingSelection() throws Exception {
        long now = System.currentTimeMillis();
        JSONObject slow = row("slow", "Slow server task", "running", now - 1000), fast = row("fast", "Fast server task", "running", now);
        seed(hp, slow); seed(other, fast); home();
        CountDownLatch slowOpened = new CountDownLatch(1), fastOpened = new CountDownLatch(1);
        CountDownLatch slowClosed = new CountDownLatch(1), fastClosed = new CountDownLatch(1);
        RemoteApi.SnapshotListener[] fastListener = new RemoteApi.SnapshotListener[1];
        main(() -> {
            field("homeClientFactory", (Function<String, RemoteApi>) address -> new RemoteApi(address) {
                @Override void workbenchEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws java.io.IOException {
                    boolean isSlow = address.equals(hp.optString("address"));
                    try {
                        if (isSlow) slowOpened.countDown();
                        else {
                            fastListener[0] = listener;
                            listener.onSnapshot(new JSONObject().put("workbench", new JSONObject().put("conversations", new JSONArray().put(fast))));
                            fastOpened.countDown();
                        }
                        (isSlow ? slowClosed : fastClosed).await();
                    } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                    catch (Exception error) { throw new java.io.IOException(error); }
                }
                @Override public JSONObject json(String path, String token, JSONObject payload) { throw new AssertionError("Home must not fetch transcripts or full lists"); }
                @Override public void cancel() { (address.equals(hp.optString("address")) ? slowClosed : fastClosed).countDown(); }
            });
            field("foreground", true); invoke("refreshHomeConversations");
        });
        assertTrue(slowOpened.await(3, TimeUnit.SECONDS)); assertTrue(fastOpened.await(3, TimeUnit.SECONDS));
        getInstrumentation().waitForIdleSync();
        main(() -> {
            TextView slowStatus = view(tag("homeActiveStatus:", hp, "slow")) instanceof TextView ? (TextView) view(tag("homeActiveStatus:", hp, "slow")) : null;
            assertNotNull(slowStatus); assertTrue(slowStatus.getText().toString().equals("正在确认状态…")
                || slowStatus.getText().toString().equals("Checking status…"));
            String fastStatus = ((TextView) view(tag("homeActiveStatus:", other, "fast"))).getText().toString();
            assertTrue(fastStatus.equals("运行中") || fastStatus.equals("Running"));
            assertEquals(hp.optString("address"), store.load().optString("address"));
        });
        capture("fast-live-slow-cached");
        fastListener[0].onSnapshot(new JSONObject().put("workbench", new JSONObject().put("conversations", new JSONArray().put(new JSONObject(fast.toString()).put("activity", "idle")))));
        getInstrumentation().waitForIdleSync();
        main(() -> {
            assertNull(view(tag("homeActive:", other, "fast"))); assertNotNull(view(tag("homeRecent:", other, "fast")));
            assertNotNull(view(tag("homeActive:", hp, "slow")));
            assertEquals(hp.optString("address"), ((JSONObject) field("credentials")).optString("address"));
            invoke("settingsScreen");
        });
        assertTrue(slowClosed.await(3, TimeUnit.SECONDS)); assertTrue(fastClosed.await(3, TimeUnit.SECONDS));
    }

    public void testUnsyncedServerIsVisibleAndRevocationRemovesItsCachedTitles() throws Exception {
        seed(hp, row("secret", "Cached private task", "running", System.currentTimeMillis())); home();
        main(() -> {
            assertNotNull(view("homeUnavailable:" + other.optString("address")));
            field("homeClientFactory", (Function<String, RemoteApi>) address -> new RemoteApi(address) {
                @Override void workbenchEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws java.io.IOException { throw new Failure(403); }
            });
            field("foreground", true); invoke("refreshHomeConversations");
        });
        for (int attempt = 0; attempt < 80 && cache.get(hp) != null; attempt++) android.os.SystemClock.sleep(25);
        getInstrumentation().waitForIdleSync();
        main(() -> {
            assertNull(cache.get(hp)); assertNull(view(tag("homeActive:", hp, "secret")));
            assertNotNull(view("homeUnavailable:" + hp.optString("address")));
        });
    }

    public void testFastSlowAndOfflineServersUpdateIndependently() throws Exception {
        JSONObject offline = computer("http://100.80.1.4:43127", "Offline server");
        store.save(offline);
        long now = System.currentTimeMillis();
        seed(hp, row("slow", "Slow server task", "running", now - 2000));
        seed(other, row("fast", "Fast server task", "running", now));
        seed(offline, row("offline", "Offline cached task", "running", now - 3000));
        home();
        CountDownLatch fastOpened = new CountDownLatch(1), slowOpened = new CountDownLatch(1);
        CountDownLatch fastClosed = new CountDownLatch(1), slowClosed = new CountDownLatch(1);
        main(() -> {
            field("homeClientFactory", (Function<String, RemoteApi>) address -> new RemoteApi(address) {
                @Override void workbenchEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws java.io.IOException {
                    if (address.equals(other.optString("address"))) {
                        try {
                            listener.onSnapshot(new JSONObject().put("workbench", new JSONObject()
                                .put("conversations", new JSONArray().put(row("fast", "Fast server task", "running", now)))));
                            fastOpened.countDown();
                            fastClosed.await();
                        } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                        catch (Exception error) { throw new java.io.IOException(error); }
                    } else if (address.equals(hp.optString("address"))) {
                        slowOpened.countDown();
                        try { slowClosed.await(); }
                        catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                    } else throw new java.io.IOException("Offline server");
                }
                @Override public void cancel() {
                    if (address.equals(other.optString("address"))) fastClosed.countDown();
                    else if (address.equals(hp.optString("address"))) slowClosed.countDown();
                }
            });
            field("foreground", true);
            invoke("refreshHomeConversations");
        });
        // The slow stream stays behind its barrier throughout these checks.
        // Bound startup generously on busy emulators; independence is proved
        // by receiving the fast snapshot before either stream is released.
        assertTrue("Fast host must publish while the slow host remains blocked", fastOpened.await(10, TimeUnit.SECONDS));
        assertTrue("Slow host must start its independent stream", slowOpened.await(10, TimeUnit.SECONDS));
        String offlineStatus = awaitStatus(tag("homeActiveStatus:", offline, "offline"));
        getInstrumentation().waitForIdleSync();
        main(() -> {
            assertTrue(((TextView) view(tag("homeActiveStatus:", other, "fast"))).getText().toString()
                .matches("运行中|Running"));
            assertTrue(((TextView) view(tag("homeActiveStatus:", hp, "slow"))).getText().toString()
                .matches("正在确认状态…|Checking status…"));
            assertTrue(offlineStatus.matches("离线 · 上次运行中|Offline · Previously running"));
            assertNotNull(view(tag("homeActive:", other, "fast")));
            assertNotNull(view(tag("homeActive:", hp, "slow")));
            assertNotNull(view(tag("homeActive:", offline, "offline")));
            invoke("settingsScreen");
        });
        assertTrue(fastClosed.await(3, TimeUnit.SECONDS));
        assertTrue(slowClosed.await(3, TimeUnit.SECONDS));
        cache.remove(offline); RemoteListCache.get(getInstrumentation().getTargetContext()).remove(offline);
        store.remove(offline.optString("address"));
    }

    private String awaitStatus(String tag) {
        for (int attempt = 0; attempt < 80; attempt++) {
            getInstrumentation().waitForIdleSync();
            View value = view(tag);
            if (value instanceof TextView && !((TextView) value).getText().toString().isEmpty())
                return ((TextView) value).getText().toString();
            android.os.SystemClock.sleep(25);
        }
        fail("Timed out waiting for " + tag);
        return "";
    }

    private boolean uncertainActivity(String status) {
        return status.matches("正在确认状态…|Checking status…|上次运行中|Previously running"
            + "|离线 · 上次运行中|Offline · Previously running|状态待确认|Status unconfirmed");
    }

    public void testWorkbenchAndComputerChecksUseTheEmbeddedNetworkClientFactory() throws Exception {
        main(() -> {
            for (String name : new String[] { "homeClientFactory", "statusClientFactory" }) {
                @SuppressWarnings("unchecked")
                Function<String, RemoteApi> factory = (Function<String, RemoteApi>) field(name);
                assertTrue(name + " must create an embedded-network-capable client",
                    factory.apply(hp.optString("address")).embeddedCapable());
            }
        });
    }

    private final java.util.List<String> actionReads = new java.util.concurrent.CopyOnWriteArrayList<>();
    private final java.util.List<JSONObject> actionWrites = new java.util.concurrent.CopyOnWriteArrayList<>();
    private CountDownLatch menuReadGate;
    private JSONObject actionInfo, actionConversation;
    private boolean actionOutsideFirstPage;

    private void actionFixture(String state, boolean pinned) throws Exception {
        String id = "12345678-1234-1234-1234-123456789abc";
        long now = System.currentTimeMillis();
        seed(hp, row(id, "Same ID on HP", "idle", now - 1));
        seed(other, row(id, "Server task", state, now));
        actionConversation = row(id, "Current server title", state, now).put("seq", 42).put("pinned", pinned);
        actionInfo = new JSONObject().put("protocol", 1).put("permission", "control").put("instanceId", "other-instance")
            .put("includeUnassigned", true).put("capabilities", new JSONArray(java.util.List.of(
                "conversation-actions", "archive", "create", "fork", "command-receipts")));
        Function<String, RemoteApi> clients = address -> new RemoteApi(address) {
            private final CountDownLatch closed = new CountDownLatch(1);
            @Override public JSONObject json(String path, String token, JSONObject payload) throws java.io.IOException {
                try {
                    assertEquals("Actions must use the source computer", other.optString("address"), address);
                    assertEquals(other.optString("token"), token);
                    if (payload != null) {
                        actionWrites.add(new JSONObject(payload.toString()).put("testPath", path));
                        return new JSONObject().put("state", "done").put("ok", true);
                    }
                    actionReads.add(path);
                    if (path.equals("/v1/status")) {
                        if (menuReadGate != null) menuReadGate.await(5, TimeUnit.SECONDS);
                        return new JSONObject(actionInfo.toString());
                    }
                    if (path.equals("/v1/conversations/" + id + "?before=1"))
                        return new JSONObject().put("conversation", new JSONObject(actionConversation.toString()));
                    if (path.equals("/v1/conversations?offset=0")) return actionPage(0);
                    if (actionOutsideFirstPage && path.equals("/v1/conversations?offset=100")) return actionPage(100);
                    throw new AssertionError("Unexpected Home action request: " + path);
                } catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new java.io.IOException(error); }
                catch (org.json.JSONException error) { throw new java.io.IOException(error); }
            }
            @Override public void listEvents(String token, SnapshotListener listener) throws java.io.IOException {
                listEvents(token, listener, null);
            }
            @Override public void listEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws java.io.IOException {
                try {
                    if (actionOutsideFirstPage) listener.onSnapshot(new JSONObject().put("conversationList", actionPage(0)));
                } catch (org.json.JSONException error) { throw new java.io.IOException(error); }
                try { closed.await(); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            }
            @Override public void cancel() { closed.countDown(); }
        };
        main(() -> { field("homeClientFactory", clients); field("remoteClientFactory", clients); });
        home();
        main(() -> field("foreground", true));
        getInstrumentation().waitForIdleSync();
    }

    private JSONObject actionPage(int offset) throws org.json.JSONException {
        JSONArray rows = new JSONArray();
        if (actionOutsideFirstPage) {
            for (int index = offset; index < offset + 100; index++) rows.put(new JSONObject().put("id", "off-page-" + index)
                .put("title", "Other conversation " + index).put("seq", 1));
        } else rows.put(actionConversation);
        return new JSONObject(actionInfo.toString()).put("conversations", rows).put("nextOffset", actionOutsideFirstPage ? offset + 100 : JSONObject.NULL);
    }

    private ConversationMenu actionMenu() throws Exception { return (ConversationMenu) field("conversationPopup"); }
    @android.annotation.TargetApi(29)
    private View dialogView(Object tag) {
        for (View window : android.view.inspector.WindowInspector.getGlobalWindowViews()) {
            View found = tag instanceof Integer ? window.findViewById((Integer) tag) : window.findViewWithTag(tag);
            if (found != null && found.isShown()) return found;
        }
        throw new AssertionError("Missing dialog view: " + tag);
    }
    private View actionRow(String state) {
        return view(tag(state.equals("running") ? "homeActive:" : "homeRecent:", other, actionConversation.optString("id")));
    }
    private void openActionMenu(String state) throws Exception {
        main(() -> assertTrue(actionRow(state).performLongClick()));
        awaitAction(() -> actionMenu() != null && actionMenu().isShowing());
    }
    private void awaitAction(java.util.concurrent.Callable<Boolean> condition) {
        for (int attempt = 0; attempt < 200; attempt++) {
            boolean[] done = {false};
            main(() -> done[0] = condition.call());
            if (done[0]) { getInstrumentation().waitForIdleSync(); return; }
            android.os.SystemClock.sleep(25);
        }
        fail("Home conversation action did not settle");
    }

    public void testHomeRunningLongPressOpensSharedMenuWithFreshPinStateWithoutOpeningChat() throws Exception {
        actionFixture("running", true);
        openActionMenu("running");
        main(() -> {
            assertEquals("home", field("screen")); assertNull(field("conversationId"));
            assertEquals(hp.optString("address"), store.load().optString("address"));
            for (String icon : new String[]{"edit", "select", "pin", "branch", "archive", "delete"})
                assertNotNull(actionMenu().panel.findViewWithTag("conversationAction:" + icon));
            String label = ((TextView) actionMenu().panel.findViewWithTag("conversationAction:pin")).getText().toString();
            assertTrue("Pin label must use the server's current state", label.equals("取消置顶") || label.equals("Unpin"));
            assertNotNull(actionMenu().panel.findViewWithTag("glassBackdrop"));
            assertTrue(actionWrites.isEmpty());
            assertEquals(java.util.List.of("/v1/status", "/v1/conversations/" + actionConversation.optString("id") + "?before=1"), actionReads);
        });
        android.graphics.Bitmap shot = getInstrumentation().getUiAutomation().takeScreenshot();
        if (shot != null) {
            try (var out = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), "home-conversation-menu.png"))) {
                shot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out);
            } finally { shot.recycle(); }
        }
        main(() -> { actionMenu().dismiss(); assertEquals("home", field("screen")); });
    }

    public void testHomeRecentMenuSelectsOnlyItsSourceComputer() throws Exception {
        actionFixture("idle", false); openActionMenu("idle");
        main(() -> actionMenu().panel.findViewWithTag("conversationAction:select").performClick());
        awaitAction(() -> (Boolean) field("listLoaded"));
        main(() -> {
            assertEquals("list", field("screen")); assertNull(field("conversationId"));
            assertEquals(other.optString("address"), ((JSONObject) field("credentials")).optString("address"));
            assertEquals(java.util.Set.of(actionConversation.optString("id")), field("selectedConversations"));
            assertTrue((Boolean) field("selectingConversations")); assertTrue(actionWrites.isEmpty());
        });
    }

    public void testHomeSelectionRetainsConversationOutsideFirstListPage() throws Exception {
        actionFixture("idle", false); actionOutsideFirstPage = true; openActionMenu("idle");
        main(() -> actionMenu().panel.findViewWithTag("conversationAction:select").performClick());
        awaitAction(() -> (Integer) field("nextOffset") == 200 && !(Boolean) field("listRefreshBusy"));
        main(() -> {
            assertEquals(java.util.Set.of(actionConversation.optString("id")), field("selectedConversations"));
            assertNotNull(view("conversation:" + actionConversation.optString("id")));
            assertTrue(actionWrites.isEmpty());
        });
    }

    public void testHomePinCommandUsesFreshSequenceAndSourceServerInstance() throws Exception {
        actionFixture("running", true); openActionMenu("running");
        main(() -> actionMenu().panel.findViewWithTag("conversationAction:pin").performClick());
        awaitAction(() -> !actionWrites.isEmpty());
        JSONObject payload = actionWrites.get(0);
        assertEquals("pin", payload.getString("action")); assertFalse(payload.getBoolean("pinned"));
        assertEquals("other-instance", payload.getString("instanceId"));
        assertEquals("/v1/commands", payload.getString("testPath"));
        assertEquals(42, payload.getJSONArray("targets").getJSONObject(0).getInt("seq"));
        assertEquals(actionConversation.getString("id"), payload.getJSONArray("targets").getJSONObject(0).getString("id"));
        assertEquals(1, actionWrites.size());
    }

    public void testHomeRenameUsesExistingDialogAndRoutesSavedTitleToSource() throws Exception {
        actionFixture("idle", false); openActionMenu("idle");
        main(() -> actionMenu().panel.findViewWithTag("conversationAction:edit").performClick());
        main(() -> {
            android.widget.EditText input = (android.widget.EditText) dialogView("remoteRename");
            assertEquals("Current server title", input.getText().toString()); input.setText("Renamed from Home");
            dialogView(android.R.id.button1).performClick();
        });
        awaitAction(() -> !actionWrites.isEmpty());
        assertEquals("rename", actionWrites.get(0).getString("action"));
        assertEquals("Renamed from Home", actionWrites.get(0).getString("title"));
    }

    public void testHomeDeleteStillRequiresConfirmation() throws Exception {
        actionFixture("idle", false); openActionMenu("idle");
        main(() -> actionMenu().panel.findViewWithTag("conversationAction:delete").performClick());
        main(() -> {
            assertTrue(actionWrites.isEmpty());
            dialogView(android.R.id.button2).performClick();
            assertTrue(actionWrites.isEmpty());
        });
    }

    public void testHomeForkUsesExistingTargetedCommand() throws Exception {
        actionFixture("idle", false); openActionMenu("idle");
        main(() -> actionMenu().panel.findViewWithTag("conversationAction:branch").performClick());
        awaitAction(() -> !actionWrites.isEmpty());
        JSONObject payload = actionWrites.get(0);
        assertEquals("fork", payload.getString("action")); assertEquals(42, payload.getInt("expectedSeq"));
        assertEquals("other-instance", payload.getString("instanceId"));
        assertEquals("/v1/conversations/" + actionConversation.getString("id") + "/commands", payload.getString("testPath"));
    }

    public void testHomeArchiveUsesFreshSequence() throws Exception {
        actionFixture("idle", false); openActionMenu("idle");
        main(() -> actionMenu().panel.findViewWithTag("conversationAction:archive").performClick());
        awaitAction(() -> !actionWrites.isEmpty());
        JSONObject payload = actionWrites.get(0);
        assertEquals("archive", payload.getString("action")); assertEquals(42, payload.getInt("expectedSeq"));
        assertEquals(actionConversation.getString("id"), payload.getString("conversationId"));
    }

    public void testHomeTouchLongPressDoesNotAlsoOpenConversation() throws Exception {
        actionFixture("running", false);
        awaitAction(() -> {
            View row = actionRow("running");
            return row != null && row.isLaidOut() && row.isShown() && row.hasWindowFocus();
        });
        RenderedFrameFixture.awaitFrames(getInstrumentation(), activity.getWindow().getDecorView());
        int[] at = new int[2];
        main(() -> {
            View row = actionRow("running");
            android.graphics.Rect visible = new android.graphics.Rect();
            assertTrue("The long-press row must be visible", row.getLocalVisibleRect(visible));
            row.getLocationOnScreen(at); at[0] += visible.centerX(); at[1] += visible.centerY();
        });
        long down = android.os.SystemClock.uptimeMillis();
        touch(down, android.view.MotionEvent.ACTION_DOWN, at[0], at[1]);
        try { awaitAction(() -> actionMenu() != null && actionMenu().isShowing()); }
        finally { touch(down, android.view.MotionEvent.ACTION_UP, at[0], at[1]); }
        awaitAction(() -> actionMenu() != null && actionMenu().isShowing());
        main(() -> { assertEquals("home", field("screen")); assertNull(field("conversationId")); assertTrue(actionWrites.isEmpty()); });
    }

    public void testHomeScrollingCancelsPendingLongPress() throws Exception {
        actionFixture("running", false);
        JSONArray values = new JSONArray().put(actionConversation);
        for (int index = 0; index < 25; index++) values.put(row("scroll-fixture-" + index, "Running scroll fixture " + index, "running", 1));
        cache.put(other, values, -1, new JSONArray(), false);
        main(() -> { field("homeRunningExpanded", true); invoke("updateHomeConversations"); });
        getInstrumentation().waitForIdleSync();
        int[] at = new int[2];
        main(() -> {
            View row = actionRow("running"); row.getLocationOnScreen(at); at[0] += row.getWidth() / 2; at[1] += row.getHeight() / 2;
            View parent = (View) row.getParent();
            while (!(parent instanceof android.widget.ScrollView)) parent = (View) parent.getParent();
            assertTrue("The gesture fixture must have scrollable content", parent.canScrollVertically(1));
        });
        long down = android.os.SystemClock.uptimeMillis();
        touch(down, android.view.MotionEvent.ACTION_DOWN, at[0], at[1]);
        touch(down, android.view.MotionEvent.ACTION_MOVE, at[0], at[1] - 120);
        android.os.SystemClock.sleep(android.view.ViewConfiguration.getLongPressTimeout() + 100);
        touch(down, android.view.MotionEvent.ACTION_UP, at[0], at[1] - 120);
        main(() -> { assertNull(actionMenu()); assertTrue(actionReads.isEmpty()); assertEquals("home", field("screen")); });
    }

    private void touch(long down, int action, int x, int y) {
        android.view.MotionEvent event = android.view.MotionEvent.obtain(down, android.os.SystemClock.uptimeMillis(), action, x, y, 0);
        event.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        try { InputDeliveryFixture.deliver(getInstrumentation(), event); } finally { event.recycle(); }
    }

    public void testHomeMenuReadIsDiscardedAfterLeavingPage() throws Exception {
        menuReadGate = new CountDownLatch(1); actionFixture("running", false);
        main(() -> assertTrue(actionRow("running").performLongClick()));
        awaitAction(() -> !actionReads.isEmpty());
        main(() -> invoke("computersScreen")); menuReadGate.countDown();
        getInstrumentation().waitForIdleSync(); android.os.SystemClock.sleep(150);
        main(() -> { assertEquals("computers", field("screen")); assertNull(actionMenu()); assertTrue(actionWrites.isEmpty()); });
    }

    public void testHomeMenuReadCannotUseReplacedPairing() throws Exception {
        menuReadGate = new CountDownLatch(1); actionFixture("running", false);
        main(() -> assertTrue(actionRow("running").performLongClick()));
        awaitAction(() -> !actionReads.isEmpty());
        store.save(new JSONObject(other.toString()).put("token", "b".repeat(43))); store.save(hp);
        menuReadGate.countDown(); awaitAction(() -> field("homeMenuClient") == null);
        main(() -> { assertNull(actionMenu()); assertEquals(hp.optString("address"), store.load().optString("address")); assertTrue(actionWrites.isEmpty()); });
    }

    public void testHomeMenuDoesNotReuseSelectedComputersControlPermission() throws Exception {
        actionFixture("running", false); actionInfo.put("permission", "read");
        main(() -> { field("canManageConversations", true); assertTrue(actionRow("running").performLongClick()); });
        awaitAction(() -> field("homeMenuClient") == null);
        main(() -> {
            assertNull(actionMenu()); assertEquals("home", field("screen")); assertTrue(actionWrites.isEmpty());
            assertEquals(java.util.List.of("/v1/status"), actionReads);
        });
    }
}
