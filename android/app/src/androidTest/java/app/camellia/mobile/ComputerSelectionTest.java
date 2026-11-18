package app.camellia.mobile;

import android.content.Intent;
import android.graphics.drawable.GradientDrawable;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.TimeUnit;

public class ComputerSelectionTest extends InstrumentationTestCase {
    private MainActivity activity;
    private CredentialStore encrypted;
    private ComputerStore computers;
    private JSONObject first, second;

    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        encrypted = new CredentialStore(context, "computer-selection-test"); encrypted.clear(); computers = new ComputerStore(encrypted);
        first = new JSONObject().put("address", "http://100.64.0.11:43127").put("computerName", "HP").put("token", "a".repeat(43));
        second = new JSONObject().put("address", "http://100.64.0.12:43127").put("computerName", "ROG").put("token", "b".repeat(43));
        computers.save(first); computers.save(second);
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            invoke("stopNetwork"); field("store", computers); field("credentials", second); field("chinese", true); field("foreground", false);
            invoke("computersScreen"); state(first, "已连接"); state(second, "暂时无法连接");
        });
        getInstrumentation().waitForIdleSync();
    }

    @Override protected void tearDown() throws Exception {
        ui(() -> {
            android.app.Dialog dialog = (android.app.Dialog) field("computerDialog");
            if (dialog != null) dialog.dismiss(); activity.finish();
        });
        getInstrumentation().waitForIdleSync(); encrypted.clear(); super.tearDown();
    }

    public void testManagementAndSelectionAreSeparateAndAddingPreservesComputers() throws Exception {
        screenshot("computer-selection");
        ui(() -> {
            ViewGroup card = root().findViewWithTag("computerList");
            View row = root().findViewWithTag("computer:" + first.getString("address"));
            assertSame(card, row.getParent()); assertSame(card, root().findViewWithTag("addComputer").getParent());
            assertFalse(containsText(card, first.getString("address")));
            assertTrue(row.getContentDescription().toString().contains("已连接"));
            root().findViewWithTag("manage:" + first.getString("address")).performClick();
            assertEquals("computers", field("screen"));
            android.app.Dialog dialog = (android.app.Dialog) field("computerDialog");
            assertTrue(dialog.isShowing()); View panel = dialog.getWindow().getDecorView();
            assertTrue(containsText(panel, first.getString("address"))); assertTrue(containsText(panel, "已连接"));
            assertNotNull(panel.findViewWithTag("manageRename")); assertNotNull(panel.findViewWithTag("manageForget"));
            assertNotNull(panel.findViewWithTag("manageConnectionTest"));
            dialog.dismiss(); row.performClick();
            assertEquals("list", field("screen")); assertEquals(first.getString("address"), ((JSONObject) field("credentials")).getString("address"));
            activity.onBackPressed(); assertEquals("home", field("screen"));
            root().findViewWithTag("nav:computers").performClick(); assertEquals("computers", field("screen"));
            root().findViewWithTag("addComputer").performClick();
            assertEquals("pair", field("screen")); assertEquals(2, computers.all().size());
        });
    }

    public void testForgettingAComputerDisconnectsAndDropsItsChatCache() throws Exception {
        var context = getInstrumentation().getTargetContext();
        JSONObject owner = new JSONObject(first.toString());
        String id = "00000000-0000-0000-0000-000000000001";
        var cancelled = new java.util.concurrent.CountDownLatch(1);
        RemoteApi client = new RemoteApi(first.getString("address")) {
            @Override public void cancel() { cancelled.countDown(); super.cancel(); }
        };
        JSONObject snapshot = new JSONObject()
            .put("instanceId", "server").put("cursor", 4).put("historyVersion", "a".repeat(64)).put("permission", "control")
            .put("conversation", new JSONObject().put("id", id).put("title", "Private chat"))
            .put("messages", new JSONArray().put(new JSONObject().put("seq", 4).put("role", "assistant").put("text", "Cached private reply")))
            .put("nextBefore", JSONObject.NULL);
        RemoteConversationCache cache = RemoteConversationCache.get(context);
        cache.put(owner, snapshot); cache.flush().get(5, TimeUnit.SECONDS);
        try {
            ui(() -> {
                field("api", client);
                assertNotNull(cache.get(owner, id));
                invoke("removeComputer", new Class<?>[]{JSONObject.class}, first);
                assertNull("The forgotten computer must lose its cached chat", cache.get(owner, id));
                assertEquals(1, computers.all().size());
                assertEquals(second.getString("address"), computers.all().get(0).getString("address"));
                assertEquals(second.getString("address"), ((JSONObject) field("credentials")).getString("address"));
            });
            assertTrue("Forgetting a computer must close its live client",
                cancelled.await(3, TimeUnit.SECONDS));
            RemoteConversationCache reopened = new RemoteConversationCache(
                new RemoteConversationCache.Storage() {
                    @Override public JSONObject load(String key) throws Exception {
                        return new CredentialStore(context, "remote-conversation-cache-" + key).load();
                    }
                    @Override public void save(String key, JSONObject value) throws Exception {
                        new CredentialStore(context, "remote-conversation-cache-" + key).save(value);
                    }
                    @Override public void delete(String key) { new CredentialStore(context, "remote-conversation-cache-" + key).clear(); }
                }, error -> fail(error.toString()), 60_000);
            try { assertNull("A process restart must not revive the forgotten chat", reopened.get(owner, id)); }
            finally { reopened.close(); }
        } finally { cache.removeDurably(owner, null); }
    }

    public void testRefreshUpdatesVisibleAndAccessibleStateWithoutKeepingTheOldOnlineDot() throws Exception {
        ui(() -> {
            String address = first.getString("address"); View row = root().findViewWithTag("computer:" + address);
            View dot = root().findViewWithTag("computerPresence:" + address);
            assertTrue("The online presence dot must be visible", dot.isShown());
            int online = ((GradientDrawable) dot.getBackground()).getColor().getDefaultColor();
            assertEquals("The online presence color must be opaque", 255, android.graphics.Color.alpha(online));
            state(first, "正在检查…");
            assertEquals("正在检查…", ((TextView) root().findViewWithTag("computerState:" + address)).getText().toString());
            assertFalse(row.getContentDescription().toString().contains("已连接"));
            assertFalse(online == ((GradientDrawable) dot.getBackground()).getColor().getDefaultColor());
            String failure = RemoteApi.failureMessage(new RemoteApi.Failure(401), true); state(first, failure);
            assertTrue(row.getContentDescription().toString().contains(failure));
            assertFalse(online == ((GradientDrawable) dot.getBackground()).getColor().getDefaultColor());
            TextView footer = (TextView) field("status"); footer.setText("电脑状态已更新"); assertEquals(View.GONE, footer.getVisibility());
            footer.setText("无法检查电脑状态，请下拉重试。"); assertEquals(View.GONE, footer.getVisibility());
            assertNull("Computer states stay in their rows, outside navigation", footer.getParent());
        });
    }

    public void testEmptyCardHasOneAddActionAndKeepsPairingReachable() throws Exception {
        ui(() -> { encrypted.clear(); field("credentials", new JSONObject()); invoke("computersScreen"); });
        getInstrumentation().waitForIdleSync(); screenshot("computer-selection-empty");
        ui(() -> {
            View empty = root().findViewWithTag("settingsEmptyState");
            assertNotNull(empty);
            // Outside the card, not inside it. Sharing a surface with the "Add
            // computer" row below made the empty state read as one more thing to
            // tap, which is the opposite of what it is.
            assertNull("the empty state must not sit inside the computer card",
                root().findViewWithTag("computerList").findViewById(empty.getId()));
            assertEquals(1, exactTextCount(root(), "添加电脑"));
            root().findViewWithTag("addComputer").performClick(); assertEquals("pair", field("screen"));
        });
    }

    public void testRouteSitsOnTheSameStatusLineAndDisappearsWithoutAProbe() throws Exception {
        ui(() -> {
            var context = getInstrumentation().getTargetContext();
            ComputerRow row = new ComputerRow(context, new SettingsStyle(context), true, "HP", first.getString("address"), () -> {}, () -> {});
            row.state("已连接", true, false);
            row.route("VPS 中继 · Peer Relay");
            TextView state = row.findViewWithTag("computerState:" + first.getString("address"));
            TextView route = row.findViewWithTag("computerRoute:" + first.getString("address"));
            assertNotNull(state); assertNotNull(route);
            assertSame("the path must share one horizontal status row", state.getParent(), route.getParent());
            assertEquals(View.VISIBLE, route.getVisibility());
            assertEquals(1, state.getMaxLines());
            assertTrue(row.getContentDescription().toString().contains("VPS 中继"));
            row.route(null);
            assertEquals(View.GONE, route.getVisibility());
            assertEquals(2, state.getMaxLines());
            assertFalse(row.getContentDescription().toString().contains("VPS 中继"));
        });
    }

    public void testRefreshDoesNotReuseAnOldPathWhenNoNewProbeIsAvailable() throws Exception {
        ui(() -> {
            field("foreground", true);
            applyRoute((int) field("generation"), first, "direct");
            assertEquals(View.VISIBLE, root().findViewWithTag("computerRoute:" + first.getString("address")).getVisibility());
            field("statusClientFactory", (java.util.function.Function<String, RemoteApi>) address -> new RemoteApi(address) {
                @Override public JSONObject json(String path, String token, JSONObject payload) throws java.io.IOException {
                    return new JSONObject(java.util.Map.of("protocol", 1));
                }
            });
            invoke("refreshComputers");
        });
        long deadline = android.os.SystemClock.elapsedRealtime() + 5000;
        boolean[] ready = {false};
        while (!ready[0] && android.os.SystemClock.elapsedRealtime() < deadline) {
            ui(() -> ready[0] = "已连接".contentEquals(((TextView) root().findViewWithTag("computerState:" + first.getString("address"))).getText()));
            if (!ready[0]) Thread.sleep(25);
        }
        assertTrue("The refreshed HTTP status did not arrive", ready[0]);
        ui(() -> {
            assertEquals(View.GONE, root().findViewWithTag("computerRoute:" + first.getString("address")).getVisibility());
            assertFalse(((java.util.Map<?, ?>) field("computerRoutes")).containsKey(first.getString("address")));
        });
    }

    public void testLateRouteFromAnOlderRefreshCannotReplaceTheNewRouteAndFailureClearsIt() throws Exception {
        ui(() -> {
            field("foreground", true);
            int old = (int) field("generation");
            applyRoute(old, first, "direct");
            assertEquals(View.GONE, root().findViewWithTag("computerRoute:" + second.getString("address")).getVisibility());
            invoke("stopNetwork");
            applyRoute((int) field("generation"), first, "peer-relay");
            applyRoute(old, first, "direct");
            TextView route = root().findViewWithTag("computerRoute:" + first.getString("address"));
            assertTrue(route.getText().toString().contains("VPS 中继"));
            applyRoute((int) field("generation"), first, "unreachable");
            assertEquals(View.GONE, route.getVisibility());
            assertTrue(root().findViewWithTag("computer:" + first.getString("address")).getContentDescription().toString().contains("已连接"));
        });
    }

    public void testNetworkChangeInvalidatesTheDisplayedPathBeforeAnotherProbe() throws Exception {
        ui(() -> {
            field("foreground", true); applyRoute((int) field("generation"), first, "direct");
            field("foreground", false); invoke("networkRouteChanged");
            assertTrue(((java.util.Map<?, ?>) field("computerRoutes")).isEmpty());
            assertEquals(View.GONE, root().findViewWithTag("computerRoute:" + first.getString("address")).getVisibility());
        });
    }

    private void applyRoute(int ticket, JSONObject computer, String path) throws Exception {
        var method = MainActivity.class.getDeclaredMethod("applyComputerPath", int.class, String.class, JSONObject.class); method.setAccessible(true);
        method.invoke(activity, ticket, computer.getString("address"), new JSONObject().put("path", path));
    }

    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Exception error) { throw new AssertionError(error); } });
    }
    private View root() { return activity.getWindow().getDecorView(); }
    private Object field(String name) throws Exception {
        var field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); return field.get(activity);
    }
    private void field(String name, Object value) throws Exception {
        var field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); field.set(activity, value);
    }
    private void invoke(String name) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity);
    }
    private void invoke(String name, Class<?>[] types, Object... arguments) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name, types); method.setAccessible(true); method.invoke(activity, arguments);
    }
    private void state(JSONObject computer, String value) throws Exception {
        var method = MainActivity.class.getDeclaredMethod("updateComputerState", String.class, String.class); method.setAccessible(true);
        method.invoke(activity, computer.getString("address"), value);
    }
    private boolean containsText(View view, String text) {
        if (view instanceof TextView && ((TextView) view).getText().toString().contains(text)) return true;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++)
            if (containsText(((ViewGroup) view).getChildAt(i), text)) return true;
        return false;
    }
    private int exactTextCount(View view, String text) {
        int count = view instanceof TextView && ((TextView) view).getText().toString().equals(text) ? 1 : 0;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) count += exactTextCount(((ViewGroup) view).getChildAt(i), text);
        return count;
    }
    private void screenshot(String name) throws Exception {
        ui(() -> ((PageTransitions) field("pages")).finishTransition());
        getInstrumentation().waitForIdleSync(); getInstrumentation().getUiAutomation().waitForIdle(150, 3000);
        var bitmap = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(bitmap);
        try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), name + ".png"))) {
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
        } finally { bitmap.recycle(); }
    }
}
