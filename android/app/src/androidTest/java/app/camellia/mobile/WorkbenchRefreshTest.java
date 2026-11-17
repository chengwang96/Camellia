package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.function.Function;

public class WorkbenchRefreshTest extends InstrumentationTestCase {
    private Activity activity;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context);
        EmbeddedNetwork.setEnabled(false);
        new CredentialStore(context).clear();
        activity = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    @Override protected void tearDown() throws Exception {
        if (activity != null) getInstrumentation().runOnMainSync(activity::finish);
        getInstrumentation().waitForIdleSync();
        new CredentialStore(getInstrumentation().getTargetContext()).clear();
        super.tearDown();
    }

    public void testWorkbenchHasFourDestinationNavigation() throws Exception {
        getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            View root = activity.getWindow().getDecorView();
            assertNotNull(root.findViewWithTag("workbenchNav"));
            assertNotNull(root.findViewWithTag("nav:home"));
            assertNotNull(root.findViewWithTag("nav:sessions"));
            assertNotNull(root.findViewWithTag("nav:computers"));
            assertNotNull(root.findViewWithTag("nav:settings"));
            assertNotNull(root.findViewWithTag("localChatEntry"));
            assertNull("Computer management belongs in the Computers destination",
                root.findViewWithTag("remoteControlEntry"));
            assertNull(root.findViewWithTag("remoteEntryLoading"));
            assertNull(root.findViewWithTag("remoteEntryRetry"));
            assertNull(root.findViewWithTag("remoteEntryOpen"));
            assertNotNull(root.findViewWithTag("settingsEntry"));
            assertNull("Shortcut rows open from the whole row; a duplicate text button is noise",
                root.findViewWithTag("localChatEntryGo"));
            assertNull(root.findViewWithTag("remoteControlEntryGo"));
            assertNull(root.findViewWithTag("settingsEntryGo"));
            assertNotNull(root.findViewWithTag("localChatEntryArrow"));
            assertNull(root.findViewWithTag("remoteControlEntryArrow"));
            assertNotNull(root.findViewWithTag("settingsEntryArrow"));
            assertNull("The redundant home connection bar must stay removed", root.findViewWithTag("homeConnectionContext"));
            assertNull("The Workbench no longer repeats a recent count above the Recent section",
                root.findViewWithTag("homeSummary"));
            View shortcuts = root.findViewWithTag("homeShortcuts");
            assertNotNull(shortcuts);
            assertTrue(shortcuts instanceof android.view.ViewGroup);
            android.view.ViewGroup group = (android.view.ViewGroup) shortcuts;
            assertTrue(group.indexOfChild(root.findViewWithTag("localChatEntry"))
                < group.indexOfChild(root.findViewWithTag("settingsEntry")));
            assertEquals("Only Local chat, one divider and Settings belong in the shortcut group",
                3, group.getChildCount());
        });
        getInstrumentation().waitForIdleSync();
        android.os.SystemClock.sleep(350);
        java.io.File directory = new java.io.File(activity.getExternalFilesDir(null), "workbench-visuals");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
        try (var output = new java.io.FileOutputStream(new java.io.File(directory, "home-shortcuts-no-open.png"))) {
            assertTrue(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output));
        } finally {
            screenshot.recycle();
        }
    }

    public void testTopLevelSessionsAndComputersHaveNoBackButtons() {
        getInstrumentation().waitForIdleSync();
        getInstrumentation().runOnMainSync(() -> {
            try {
                View root = activity.getWindow().getDecorView();
                root.findViewWithTag("nav:sessions").performClick();
                assertEquals("list", field("screen"));
                assertNull("Sessions is a top-level destination, not a child of Computers",
                    root.findViewWithTag("pageBack"));
                assertNotNull("Unpaired Sessions must stay on its own page",
                    root.findViewWithTag("sessionsEmptyManageComputers"));
                activity.onBackPressed();
                assertEquals("home", field("screen"));

                root.findViewWithTag("nav:computers").performClick();
                assertEquals("computers", field("screen"));
                assertNull("Computers is a top-level destination",
                    root.findViewWithTag("settingsBack"));
                assertNotNull(root.findViewWithTag("remoteControlTitle"));
            } catch (Exception error) {
                throw new AssertionError(error);
            }
        });
    }

    public void testHomeSplitsRunningWorkFromRecentWithoutDuplicatingTheFirstCard() throws Exception {
        var context = getInstrumentation().getTargetContext();
        JSONObject credentials = new JSONObject().put("address", "http://100.80.1.2:43127")
            .put("token", "a".repeat(43)).put("computerName", "Home sections");
        JSONArray rows = new JSONArray()
            .put(new JSONObject().put("id", "home-running").put("title", "Running job")
                .put("engine", "codex").put("activity", "running").put("updatedAt", System.currentTimeMillis()))
            .put(new JSONObject().put("id", "home-waiting").put("title", "Waiting job")
                .put("engine", "claude").put("activity", "permission").put("updatedAt", System.currentTimeMillis()))
            .put(new JSONObject().put("id", "home-idle").put("title", "Idle job")
                .put("engine", "dsh").put("activity", "idle").put("updatedAt", System.currentTimeMillis()));
        RemoteListCache cache = RemoteListCache.get(context);
        cache.put(credentials, rows, -1, new JSONArray(), true);
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    field("credentials", credentials);
                    field("foreground", false);
                    invoke("homeScreen");
                    View root = activity.getWindow().getDecorView();
                    assertNull("There is no separate continue card to duplicate the first row",
                        root.findViewWithTag("homeContinue"));
                    assertNull(root.findViewWithTag("homeSummary"));
                    assertNotNull(root.findViewWithTag("homeRunningSection"));
                    assertNotNull(root.findViewWithTag("homeActive:http://100.80.1.2:43127#home-running"));
                    assertNotNull(root.findViewWithTag("homeActive:http://100.80.1.2:43127#home-waiting"));
                    assertNull(root.findViewWithTag("homeRecent:http://100.80.1.2:43127#home-running"));
                    assertNull(root.findViewWithTag("homeRecent:http://100.80.1.2:43127#home-waiting"));
                    assertNotNull(root.findViewWithTag("homeRecentSection"));
                    assertNotNull(root.findViewWithTag("homeRecent:http://100.80.1.2:43127#home-idle"));
                } catch (Exception error) {
                    throw new AssertionError(error);
                }
            });
            getInstrumentation().waitForIdleSync();
            android.os.SystemClock.sleep(350);
            java.io.File directory = new java.io.File(activity.getExternalFilesDir(null), "workbench-visuals");
            assertTrue(directory.isDirectory() || directory.mkdirs());
            android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
            try (var output = new java.io.FileOutputStream(new java.io.File(directory, "home-running-recent.png"))) {
                assertTrue(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output));
            } finally {
                screenshot.recycle();
            }
        } finally {
            cache.remove(credentials); RemoteListCache.workbench(context).remove(credentials);
            new CredentialStore(context).clear();
        }
    }

    public void testSessionRowCarriesEngineBadgeAndStatusPill() throws Exception {
        getInstrumentation().runOnMainSync(() -> {
            ConversationRow row = new ConversationRow(activity, new ChatStyle(activity), false, "codex",
                "Layout review", "Codex · 研究电脑 · report.pdf", "运行中", activity.getColor(android.R.color.black), "12m",
                "test:row", "test:status", () -> {}, () -> {});
            assertEquals("Conversation icons should hug the card edge",
                Math.round(14 * activity.getResources().getDisplayMetrics().density), row.getPaddingLeft());
            assertNotNull(row.findViewWithTag("agentBadge"));
            assertNotNull(row.findViewWithTag("conversationRowMeta"));
            assertNotNull(row.findViewWithTag("conversationRowTime"));
            TextView status = row.findViewWithTag("test:status");
            assertNotNull(status);
            assertEquals("运行中", status.getText().toString());
            assertNotNull(status.getBackground());
        });
    }

    public void testMoreThanThreeRunningSessionsExpandAndRecentNeverRepeatsThem() throws Exception {
        var context = getInstrumentation().getTargetContext();
        JSONObject credentials = new JSONObject().put("address", "http://100.80.1.3:43127")
            .put("token", "b".repeat(43)).put("computerName", "Running overflow");
        JSONArray rows = new JSONArray();
        for (int index = 1; index <= 5; index++) {
            rows.put(new JSONObject().put("id", "running-" + index).put("title", "Running " + index)
                .put("engine", "codex").put("activity", index == 5 ? "permission" : "running")
                .put("updatedAt", System.currentTimeMillis() - index * 1000L));
        }
        rows.put(new JSONObject().put("id", "idle-1").put("title", "Idle one")
            .put("engine", "claude").put("activity", "idle").put("updatedAt", System.currentTimeMillis() - 10_000L));
        rows.put(new JSONObject().put("id", "idle-2").put("title", "Idle two")
            .put("engine", "dsh").put("activity", "idle").put("updatedAt", System.currentTimeMillis() - 20_000L));
        RemoteListCache cache = RemoteListCache.get(context);
        cache.put(credentials, rows, -1, new JSONArray(), true);
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    field("credentials", credentials);
                    field("foreground", false);
                    field("homeRunningExpanded", false);
                    invoke("homeScreen");
                    View root = activity.getWindow().getDecorView();
                    assertNotNull(root.findViewWithTag("homeRunningToggle"));
                    assertNotNull(root.findViewWithTag("homeActive:http://100.80.1.3:43127#running-1"));
                    assertNotNull(root.findViewWithTag("homeActive:http://100.80.1.3:43127#running-2"));
                    assertNotNull(root.findViewWithTag("homeActive:http://100.80.1.3:43127#running-3"));
                    assertNull("Only the first three running sessions show while collapsed",
                        root.findViewWithTag("homeActive:http://100.80.1.3:43127#running-4"));
                    assertNull(root.findViewWithTag("homeActive:http://100.80.1.3:43127#running-5"));
                    assertNotNull(root.findViewWithTag("homeRecent:http://100.80.1.3:43127#idle-1"));
                    assertNotNull(root.findViewWithTag("homeRecent:http://100.80.1.3:43127#idle-2"));
                    assertNull(root.findViewWithTag("homeRecent:http://100.80.1.3:43127#running-1"));
                    assertNull(root.findViewWithTag("homeRecent:http://100.80.1.3:43127#running-5"));
                } catch (Exception error) {
                    throw new AssertionError(error);
                }
            });
            getInstrumentation().waitForIdleSync();
            capture("home-running-collapsed");
            getInstrumentation().runOnMainSync(() ->
                activity.getWindow().getDecorView().findViewWithTag("homeRunningToggle").performClick());
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                View root = activity.getWindow().getDecorView();
                for (int index = 1; index <= 5; index++)
                    assertNotNull("Expanded running list must show row " + index,
                        root.findViewWithTag("homeActive:http://100.80.1.3:43127#running-" + index));
                assertNull("Running rows must never reappear under Recent",
                    root.findViewWithTag("homeRecent:http://100.80.1.3:43127#running-3"));
                assertNotNull(root.findViewWithTag("homeRecent:http://100.80.1.3:43127#idle-1"));
                String toggle = ((TextView) root.findViewWithTag("homeRunningToggle")).getText().toString();
                assertTrue(toggle.equals("收起") || toggle.equals("Collapse"));
            });
            capture("home-running-expanded");
            getInstrumentation().runOnMainSync(() -> {
                View root = activity.getWindow().getDecorView();
                root.findViewWithTag("homeRunningToggle").performClick();
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                View root = activity.getWindow().getDecorView();
                assertNotNull(root.findViewWithTag("homeActive:http://100.80.1.3:43127#running-3"));
                assertNull(root.findViewWithTag("homeActive:http://100.80.1.3:43127#running-4"));
                assertNotNull(root.findViewWithTag("homeRecent:http://100.80.1.3:43127#idle-2"));
            });
        } finally {
            cache.remove(credentials); RemoteListCache.workbench(context).remove(credentials);
            new CredentialStore(context).clear();
        }
    }

    private void capture(String name) throws Exception {
        getInstrumentation().waitForIdleSync();
        android.os.SystemClock.sleep(300);
        java.io.File directory = new java.io.File(activity.getExternalFilesDir(null), "workbench-visuals");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull(screenshot);
        try (var output = new java.io.FileOutputStream(new java.io.File(directory, name + ".png"))) {
            assertTrue(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output));
        } finally {
            screenshot.recycle();
        }
    }

    public void testBackFromHomeOpenedConversationReturnsHome() throws Exception {
        getInstrumentation().runOnMainSync(() -> {
            try {
                field("screen", "detail");
                field("conversationId", "home-origin");
                field("detailReturn", "home");
                activity.onBackPressed();
                assertEquals("home", field("screen"));
                assertNull(field("conversationId"));
            } catch (Exception error) {
                throw new AssertionError(error);
            }
        });
    }

    public void testHomeRefreshesAStaleRunningConversationFromCache() throws Exception {
        var context = getInstrumentation().getTargetContext();
        JSONObject credentials = new JSONObject().put("address", "http://100.80.1.2:43127")
            .put("token", "a".repeat(43)).put("computerName", "Refresh test");
        new CredentialStore(context).save(credentials);
        JSONArray stale = new JSONArray().put(new JSONObject().put("id", "stale")
            .put("title", "Finished task").put("activity", "running").put("updatedAt", System.currentTimeMillis()));
        RemoteListCache cache = RemoteListCache.get(context);
        cache.put(credentials, stale, -1, new JSONArray(), true);
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    field("credentials", credentials);
                    field("foreground", true);
                    field("screen", "home");
                    field("homeRefreshAt", 0L);
                    field("homeClientFactory", (Function<String, RemoteApi>) address -> new RemoteApi(address) {
                        final java.util.concurrent.CountDownLatch closed = new java.util.concurrent.CountDownLatch(1);
                        @Override void workbenchEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws java.io.IOException {
                            try { listener.onSnapshot(new JSONObject().put("workbench", json("/v1/workbench", token, null))); closed.await(); }
                            catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                            catch (Exception error) { throw new java.io.IOException(error); }
                        }
                        @Override public void cancel() { closed.countDown(); }
                        @Override public JSONObject json(String path, String token, JSONObject payload) {
                            try {
                                return new JSONObject().put("conversations", new JSONArray().put(new JSONObject()
                                    .put("id", "stale").put("title", "Finished task").put("activity", "idle")
                                    .put("updatedAt", System.currentTimeMillis()).put("lastReplyAt", 0).put("replyReadAt", 0))).put("nextOffset", JSONObject.NULL)
                                    .put("workspaces", new JSONArray()).put("includeUnassigned", true);
                            } catch (Exception error) {
                                throw new AssertionError(error);
                            }
                        }
                    });
                    invoke("refreshHomeConversations");
                } catch (Exception error) {
                    throw new AssertionError(error);
                }
            });
            JSONObject updated = null;
            for (int attempt = 0; attempt < 80; attempt++) {
                JSONObject saved = RemoteListCache.workbench(context).get(credentials);
                JSONArray rows = saved == null ? null : saved.optJSONArray("conversations");
                if (rows != null && rows.length() > 0 && rows.getJSONObject(0).optString("activity").equals("idle")) {
                    updated = rows.getJSONObject(0);
                    break;
                }
                android.os.SystemClock.sleep(50);
            }
            assertNotNull("Home should refresh its stale conversation cache", updated);
            assertEquals("idle", updated.optString("activity"));
        } finally {
            cache.remove(credentials); RemoteListCache.workbench(context).remove(credentials);
            new CredentialStore(context).clear();
        }
    }

    public void testHomeAppliesDesktopPushWithoutReopeningAndStopsOnExit() throws Exception {
        var context = getInstrumentation().getTargetContext();
        JSONObject credentials = new JSONObject().put("address", "http://100.80.1.2:43127")
            .put("token", "a".repeat(43)).put("computerName", "Live home test");
        java.util.concurrent.CountDownLatch opened = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch closed = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch readEntered = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch releaseRead = new java.util.concurrent.CountDownLatch(1);
        RemoteApi.SnapshotListener[] listener = new RemoteApi.SnapshotListener[1];
        RemoteWorkbenchSync sync = new RemoteWorkbenchSync(address -> new RemoteApi(address) {
            @Override void workbenchEvents(String token, SnapshotListener callback, SseReader.HeartbeatListener heartbeat) throws java.io.IOException {
                listener[0] = callback;
                opened.countDown();
                try { closed.await(); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            }
            @Override public void cancel() { closed.countDown(); }
        });
        RemoteListCache cache = RemoteListCache.get(context);
        JSONArray running = new JSONArray().put(new JSONObject().put("id", "live-home")
            .put("title", "Live task").put("engine", "codex").put("activity", "running")
            .put("updatedAt", System.currentTimeMillis()).put("lastReplyAt", 0).put("replyReadAt", 0));
        cache.put(credentials, running, -1, new JSONArray(), true);
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    ((RemoteWorkbenchSync) field("homeSync")).close();
                    field("homeSync", sync);
                    field("credentials", credentials);
                    field("homeRefreshAt", 0L);
                    field("homeClientFactory", (Function<String, RemoteApi>) address -> new RemoteApi(address) {
                        @Override public JSONObject json(String path, String token, JSONObject payload) throws java.io.IOException {
                            readEntered.countDown();
                            try { releaseRead.await(); return new JSONObject().put("conversations", running).put("nextOffset", JSONObject.NULL); }
                            catch (Exception error) { throw new java.io.IOException(error); }
                        }
                    });
                    field("foreground", false);
                    invoke("homeScreen");
                    assertNotNull(activity.getWindow().getDecorView().findViewWithTag("homeActive:http://100.80.1.2:43127#live-home"));
                    field("foreground", true);
                    invoke("refreshHomeConversations");
                    invoke("refreshHomeConversations");
                } catch (Exception error) { throw new AssertionError(error); }
            });
            assertTrue("Home should subscribe without an open conversation", opened.await(3, java.util.concurrent.TimeUnit.SECONDS));
            assertEquals("Summary streams do not fetch a redundant full list", 1L, readEntered.getCount());
            JSONArray idle = new JSONArray().put(new JSONObject(running.getJSONObject(0).toString()).put("activity", ""));
            listener[0].onSnapshot(new JSONObject().put("workbench", new JSONObject()
                .put("conversations", idle).put("nextOffset", JSONObject.NULL)
                .put("workspaces", new JSONArray()).put("includeUnassigned", true)));
            getInstrumentation().waitForIdleSync();
            releaseRead.countDown();
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                View root = activity.getWindow().getDecorView();
                assertNull("A desktop completion must remove the running row without navigation", root.findViewWithTag("homeActive:http://100.80.1.2:43127#live-home"));
                assertNotNull("The completed conversation must move to recent", root.findViewWithTag("homeRecent:http://100.80.1.2:43127#live-home"));
                try { invoke("settingsScreen"); }
                catch (Exception error) { throw new AssertionError(error); }
            });
            assertTrue("Leaving Home must close the subscription", closed.await(3, java.util.concurrent.TimeUnit.SECONDS));
            listener[0].onSnapshot(new JSONObject().put("workbench", new JSONObject().put("conversations", running)));
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try { assertEquals("settings", field("screen")); }
                catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { releaseRead.countDown(); sync.close(); cache.remove(credentials); RemoteListCache.workbench(context).remove(credentials); }
    }

    public void testHomeResubscribesAndRefreshesAfterReturningFromBackground() throws Exception {
        var context = getInstrumentation().getTargetContext();
        JSONObject credentials = new JSONObject().put("address", "http://100.80.1.2:43127")
            .put("token", "a".repeat(43)).put("computerName", "Home resume test");
        new CredentialStore(context).save(credentials);
        JSONArray running = new JSONArray().put(new JSONObject().put("id", "resumed-home")
            .put("title", "Background task").put("engine", "codex").put("activity", "running")
            .put("updatedAt", System.currentTimeMillis()).put("lastReplyAt", 0).put("replyReadAt", 0));
        JSONArray idle = new JSONArray().put(new JSONObject(running.getJSONObject(0).toString()).put("activity", ""));
        var latest = new java.util.concurrent.atomic.AtomicReference<>(running);
        var starts = new java.util.concurrent.atomic.AtomicInteger();
        var firstOpened = new java.util.concurrent.CountDownLatch(1);
        var firstClosed = new java.util.concurrent.CountDownLatch(1);
        var resumed = new java.util.concurrent.CountDownLatch(1);
        RemoteApi.SnapshotListener[] oldListener = new RemoteApi.SnapshotListener[1];
        RemoteWorkbenchSync sync = new RemoteWorkbenchSync(address -> new RemoteApi(address) {
            final java.util.concurrent.CountDownLatch closed = new java.util.concurrent.CountDownLatch(1);
            @Override void workbenchEvents(String token, SnapshotListener listener, SseReader.HeartbeatListener heartbeat) throws java.io.IOException {
                int start = starts.incrementAndGet();
                if (start == 1) oldListener[0] = listener;
                try {
                    listener.onSnapshot(new JSONObject().put("workbench", new JSONObject()
                        .put("conversations", latest.get()).put("nextOffset", JSONObject.NULL)));
                    if (start == 1) firstOpened.countDown(); else resumed.countDown();
                    closed.await();
                } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                catch (org.json.JSONException error) { throw new java.io.IOException(error); }
            }
            @Override public void cancel() { closed.countDown(); firstClosed.countDown(); }
        });
        RemoteListCache cache = RemoteListCache.get(context);
        cache.put(credentials, running, -1, new JSONArray(), true);
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    ((RemoteWorkbenchSync) field("homeSync")).close();
                    field("homeSync", sync);
                    field("credentials", credentials);
                    field("homeClientFactory", (Function<String, RemoteApi>) address -> new RemoteApi(address) {
                        @Override public JSONObject json(String path, String token, JSONObject payload) throws java.io.IOException {
                            try { return new JSONObject().put("conversations", latest.get()).put("nextOffset", JSONObject.NULL); }
                            catch (org.json.JSONException error) { throw new java.io.IOException(error); }
                        }
                    });
                    invoke("homeScreen");
                } catch (Exception error) { throw new AssertionError(error); }
            });
            assertTrue(firstOpened.await(3, java.util.concurrent.TimeUnit.SECONDS));
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                assertNotNull(activity.getWindow().getDecorView().findViewWithTag("homeActive:http://100.80.1.2:43127#resumed-home"));
                getInstrumentation().callActivityOnPause(activity);
                getInstrumentation().callActivityOnStop(activity);
            });
            assertTrue("Home must release its live stream while in the background",
                firstClosed.await(3, java.util.concurrent.TimeUnit.SECONDS));
            latest.set(idle);
            getInstrumentation().runOnMainSync(() -> {
                getInstrumentation().callActivityOnRestart(activity);
                getInstrumentation().callActivityOnStart(activity);
                getInstrumentation().callActivityOnResume(activity);
            });
            assertTrue("Returning to Home must open a new live subscription",
                resumed.await(3, java.util.concurrent.TimeUnit.SECONDS));
            getInstrumentation().waitForIdleSync();
            oldListener[0].onSnapshot(new JSONObject().put("workbench", new JSONObject().put("conversations", running)));
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                View root = activity.getWindow().getDecorView();
                assertNull("A run completed in the background must no longer be Running", root.findViewWithTag("homeActive:http://100.80.1.2:43127#resumed-home"));
                assertNotNull("The fresh snapshot must move the completed conversation to Recent", root.findViewWithTag("homeRecent:http://100.80.1.2:43127#resumed-home"));
            });
            assertEquals(2, starts.get());
        } finally { sync.close(); cache.remove(credentials); RemoteListCache.workbench(context).remove(credentials); }
    }

    public void testWideDetailBuildsTheConversationSidebar() throws Exception {
        var context = getInstrumentation().getTargetContext();
        if (!MobileLayout.useDetailSplit(activity.getResources().getConfiguration())) return;
        JSONObject credentials = new JSONObject().put("address", "http://100.80.1.2:43127")
            .put("token", "a".repeat(43)).put("computerName", "Sidebar test");
        new CredentialStore(context).save(credentials);
        JSONArray rows = new JSONArray().put(new JSONObject().put("id", "sidebar-row")
            .put("title", "Switch here").put("engine", "codex").put("activity", "idle")
            .put("updatedAt", System.currentTimeMillis()))
            .put(new JSONObject().put("id", "sidebar-running").put("title", "Background analysis")
                .put("engine", "claude").put("activity", "running").put("updatedAt", System.currentTimeMillis()))
            .put(new JSONObject().put("id", "sidebar-review").put("title", "Review the release notes")
                .put("engine", "dsh").put("activity", "permission").put("updatedAt", System.currentTimeMillis()));
        RemoteListCache cache = RemoteListCache.get(context);
        cache.put(credentials, rows, -1, new JSONArray(), true);
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    field("credentials", credentials);
                    field("foreground", false);
                    field("conversationId", "sidebar-row");
                    field("conversationTitle", "Switch here");
                    field("detailReturn", "list");
                    invoke("detailScreen");
                    View root = activity.getWindow().getDecorView();
                    assertNotNull("Wide landscape chat must keep its conversation list visible",
                        root.findViewWithTag("detailConversationSidebar"));
                    assertNotNull("The active conversation should be selected in the sidebar",
                        root.findViewWithTag("sidebarConversation:sidebar-row"));
                    assertNotNull(root.findViewWithTag("sidebarConversation:sidebar-running"));
                    assertNotNull(root.findViewWithTag("sidebarConversation:sidebar-review"));
                } catch (Exception error) {
                    throw new AssertionError(error);
                }
            });
            getInstrumentation().waitForIdleSync();
            android.os.SystemClock.sleep(900);
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                android.view.ViewGroup pages = (android.view.ViewGroup) activity.getWindow().getDecorView()
                    .findViewWithTag("pageTransitions");
                assertEquals("The wide detail transition should be settled before capture", 1, pages.getChildCount());
                assertEquals(0f, pages.getChildAt(0).getTranslationX());
                assertTrue("The sidebar must be a real, usable pane",
                    activity.getWindow().getDecorView().findViewWithTag("detailConversationSidebar").getWidth() > 0);
            });
            java.io.File directory = new java.io.File(activity.getExternalFilesDir(null), "workbench-visuals");
            assertTrue(directory.isDirectory() || directory.mkdirs());
            android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
            try (var output = new java.io.FileOutputStream(new java.io.File(directory, "wide-detail-sidebar.png"))) {
                assertTrue(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output));
            } finally {
                screenshot.recycle();
            }
            getInstrumentation().runOnMainSync(() -> {
                try {
                    android.view.View row = activity.getWindow().getDecorView()
                        .findViewWithTag("sidebarConversation:sidebar-running");
                    assertNotNull(row);
                    row.performClick();
                    assertEquals("sidebar-running", field("conversationId"));
                    assertEquals("Background analysis", field("conversationTitle"));
                    android.view.View selected = activity.getWindow().getDecorView()
                        .findViewWithTag("sidebarConversation:sidebar-running");
                    assertNotNull(selected);
                    assertTrue("The tapped conversation must become the selected sidebar row", selected.isSelected());
                } catch (Exception error) {
                    throw new AssertionError(error);
                }
            });
        } finally {
            cache.remove(credentials); RemoteListCache.workbench(context).remove(credentials);
            new CredentialStore(context).clear();
        }
    }

    public void testWideSidebarHeaderStaysPinnedAboveScrolledRows() throws Exception {
        var context = getInstrumentation().getTargetContext();
        if (!MobileLayout.useDetailSplit(activity.getResources().getConfiguration())) return;
        JSONObject credentials = new JSONObject().put("address", "http://100.80.1.5:43127")
            .put("token", "c".repeat(43)).put("computerName", "Sidebar scroll test");
        new CredentialStore(context).save(credentials);
        JSONArray rows = new JSONArray();
        for (int index = 0; index < 24; index++) {
            rows.put(new JSONObject().put("id", "scroll-" + index).put("title", "Conversation " + index)
                .put("engine", index % 2 == 0 ? "codex" : "claude").put("activity", index == 0 ? "running" : "idle")
                .put("updatedAt", System.currentTimeMillis() - index * 1000L));
        }
        RemoteListCache cache = RemoteListCache.get(context);
        cache.put(credentials, rows, -1, new JSONArray(), true);
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    field("credentials", credentials);
                    field("foreground", false);
                    field("conversationId", "scroll-8");
                    field("conversationTitle", "Conversation 8");
                    field("detailReturn", "list");
                    invoke("detailScreen");
                } catch (Exception error) {
                    throw new AssertionError(error);
                }
            });
            getInstrumentation().waitForIdleSync();
            android.os.SystemClock.sleep(700);
            final int[] scrollBeforeSelection = new int[1];
            getInstrumentation().runOnMainSync(() -> {
                View sidebar = activity.getWindow().getDecorView().findViewWithTag("detailConversationSidebar");
                View header = sidebar.findViewWithTag("sidebarHeader");
                android.widget.ScrollView scroll = sidebar.findViewWithTag("sidebarScroll");
                assertNotNull(header); assertNotNull(scroll);
                assertNotNull("The fixed sidebar header needs its own opaque background",
                    header.getBackground());
                assertTrue("The header must draw above the conversation scroller",
                    header.getTranslationZ() > 0);
                assertEquals("The sidebar header must start inside the sidebar safe area",
                    sidebar.getPaddingTop(), header.getTop());
                assertTrue("The conversation scroller must start below the fixed header",
                    scroll.getTop() >= header.getBottom());
                int[] before = new int[2]; header.getLocationOnScreen(before);
                scroll.setSmoothScrollingEnabled(false); scroll.fullScroll(View.FOCUS_DOWN);
                int[] after = new int[2]; header.getLocationOnScreen(after);
                assertEquals("Scrolling conversation rows must not move the sidebar header",
                    before[1], after[1]);
                scrollBeforeSelection[0] = scroll.getScrollY();
                View target = sidebar.findViewWithTag("sidebarConversation:scroll-20");
                assertNotNull(target);
                target.performClick();
            });
            getInstrumentation().waitForIdleSync();
            android.os.SystemClock.sleep(600);
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                View sidebar = activity.getWindow().getDecorView().findViewWithTag("detailConversationSidebar");
                android.widget.ScrollView scroll = sidebar.findViewWithTag("sidebarScroll");
                assertNotNull(scroll);
                assertEquals("Selecting a conversation must preserve the sidebar scroll position",
                    scrollBeforeSelection[0], scroll.getScrollY());
                try {
                    assertEquals("scroll-20", field("conversationId"));
                } catch (Exception error) {
                    throw new AssertionError(error);
                }
            });
            java.io.File directory = new java.io.File(activity.getExternalFilesDir(null), "workbench-visuals");
            assertTrue(directory.isDirectory() || directory.mkdirs());
            android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
            try (var output = new java.io.FileOutputStream(new java.io.File(directory, "wide-sidebar-scrolled.png"))) {
                assertTrue(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output));
            } finally {
                screenshot.recycle();
            }
        } finally {
            cache.remove(credentials); RemoteListCache.workbench(context).remove(credentials);
            new CredentialStore(context).clear();
        }
    }

    public void testNavigationGeometryStaysStableAcrossDestinations() throws Exception {
        getInstrumentation().waitForIdleSync();
        android.os.SystemClock.sleep(600);
        getInstrumentation().waitForIdleSync();
        int[] home = navigationGeometry();
        assertEquals(Math.round(64 * activity.getResources().getDisplayMetrics().density), home[0]);
        for (int index = 1; index < 5; index++)
            assertEquals("Navigation item " + index + " must share one height", home[1], home[index]);

        for (String destination : new String[]{"homeScreen", "listScreen", "computersScreen", "settingsScreen"}) {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    invoke(destination);
                    ((PageTransitions) field("pages")).finishTransition();
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            int[] baseline = navigationGeometry();
            assertTrue(destination + " must retain navigation position and size", java.util.Arrays.equals(home, baseline));
            getInstrumentation().runOnMainSync(() -> {
                View navigation = activity.getWindow().getDecorView().findViewWithTag("workbenchNav");
                View viewport = (View) navigation.getParent();
                assertTrue("The bottom shadow must not be clipped on " + destination,
                    viewport.getHeight() - navigation.getBottom() >= Math.round(4 * activity.getResources().getDisplayMetrics().density));
                android.graphics.Rect visible = new android.graphics.Rect(); assertTrue(navigation.getGlobalVisibleRect(visible));
                assertEquals("The bar's rounded sides must fit narrow windows", navigation.getWidth(), visible.width());
            });
            capture("navigation-consistent-" + destination);
            int[] viewportHeight = new int[1];
            getInstrumentation().runOnMainSync(() -> {
                try { viewportHeight[0] = ((View) field("scroll")).getHeight(); }
                catch (Exception error) { throw new AssertionError(error); }
            });
            for (String value : new String[]{"Showing cached conversations; syncing…", "Connection failed\nRetry connection", ""}) {
                getInstrumentation().runOnMainSync(() -> {
                    try { ((TextView) field("status")).setText(value); }
                    catch (Exception error) { throw new AssertionError(error); }
                });
                getInstrumentation().waitForIdleSync();
                assertTrue(destination + " status updates must keep navigation fixed",
                    java.util.Arrays.equals(baseline, navigationGeometry()));
                getInstrumentation().runOnMainSync(() -> {
                    try {
                        View status = (View) field("status");
                        assertNull("No status footer belongs above destination navigation", status.getParent());
                        assertFalse(status.isShown());
                        assertEquals("Status updates must not resize the scrolling content", viewportHeight[0], ((View) field("scroll")).getHeight());
                    } catch (Exception error) { throw new AssertionError(error); }
                });
            }
        }
    }

    public void testDestinationRefreshHasNoSpinnerOrContentOffset() throws Exception {
        var context = getInstrumentation().getTargetContext();
        JSONObject credentials = new JSONObject().put("address", "http://100.80.1.2:43127")
            .put("token", "a".repeat(43)).put("computerName", "Refresh presentation");
        RemoteListCache cache = RemoteListCache.get(context);
        cache.put(credentials, new JSONArray().put(new JSONObject().put("id", "refresh-row")
            .put("title", "Keep this conversation visible").put("engine", "codex").put("activity", "running")
            .put("updatedAt", System.currentTimeMillis())), -1, new JSONArray(), true);
        try {
            for (String destination : new String[]{"listScreen", "computersScreen"}) {
                getInstrumentation().runOnMainSync(() -> {
                    try {
                        invoke("stopNetwork");
                        field("foreground", false);
                        field("credentials", credentials);
                        invoke(destination);
                        ((PageTransitions) field("pages")).finishTransition();
                    } catch (Exception error) { throw new AssertionError(error); }
                });
                getInstrumentation().waitForIdleSync();
                android.graphics.Bitmap[] before = new android.graphics.Bitmap[1];
                getInstrumentation().runOnMainSync(() -> {
                    try {
                        RefreshScrollView scroll = (RefreshScrollView) field("scroll");
                        before[0] = android.graphics.Bitmap.createBitmap(scroll.getWidth(), scroll.getHeight(),
                            android.graphics.Bitmap.Config.ARGB_8888);
                        scroll.draw(new android.graphics.Canvas(before[0]));
                        scroll.setRefreshing(true);
                    } catch (Exception error) { throw new AssertionError(error); }
                });
                try {
                    android.os.SystemClock.sleep(350);
                    if (destination.equals("listScreen")) capture("sessions-refresh-no-spinner");
                    getInstrumentation().runOnMainSync(() -> {
                        try {
                            RefreshScrollView scroll = (RefreshScrollView) field("scroll");
                            assertEquals("Refreshing must not push destination content down", 0f,
                                scroll.getChildAt(0).getTranslationY(), 0f);
                            android.graphics.Bitmap busy = android.graphics.Bitmap.createBitmap(before[0]);
                            try {
                                busy.eraseColor(android.graphics.Color.TRANSPARENT);
                                scroll.draw(new android.graphics.Canvas(busy));
                                assertTrue("Refreshing must not paint a spinner above destination content", before[0].sameAs(busy));
                            } finally { busy.recycle(); }
                            scroll.setRefreshing(false);
                        } catch (Exception error) { throw new AssertionError(error); }
                    });
                } finally { before[0].recycle(); }
            }
        } finally { cache.remove(credentials); RemoteListCache.workbench(context).remove(credentials); }
    }

    public void testHeldNavigationFeedbackKeepsRoundedCorners() throws Exception {
        getInstrumentation().waitForIdleSync();
        android.os.SystemClock.sleep(600);
        java.io.File directory = new java.io.File(activity.getExternalFilesDir(null), "navigation-press-visuals");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        int inset = Math.round(3 * activity.getResources().getDisplayMetrics().density);
        for (String id : new String[]{"home", "sessions", "computers", "settings"}) {
            int[] bounds = new int[4];
            getInstrumentation().runOnMainSync(() -> {
                View item = activity.getWindow().getDecorView().findViewWithTag("nav:" + id);
                item.getLocationOnScreen(bounds);
                bounds[2] = item.getWidth();
                bounds[3] = item.getHeight();
            });
            android.graphics.Bitmap before = getInstrumentation().getUiAutomation().takeScreenshot();
            long downTime = android.os.SystemClock.uptimeMillis();
            android.view.MotionEvent down = android.view.MotionEvent.obtain(downTime, downTime,
                android.view.MotionEvent.ACTION_DOWN, bounds[0] + bounds[2] / 2f, bounds[1] + bounds[3] / 2f, 0);
            getInstrumentation().sendPointerSync(down);
            down.recycle();
            android.graphics.Bitmap held = null;
            try {
                android.os.SystemClock.sleep(900);
                held = getInstrumentation().getUiAutomation().takeScreenshot();
                for (int x : new int[]{bounds[0] + inset, bounds[0] + bounds[2] - 1 - inset}) {
                    for (int y : new int[]{bounds[1] + inset, bounds[1] + bounds[3] - 1 - inset}) {
                        assertTrue(id + " held feedback must leave the rounded corner clear",
                            pixelDifference(before.getPixel(x, y), held.getPixel(x, y)) <= 6);
                    }
                }
                int x = bounds[0] + bounds[2] / 2;
                int y = bounds[1] + inset;
                assertTrue(id + " must still show visible feedback inside the rounded shape",
                    pixelDifference(before.getPixel(x, y), held.getPixel(x, y)) > 6);
                android.graphics.Bitmap crop = android.graphics.Bitmap.createBitmap(held,
                    bounds[0], bounds[1], bounds[2], bounds[3]);
                try (var output = new java.io.FileOutputStream(new java.io.File(directory, id + "-held.png"))) {
                    assertTrue(crop.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output));
                } finally {
                    crop.recycle();
                }
            } finally {
                android.view.MotionEvent cancel = android.view.MotionEvent.obtain(downTime,
                    android.os.SystemClock.uptimeMillis(), android.view.MotionEvent.ACTION_CANCEL,
                    bounds[0] + bounds[2] / 2f, bounds[1] + bounds[3] / 2f, 0);
                getInstrumentation().sendPointerSync(cancel);
                cancel.recycle();
                before.recycle();
                if (held != null) held.recycle();
            }
            android.os.SystemClock.sleep(350);
        }
    }

    private static int pixelDifference(int first, int second) {
        return Math.abs(android.graphics.Color.red(first) - android.graphics.Color.red(second))
            + Math.abs(android.graphics.Color.green(first) - android.graphics.Color.green(second))
            + Math.abs(android.graphics.Color.blue(first) - android.graphics.Color.blue(second));
    }

    private int[] navigationGeometry() {
        int[] values = new int[8];
        for (int attempt = 0; attempt < 30; attempt++) {
            getInstrumentation().runOnMainSync(() -> {
                View navigation = activity.getWindow().getDecorView().findViewWithTag("workbenchNav");
                assertNotNull(navigation);
                values[0] = navigation.getHeight();
                String[] tags = {"nav:home", "nav:sessions", "nav:computers", "nav:settings"};
                for (int index = 0; index < tags.length; index++) {
                    View item = navigation.findViewWithTag(tags[index]);
                    assertNotNull(item);
                    values[index + 1] = item.getHeight();
                }
                int[] location = new int[2];
                navigation.getLocationOnScreen(location);
                values[5] = location[1];
                values[6] = navigation.getWidth();
                values[7] = location[0];
            });
            boolean ready = values[0] > 0;
            for (int index = 1; index < 5; index++) ready &= values[index] > 0;
            if (ready) {
                assertEquals(Math.round(64 * activity.getResources().getDisplayMetrics().density), values[0]);
                return values;
            }
            android.os.SystemClock.sleep(100);
        }
        fail("Bottom navigation did not finish laying out");
        return values;
    }

    private Object field(String name) throws Exception {
        var member = MainActivity.class.getDeclaredField(name);
        member.setAccessible(true);
        return member.get(activity);
    }

    private void field(String name, Object value) throws Exception {
        var member = MainActivity.class.getDeclaredField(name);
        member.setAccessible(true);
        member.set(activity, value);
    }

    private void invoke(String name) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name);
        method.setAccessible(true);
        method.invoke(activity);
    }
}
