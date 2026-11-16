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
    private JSONObject hp, other;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        new CredentialStore(context).clear();
        store = new ComputerStore(new CredentialStore(context)); cache = RemoteListCache.workbench(context);
        hp = computer("http://100.80.1.2:43127", "HP"); other = computer("http://100.80.1.3:43127", "Research server");
        for (JSONObject computer : List.of(hp, other)) { cache.remove(computer); RemoteListCache.get(context).remove(computer); }
        // Starting with no pairings prevents real network work in this fixture.
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        store.save(other); store.save(hp);
    }
    @Override protected void tearDown() throws Exception {
        if (activity != null) getInstrumentation().runOnMainSync(activity::finish);
        getInstrumentation().waitForIdleSync();
        for (JSONObject computer : List.of(hp, other)) { cache.remove(computer); RemoteListCache.get(getInstrumentation().getTargetContext()).remove(computer); }
        new CredentialStore(getInstrumentation().getTargetContext()).clear();
        super.tearDown();
    }
    private JSONObject computer(String address, String name) throws Exception {
        return new JSONObject().put("address", address).put("computerName", name).put("token", "a".repeat(43));
    }
    private JSONObject row(String id, String title, String state, long at) throws Exception {
        return new JSONObject().put("id", id).put("title", title).put("activity", state).put("engine", "codex")
            .put("modelName", "GPT-6.1-Sol").put("updatedAt", at);
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
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Exception error) { throw new AssertionError(error); } });
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
