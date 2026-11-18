package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/** Verifies continuity across actual list-row opens, not only separately built screens. */
public class TabletConversationListTest extends InstrumentationTestCase {
    private MainActivity main;
    private LocalChatActivity local;
    private CredentialStore credentials;
    private JSONObject computer;
    private JSONArray rows, workspaces;

    @Override protected void setUp() throws Exception {
        super.setUp();
        getInstrumentation().getUiAutomation().setRotation(android.app.UiAutomation.ROTATION_FREEZE_90);
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        MobilePreferences.set(context, "language", ((android.test.InstrumentationTestRunner) getInstrumentation()).getArguments().getString("language", "zh-CN"));
        credentials = new CredentialStore(context); credentials.clear();
        computer = new JSONObject().put("address", "http://100.80.1.19:43127").put("token", "a".repeat(43)).put("computerName", "HP");
        new ComputerStore(credentials).save(computer);
        rows = new JSONArray();
        for (int index = 0; index < 65; index++) rows.put(new JSONObject().put("id", id(index)).put("title", "Session " + index)
            .put("workspaceId", index == 64 ? JSONObject.NULL : "project").put("workspaceName", JSONObject.NULL)
            .put("engine", "codex").put("modelName", "GPT-6.1-Sol").put("activity", index % 2 == 0 ? "running" : "idle")
            .put("seq", 1).put("updatedAt", 1700000000000L));
        workspaces = new JSONArray().put(new JSONObject().put("id", "empty").put("name", "Empty workspace"))
            .put(new JSONObject().put("id", "project").put("name", "Camellia"));
        RemoteListCache.get(context).put(computer, rows, -1, workspaces, true);
        main = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            set(main, "foreground", false); invoke(main, "stopNetwork"); set(main, "credentials", computer);
            main.getPreferences(0).edit().clear().commit(); invoke(main, "listScreen");
        });
        settle();
    }

    @Override protected void tearDown() throws Exception {
        try {
            if (local != null) NativeActivityCleanup.finish(getInstrumentation(), local);
            if (main != null) NativeActivityCleanup.finish(getInstrumentation(), main);
            if (credentials != null) credentials.clear();
        } finally { super.tearDown(); }
    }

    public void testRemoteListKeepsItsViewsGeometryGroupsAndAllRowsWhenOpeningAndSwitching() throws Exception {
        if (!wide()) return;
        View pane = pane(main); assertNotNull("The full session list must own the master pane", pane);
        assertEquals(65, rowTags(pane, "conversation:").size());
        assertFalse("JSON null is never a workspace name", textSnapshot(pane).contains("null"));
        assertNotNull(find(pane, "group:empty")); assertNotNull(find(pane, "remoteSearchButton"));
        assertNotNull(find(pane, "sessionFilter:archived"));
        ui(() -> find(pane, "group:empty").performClick());
        ScrollView scroll = listScroll(pane); ui(() -> scroll.scrollTo(0, 400)); settle();
        int y = scroll.getScrollY(), width = pane.getWidth();
        List<String> before = textSnapshot(pane), order = rowTags(pane, "conversation:");
        capture("remote-before-open");
        openRemote(10);
        assertSame("Opening a chat must retain the actual list, not recreate a different switcher", pane, pane(main));
        assertEquals(width, pane.getWidth()); assertEquals(y, scroll.getScrollY());
        assertEquals(before, textSnapshot(pane)); assertEquals(order, rowTags(pane, "conversation:"));
        assertTrue(find(pane, "conversation:" + id(10)).isSelected());
        capture("remote-after-open");
        ui(() -> ((EditText) field(main, "composer")).setText("first draft"));
        openRemote(11);
        assertSame(pane, pane(main)); assertEquals(y, scroll.getScrollY()); assertEquals(order, rowTags(pane, "conversation:"));
        assertFalse(find(pane, "conversation:" + id(10)).isSelected()); assertTrue(find(pane, "conversation:" + id(11)).isSelected());
        openRemote(10);
        assertEquals("Switching from the retained list saves and restores the old draft", "first draft", ((EditText) field(main, "composer")).getText().toString());
        Object composer = field(main, "composer"), generation = field(main, "generation");
        ui(() -> find(pane, "conversation:" + id(10)).performClick());
        assertSame("Tapping the selected conversation does not rebuild its editor", composer, field(main, "composer"));
        assertEquals(generation, field(main, "generation"));
        ui(() -> { main.onBackPressed(); invoke(main, "stopNetwork"); }); settle();
        assertSame(pane, pane(main)); assertEquals(y, scroll.getScrollY()); assertEquals(before, textSnapshot(pane));
        capture("remote-after-back");
    }

    public void testRemoteSearchAndStatusFilterStaySharedWithTheOpenedChat() throws Exception {
        if (!wide()) return;
        View pane = pane(main);
        ui(() -> find(pane, "sessionFilter:running").performClick());
        List<String> filtered = rowTags(pane, "conversation:"); assertEquals(33, filtered.size());
        openRemote(10);
        assertSame(pane, pane(main)); assertEquals(filtered, rowTags(pane, "conversation:"));
        assertTrue(find(pane, "sessionFilter:running").isSelected() || "running".equals(field(main, "conversationFilter")));
        ui(() -> {
            find(pane, "remoteSearchButton").performClick();
            ((EditText) find(pane, "remoteSearchInput")).setText("Session 1");
        });
        List<String> searched = rowTags(pane, "conversation:"); assertTrue(searched.size() > 1);
        openRemote(12);
        assertSame(pane, pane(main)); assertEquals(searched, rowTags(pane, "conversation:"));
        assertEquals("Session 1", ((EditText) find(pane, "remoteSearchInput")).getText().toString());
        ui(() -> ((EditText) field(main, "composer")).setText("do not replace this chat"));
        ui(() -> ((EditText) find(pane, "remoteSearchInput")).setText("no such session"));
        assertEquals(id(12), field(main, "conversationId")); assertEquals("do not replace this chat", ((EditText) field(main, "composer")).getText().toString());
        assertTrue(rowTags(pane, "conversation:").isEmpty());
        ui(() -> find(pane, "remoteSearchClose").performClick());
        assertEquals(filtered, rowTags(pane, "conversation:"));
    }

    public void testActiveConversationHighlightDoesNotOverwriteBulkSelection() throws Exception {
        if (!wide()) return;
        View pane = pane(main);
        ui(() -> {
            set(main, "selectingConversations", true);
            ((java.util.Set<String>) field(main, "selectedConversations")).add(id(10));
            invoke(main, "renderConversations");
        });
        assertTrue("The checked row must remain selected in the full list", find(pane, "conversation:" + id(10)).isSelected());
        ui(() -> find(pane, "conversation:" + id(12)).performClick());
        assertTrue(find(pane, "conversation:" + id(10)).isSelected()); assertTrue(find(pane, "conversation:" + id(12)).isSelected());
        ui(() -> { set(main, "selectingConversations", false); invoke(main, "renderConversations"); });
        openRemote(10);
        ui(() -> { set(main, "selectingConversations", true); invoke(main, "renderConversations"); });
        assertTrue("The active-chat border must not clear another checked row", find(pane, "conversation:" + id(12)).isSelected());
        assertSame(pane, pane(main)); assertEquals(id(10), field(main, "conversationId"));
    }

    public void testDirectRemoteOpenBuildsTheSameCompleteListWithEmptyAndIndependentGroups() throws Exception {
        if (!wide()) return;
        ui(() -> {
            invoke(main, "homeScreen"); set(main, "conversationId", id(10)); set(main, "conversationTitle", "Session 10");
            invoke(main, "detailScreen");
        }); settle();
        View pane = pane(main); assertNotNull(pane);
        assertEquals(65, rowTags(pane, "conversation:").size());
        assertNotNull(find(pane, "group:empty")); assertNotNull(find(pane, "group:"));
        assertNotNull(find(pane, "sessionFilter:archived"));
        assertFalse(textSnapshot(pane).contains("null"));
    }

    public void testRotationAndHiddenListUpdatesKeepTheSameFilterQueryAndDraft() throws Exception {
        if (!wide()) return;
        View pane = pane(main);
        ui(() -> find(pane, "sessionFilter:running").performClick());
        openRemote(10);
        ui(() -> {
            ((EditText) find(pane, "remoteSearchInput")).setText("Session 1");
            ((EditText) field(main, "composer")).setText("rotation draft");
            main.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        });
        await(() -> main.getResources().getConfiguration().orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT
            && find(main.getWindow().getDecorView(), "conversationListPane") == null, "Portrait hides the master pane");
        assertNull("The hidden list must not retain the old transcript through its parent split", pane.getParent());
        ui(() -> invoke(main, "renderConversations"));
        ui(() -> main.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
        await(() -> wide() && pane(main) != null, "Landscape must restore the full master pane"); settle();
        assertSame(pane, pane(main)); assertEquals("running", field(main, "conversationFilter"));
        assertEquals("Session 1", ((EditText) find(pane, "remoteSearchInput")).getText().toString());
        assertEquals("rotation draft", ((EditText) field(main, "composer")).getText().toString());
        ui(() -> find(pane, "remoteSearchClose").performClick()); settle();
        View filters = find(pane, "conversationFilters");
        View first = find(filters, "sessionFilter:all"), last = find(filters, "sessionFilter:archived");
        assertEquals(first.getWidth(), last.getWidth()); assertTrue(last.getRight() <= filters.getWidth());
    }

    public void testSwitchingComputerOrPairingDoesNotReuseThePreviousListOrQuery() throws Exception {
        if (!wide()) return;
        View oldPane = pane(main);
        ui(() -> ((EditText) find(oldPane, "remoteSearchInput")).setText("Session 1"));
        JSONObject other = new JSONObject(computer.toString()).put("token", "b".repeat(43));
        RemoteListCache.get(main).put(other, new JSONArray().put(new JSONObject().put("id", "other").put("title", "Other pairing")), -1, new JSONArray(), true);
        ui(() -> { set(main, "credentials", other); invoke(main, "listScreen"); }); settle();
        View newPane = pane(main); assertNotSame(oldPane, newPane);
        assertEquals(List.of("conversation:other"), rowTags(newPane, "conversation:"));
        assertEquals("", ((EditText) find(newPane, "remoteSearchInput")).getText().toString());
    }

    public void testListRefreshPaginationAndArchiveDoNotReplaceTheChatConnectionOrDraft() throws Exception {
        if (!wide()) return;
        openRemote(10);
        View pane = pane(main); ScrollView scroll = listScroll(pane);
        JSONArray serverRows = new JSONArray(rows.toString());
        for (int index = 65; index < 125; index++) serverRows.put(new JSONObject().put("id", id(index)).put("title", "Added " + index).put("workspaceId", "project"));
        FixtureApi chat = new FixtureApi(serverRows);
        ui(() -> {
            set(main, "foreground", true); set(main, "api", chat);
            set(main, "homeClientFactory", (java.util.function.Function<String, RemoteApi>) address -> new FixtureApi(serverRows));
            ((EditText) field(main, "composer")).setText("draft during list requests"); scroll.scrollTo(0, 400);
        }); settle();
        Object composer = field(main, "composer"), generation = field(main, "generation"); int y = scroll.getScrollY();
        ui(() -> invokeLoadList(false));
        await(() -> rowTags(pane, "conversation:").size() == 100, "Refresh must retain at least the entire loaded window");
        ui(() -> invokeLoadList(true));
        await(() -> rowTags(pane, "conversation:").size() == 125, "Load more must extend the same list beyond the old sidebar limit");
        settle(); assertEquals(y, scroll.getScrollY());
        assertSame(chat, field(main, "api")); assertFalse(chat.cancelled); assertEquals(generation, field(main, "generation"));
        assertSame(composer, field(main, "composer"));
        ui(() -> find(pane, "sessionFilter:archived").performClick());
        await(() -> find(pane, "conversation:archived-fixture") != null, "Archive filter must populate inside the same pane");
        assertEquals(id(10), field(main, "conversationId")); assertSame(chat, field(main, "api")); assertFalse(chat.cancelled);
        assertSame(composer, field(main, "composer")); assertEquals(generation, field(main, "generation"));
        assertEquals("draft during list requests", ((EditText) composer).getText().toString());
        ui(() -> { set(main, "foreground", false); invoke(main, "stopNetwork"); });
    }

    private final class FixtureApi extends RemoteApi {
        private final JSONArray entries;
        volatile boolean cancelled;
        FixtureApi(JSONArray entries) { super("http://100.80.1.19:43127"); this.entries = entries; }
        @Override public JSONObject json(String path, String token, JSONObject payload) throws java.io.IOException {
            try {
                if (path.startsWith("/v1/archived")) return new JSONObject().put("conversations", new JSONArray().put(new JSONObject()
                    .put("id", "archived-fixture").put("title", "Archived fixture").put("archivedAt", 1700000000000L)));
                int offset = Integer.parseInt(android.net.Uri.parse("http://fixture" + path).getQueryParameter("offset"));
                JSONArray result = new JSONArray(); int end = Math.min(entries.length(), offset + 100);
                for (int index = offset; index < end; index++) result.put(entries.getJSONObject(index));
                return new JSONObject().put("protocol", 1).put("permission", "control").put("capabilities", new JSONArray())
                    .put("workspaces", workspaces).put("includeUnassigned", true).put("conversations", result)
                    .put("nextOffset", end < entries.length() ? end : JSONObject.NULL);
            } catch (Exception error) { throw new java.io.IOException(error); }
        }
        @Override public void cancel() { cancelled = true; }
    }

    private void invokeLoadList(boolean append) throws Exception { var method=MainActivity.class.getDeclaredMethod("loadList", boolean.class); method.setAccessible(true); method.invoke(main, append); }

    public void testLocalListKeepsItsGroupsSearchToolbarScrollAndDraftsWhenSwitching() throws Exception {
        if (!wide()) return;
        var context = getInstrumentation().getTargetContext(); LocalChatFixture.clear(context);
        LocalChatFixture fixture = new LocalChatFixture(context);
        JSONObject workspace = fixture.createWorkspace("Local Camellia"); String workspaceId = workspace.getString("id");
        fixture.createWorkspace("Empty local workspace");
        List<String> ids = new ArrayList<>();
        for (int index = 0; index < 15; index++) {
            JSONObject row = fixture.createConversation(workspaceId, ""); row.put("title", "Local " + index); ids.add(row.getString("id"));
        }
        fixture.save();
        local = (LocalChatActivity) LocalChatFixture.start(getInstrumentation(), new Intent(context, LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        await(() -> find(local.getWindow().getDecorView(), "localConversation:" + ids.get(0)) != null, "Local list must load");
        View pane = pane(local); assertNotNull(pane);
        assertNotNull(find(pane, "localNewWorkspace")); assertNotNull(find(pane, "localNewStandalone"));
        ScrollView scroll = listScroll(pane); ui(() -> scroll.scrollTo(0, 300)); settle();
        int y = scroll.getScrollY(), width = pane.getWidth(); List<String> before = textSnapshot(pane), order = rowTags(pane, "localConversation:");
        capture("local-before-open");
        ui(() -> find(pane, "localConversation:" + ids.get(0)).performClick());
        await(() -> find(local.getWindow().getDecorView(), "localComposer") != null, "Local editor must load"); settle();
        assertSame(pane, pane(local)); assertEquals(width, pane.getWidth()); assertEquals(y, scroll.getScrollY());
        assertEquals(before, textSnapshot(pane)); assertEquals(order, rowTags(pane, "localConversation:"));
        capture("local-after-open");
        ui(() -> ((EditText) find(local.getWindow().getDecorView(), "localComposer")).setText("local unsent draft"));
        ui(() -> find(pane, "localConversation:" + ids.get(1)).performClick());
        await(() -> ids.get(1).equals(field(local, "conversationId")) && find(local.getWindow().getDecorView(), "localComposer") != null, "Second local chat must load");
        assertSame(pane, pane(local)); assertEquals(y, scroll.getScrollY());
        ui(() -> find(pane, "localConversation:" + ids.get(0)).performClick());
        await(() -> find(local.getWindow().getDecorView(), "localComposer") instanceof EditText
            && "local unsent draft".contentEquals(((EditText) find(local.getWindow().getDecorView(), "localComposer")).getText()), "Local draft must restore");
        ui(() -> ((EditText) find(pane, "localSearch")).setText("Local 1"));
        assertEquals(ids.get(0), field(local, "conversationId")); assertTrue(rowTags(pane, "localConversation:").size() < 15);
        assertEquals("Local 1", ((EditText) find(pane, "localSearch")).getText().toString());
    }

    private void openRemote(int index) throws Exception {
        ui(() -> { find(pane(main), "conversation:" + id(index)).performClick(); invoke(main, "stopNetwork"); }); settle();
    }
    private String id(int index) { return String.format(java.util.Locale.ROOT, "10000000-0000-0000-0000-%012d", index); }
    private boolean wide() { return MobileLayout.useTabletRail(main.getResources().getConfiguration()); }
    private View pane(Activity activity) {
        View root = activity.getWindow().getDecorView(), pane = find(root, "conversationListPane");
        if (pane != null) return pane;
        // Also run against the old APK to prove that selection replaces its list.
        for (String tag : new String[]{"tabletSessionListSplit", "tabletLocalListSplit"}) {
            View split = find(root, tag); if (split instanceof ViewGroup) return ((ViewGroup) split).getChildAt(0);
        }
        return find(root, "detailConversationSidebar");
    }
    private View find(View root, String tag) { return root == null ? null : root.findViewWithTag(tag); }
    private ScrollView listScroll(View root) { if (root instanceof ScrollView) return (ScrollView) root; if (root instanceof ViewGroup) for (int i=0;i<((ViewGroup)root).getChildCount();i++) { ScrollView found=listScroll(((ViewGroup)root).getChildAt(i)); if(found!=null)return found; } return null; }
    private List<String> textSnapshot(View view) { List<String> result=new ArrayList<>(); collectText(view,result); return result; }
    private void collectText(View view, List<String> into) { if(view instanceof TextView) into.add(((TextView)view).getText().toString()); if(view instanceof ViewGroup) for(int i=0;i<((ViewGroup)view).getChildCount();i++)collectText(((ViewGroup)view).getChildAt(i),into); }
    private List<String> rowTags(View view, String prefix) { List<String> result=new ArrayList<>(); collectTags(view,prefix,result); return result; }
    private void collectTags(View view,String prefix,List<String> into) { if(view.getTag() instanceof String && ((String)view.getTag()).startsWith(prefix))into.add((String)view.getTag()); if(view instanceof ViewGroup)for(int i=0;i<((ViewGroup)view).getChildCount();i++)collectTags(((ViewGroup)view).getChildAt(i),prefix,into); }
    private Object field(Object target,String name) throws Exception { var f=target.getClass().getDeclaredField(name); f.setAccessible(true); return f.get(target); }
    private void set(Object target,String name,Object value) throws Exception { var f=target.getClass().getDeclaredField(name); f.setAccessible(true); f.set(target,value); }
    private void invoke(Object target,String name) throws Exception { var m=target.getClass().getDeclaredMethod(name); m.setAccessible(true); m.invoke(target); }
    private interface Check { boolean run() throws Exception; }
    private interface Step { void run() throws Exception; }
    private void ui(Step step) { Throwable[] error={null}; getInstrumentation().runOnMainSync(() -> {try{step.run();}catch(Throwable e){error[0]=e;}}); getInstrumentation().waitForIdleSync(); if(error[0]!=null)throw new AssertionError(error[0]); }
    private void settle() { android.os.SystemClock.sleep(120); getInstrumentation().waitForIdleSync(); }
    private void await(Check check,String message) throws Exception { long deadline=android.os.SystemClock.uptimeMillis()+6000; while(!check.run()&&android.os.SystemClock.uptimeMillis()<deadline){android.os.SystemClock.sleep(40);getInstrumentation().waitForIdleSync();} assertTrue(message,check.run()); }
    private void capture(String name) throws Exception { android.graphics.Bitmap bitmap=getInstrumentation().getUiAutomation().takeScreenshot(); try(var out=new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null),name+".png"))){bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,out);}finally{bitmap.recycle();} }
}
