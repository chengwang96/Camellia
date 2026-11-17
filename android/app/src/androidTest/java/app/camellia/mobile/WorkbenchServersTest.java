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
            assertFalse(view(tag("homeRecent:", other, "same-id")).getContentDescription().toString().matches(".*(新消息|New reply).*"));
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
        assertTrue(status.getText().toString().matches("新消息|New reply"));
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
                @Override void listEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws java.io.IOException {
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
            assertTrue(fastStatus.equals("正在运行") || fastStatus.equals("Running"));
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
                .matches("正在运行|Running"));
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
}
