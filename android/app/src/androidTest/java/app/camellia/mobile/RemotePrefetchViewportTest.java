package app.camellia.mobile;

import android.content.Intent;
import android.graphics.Rect;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.ScrollView;
import java.lang.reflect.Field;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

public class RemotePrefetchViewportTest extends InstrumentationTestCase {
    private MainActivity activity;
    private RemotePrefetch cache;
    private RemoteListCache lists;
    private CredentialStore storage, computers;
    private boolean oldEmbedded;
    private final List<String> requests = new CopyOnWriteArrayList<>();

    @Override protected void setUp() throws Exception {
        super.setUp(); var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); oldEmbedded = EmbeddedNetwork.enabled(); EmbeddedNetwork.setEnabled(false);
        storage = new CredentialStore(context, "prefetch-viewport-lists-test"); storage.clear();
        computers = new CredentialStore(context, "prefetch-viewport-computers-test"); computers.clear();
        lists = new RemoteListCache(storage);
        cache = new RemotePrefetch(address -> new RemoteApi("http://100.64.0.1:43128") {
            @Override JSONObject json(String path, String token, JSONObject payload, int limit) throws java.io.IOException {
                requests.add(path);
                try { return RemotePrefetchTest.snapshot(Integer.parseInt(path.substring(path.lastIndexOf('-') + 1)), "preview"); }
                catch (Exception error) { throw new java.io.IOException(error); }
            }
            @Override public void cancel() { }
        }, 60_000);
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            invoke("stopNetwork"); ((RemotePrefetch) get("prefetch")).close(); set("prefetch", cache); set("listCache", lists);
            set("store", new ComputerStore(computers)); set("credentials", credential()); set("foreground", true); invoke("listScreen");
            @SuppressWarnings("unchecked") Map<String, Boolean> groups = (Map<String, Boolean>) get("collapsedGroups");
            groups.put(credential().getString("address") + "/", false);
        });
    }
    @Override protected void tearDown() throws Exception {
        if (activity != null) { ui(activity::finish); getInstrumentation().waitForIdleSync(); }
        cache.close(); assertTrue(RemotePrefetchTest.executor(cache).awaitTermination(5, TimeUnit.SECONDS));
        lists.close().get(5, TimeUnit.SECONDS); storage.clear(); computers.clear(); EmbeddedNetwork.setEnabled(oldEmbedded); super.tearDown();
    }

    public void testOnlyActuallyVisibleRowsAndNearbyRowsAreCandidates() throws Exception {
        show(RemotePrefetchTest.rows(1, 1000)); update();
        ui(() -> {
            Map<?, ?> selected = RemotePrefetchTest.map(cache, "desired");
            assertTrue(selected.size() > 0 && selected.size() <= 6); int immediate = 0, nearby = 0;
            for (Object item : selected.values()) {
                String id = (String) RemotePrefetchTest.field(item, "id");
                View card = ((View) get("content")).findViewWithTag("conversation:" + id);
                if ((boolean) RemotePrefetchTest.field(item, "immediate")) { immediate++; Rect bounds = new Rect(); assertTrue(card.getGlobalVisibleRect(bounds)); }
                else nearby++;
            }
            assertTrue(immediate <= 4); assertTrue(nearby <= 2);
        });
        assertTrue(requests.size() <= 4); for (String request : requests) assertFalse(request.contains("?"));
    }

    public void testScrollingReplacesCandidatesWithRowsAtTheNewPosition() throws Exception {
        show(RemotePrefetchTest.rows(1, 100)); update(); Set<String> before = selectedIds();
        ui(() -> ((ScrollView) get("scroll")).scrollTo(0, 2500)); update(); Set<String> after = selectedIds();
        assertFalse(after.isEmpty()); assertTrue(Collections.disjoint(before, after));
        ui(() -> assertTrue(RemotePrefetchTest.map(cache, "desired").size() <= 6));
    }

    public void testCollapsedAndFilteredRowsAreExcluded() throws Exception {
        JSONArray rows = RemotePrefetchTest.rows(1, 50);
        for (int index = 0; index < rows.length(); index++) rows.getJSONObject(index).put("title", "Hidden " + index).put("workspaceId", "hidden");
        rows.put(RemotePrefetchTest.snapshot(101, "").getJSONObject("conversation").put("title", "Target").put("workspaceId", "visible"));
        ui(() -> {
            set("availableWorkspaces", new JSONArray().put(new JSONObject().put("id", "hidden").put("name", "Hidden")).put(new JSONObject().put("id", "visible").put("name", "Visible")));
            @SuppressWarnings("unchecked") Map<String, Boolean> groups = (Map<String, Boolean>) get("collapsedGroups");
            groups.put(credential().getString("address") + "/hidden", true);
            groups.put(credential().getString("address") + "/visible", false);
        });
        show(rows); update(); assertEquals(Set.of(RemotePrefetchTest.id(101)), selectedIds());
        ui(() -> ((android.widget.EditText) get("searchInput")).setText("Target")); update();
        assertEquals(Set.of(RemotePrefetchTest.id(101)), selectedIds());
    }

    public void testOpeningAChatStopsOtherConversationPrefetch() throws Exception {
        show(RemotePrefetchTest.rows(1, 100)); update();
        ui(() -> { set("conversationId", RemotePrefetchTest.id(1)); set("conversationTitle", "Chat"); invoke("detailScreen"); });
        ui(() -> {
            var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true);
            apply.invoke(activity, RemotePrefetchTest.snapshot(1, "active reply").put("instanceId", "server").put("cursor", 1).put("permission", "read"));
            assertTrue(RemotePrefetchTest.map(cache, "desired").isEmpty()); assertTrue(RemotePrefetchTest.map(cache, "pending").isEmpty());
            assertTrue(((List<?>) get("prefetchRows")).isEmpty());
        });
        getInstrumentation().waitForIdleSync(); assertTrue(RemotePrefetchTest.map(cache, "desired").isEmpty());
    }

    public void testLoadingMoreRemainsAnExplicitListAction() throws Exception {
        show(RemotePrefetchTest.rows(1, 100)); ui(() -> set("nextOffset", 100)); ui(() -> invoke("renderConversations")); update();
        ui(() -> assertTrue(hasText((View) get("content"), "Load more conversations") || hasText((View) get("content"), "加载更多会话")));
        for (String request : requests) assertFalse(request.contains("?offset="));
        ui(() -> assertEquals(100, get("nextOffset")));
    }

    public void testComputerSelectionOnlyChecksStatusForEachComputer() throws Exception {
        List<String> paths = new CopyOnWriteArrayList<>();
        java.util.function.Function<String, RemoteApi> factory = address -> new RemoteApi(address) {
            @Override public JSONObject json(String path, String token, JSONObject payload) throws java.io.IOException {
                paths.add(path);
                try { return new JSONObject().put("protocol", 1).put("workspaces", new JSONArray()); }
                catch (Exception error) { throw new java.io.IOException(error); }
            }
            @Override public void cancel() { }
        };
        ui(() -> {
            ComputerStore store = (ComputerStore) get("store"); store.save(credential());
            store.save(new JSONObject(credential().toString()).put("address", "http://100.80.1.3:43128"));
            set("statusClientFactory", factory); invoke("computersScreen"); invoke("refreshComputers");
        });
        RemotePrefetchTest.await(() -> {
            ThreadPoolExecutor worker = (ThreadPoolExecutor) get("statusWorker");
            return paths.size() >= 2 && worker.getActiveCount() == 0 && worker.getQueue().isEmpty();
        });
        assertEquals(Arrays.asList("/v1/status", "/v1/status"), paths);
        assertTrue(requests.isEmpty()); assertTrue(RemotePrefetchTest.map(cache, "desired").isEmpty());
    }

    private static boolean hasText(View view, String text) {
        if (view instanceof android.widget.TextView label && text.contentEquals(label.getText())) return true;
        if (view instanceof android.view.ViewGroup group) for (int index = 0; index < group.getChildCount(); index++) if (hasText(group.getChildAt(index), text)) return true;
        return false;
    }
    private JSONObject credential() throws Exception { return new JSONObject().put("address", "http://100.80.1.2:43128").put("token", "a".repeat(43)); }
    private void show(JSONArray rows) throws Exception {
        ui(() -> { var apply = MainActivity.class.getDeclaredMethod("applyConversationPage", JSONObject.class, boolean.class); apply.setAccessible(true); apply.invoke(activity, new JSONObject().put("conversations", rows).put("nextOffset", -1), false); });
    }
    private void update() throws Exception {
        getInstrumentation().waitForIdleSync();
        RemotePrefetchTest.await(() -> { AtomicReference<Boolean> ready = new AtomicReference<>(); ui(() -> { ScrollView view = (ScrollView) get("scroll"); @SuppressWarnings("unchecked") List<View> rows = (List<View>) get("prefetchRows"); ready.set(view.getHeight() > 0 && (rows.isEmpty() || rows.get(0).getHeight() > 0)); }); return ready.get(); });
        ui(() -> invoke("updatePrefetchViewport")); getInstrumentation().waitForIdleSync();
    }
    private Set<String> selectedIds() throws Exception {
        Set<String> result = new HashSet<>(); ui(() -> { synchronized (cache) { for (Object item : RemotePrefetchTest.map(cache, "desired").values()) result.add((String) RemotePrefetchTest.field(item, "id")); } }); return result;
    }
    private Object get(String name) throws Exception { Field field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); return field.get(activity); }
    private void set(String name, Object value) throws Exception { Field field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); field.set(activity, value); }
    private void invoke(String name) throws Exception { var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity); }
    interface Check { void run() throws Exception; }
    private void ui(Check check) throws Exception {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
}
