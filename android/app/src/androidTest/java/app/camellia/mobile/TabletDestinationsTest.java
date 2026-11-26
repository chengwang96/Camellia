package app.camellia.mobile;

import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Map;

/** Native layout and action ownership; all credentials belong to this disposable test device. */
public class TabletDestinationsTest extends InstrumentationTestCase {
    private MainActivity activity;
    private static final String HP = "http://100.80.1.7:43127", CUHK = "http://100.80.1.8:43128";
    private String previousLanguage, previousTheme;

    @Override protected void setUp() throws Exception {
        super.setUp(); var context = getInstrumentation().getTargetContext();
        previousLanguage = MobilePreferences.get(context, "language");
        var arguments = ((android.test.InstrumentationTestRunner) getInstrumentation()).getArguments();
        MobilePreferences.set(context, "language", arguments.getString("language", "zh-CN"));
        previousTheme = MobilePreferences.get(context, "theme");
        boolean night = (context.getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
            == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        MobilePreferences.set(context, "theme", night ? "dark" : "light");
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false); new CredentialStore(context).clear();
        ComputerStore store = new ComputerStore(new CredentialStore(context));
        store.save(computer(CUHK, "CUHK")); store.save(computer(HP, "HP"));
        NativeActivityCleanup.prepareTabletLandscape(getInstrumentation());
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().waitForIdleSync();
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            var bounds = activity.getWindowManager().getMaximumWindowMetrics().getBounds();
            if (!MobileOrientation.isPhoneSize(bounds.width(), bounds.height(), activity.getResources().getDisplayMetrics().density)) {
                getInstrumentation().runOnMainSync(() -> activity.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
                long deadline = android.os.SystemClock.uptimeMillis() + 6000;
                while (!wide() && android.os.SystemClock.uptimeMillis() < deadline) { android.os.SystemClock.sleep(50); getInstrumentation().waitForIdleSync(); }
                assertTrue("Tablet destination checks must run in a real wide window", wide());
            }
        }
        getInstrumentation().runOnMainSync(() -> {
            try { set("foreground", false); invoke("stopNetwork"); } catch (Exception error) { throw new AssertionError(error); }
        });
    }

    @Override protected void tearDown() throws Exception {
        if (activity != null) {
            getInstrumentation().runOnMainSync(() -> activity.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED));
            NativeActivityCleanup.finish(getInstrumentation(), activity);
        }
        getInstrumentation().waitForIdleSync(); var context = getInstrumentation().getTargetContext();
        for (JSONObject computer : new JSONObject[]{computer(HP, "HP"), computer(CUHK, "CUHK")}) {
            RemoteListCache.workbench(context).remove(computer); RemoteListCache.get(context).remove(computer);
        }
        new CredentialStore(context).clear(); MobilePreferences.set(context, "language", previousLanguage);
        MobilePreferences.set(context, "theme", previousTheme);
        super.tearDown();
    }

    public void testWorkbenchUsesTwoIndependentColumnsAndRail() throws Exception {
        if (!wide()) return;
        ui(() -> invoke("homeScreen"));
        assertNotNull(find("tabletNavigation")); assertNotNull(find("tabletHomeColumns"));
        assertNotNull(find("tabletHomeRecent")); assertNull(find("workbenchNav")); capture("native-workbench");
    }

    public void testRecentExpandsInPlaceToThirtyAndCollapsesOnPhonesAndTablets() throws Exception {
        seedHome(40);
        assertEquals(3, recentCount());
        String selected = ((JSONObject) field("credentials")).optString("address");
        ui(() -> find("homeRecentAll").performClick());
        assertEquals("home", field("screen")); assertEquals(30, recentCount());
        assertEquals((boolean) field("chinese") ? "收起" : "Collapse", ((TextView) find("homeRecentAll")).getText().toString());
        assertEquals(selected, ((JSONObject) field("credentials")).optString("address"));
        ui(() -> invoke("updateHomeConversations"));
        assertEquals(30, recentCount());
        capture(wide() ? "native-workbench-recent-expanded" : "native-phone-recent-expanded");
        ui(() -> find("homeRecentAll").performClick());
        assertEquals("home", field("screen")); assertEquals(3, recentCount());
        assertEquals((boolean) field("chinese") ? "展开更多" : "Show more", ((TextView) find("homeRecentAll")).getText().toString());
        capture(wide() ? "native-workbench-recent-collapsed" : "native-phone-recent-collapsed");
    }

    public void testWorkbenchHeadingsAndFirstCardsShareTheSameHeight() throws Exception {
        if (!wide()) return;
        seedHome(40);
        assertHomeAlignment();
        ui(() -> find("homeRecentAll").performClick()); assertHomeAlignment();
        ui(() -> find("homeRecentAll").performClick()); assertHomeAlignment();
        seedHome(2); assertNull(find("homeRecentAll")); assertHomeAlignment();
    }

    public void testFourMainDestinationsSwitchWithoutSliding() throws Exception {
        for (String destination : new String[]{"sessions", "computers", "home"}) {
            ui(() -> {
                find("nav:" + destination).performClick(); invoke("stopNetwork");
                PageTransitions pages = (PageTransitions) field("pages");
                assertEquals(1, pages.getChildCount()); assertEquals(0f, pages.getChildAt(0).getTranslationX());
            });
        }
        if (!wide()) {
            ui(() -> {
                find("nav:settings").performClick();
                PageTransitions pages = (PageTransitions) field("pages");
                assertEquals(1, pages.getChildCount()); assertEquals(0f, pages.getChildAt(0).getTranslationX());
            });
            assertEquals("settings", field("screen")); return;
        }
        var monitor = getInstrumentation().addMonitor(SettingsActivity.class.getName(), null, false);
        SettingsActivity settings = null;
        try {
            ui(() -> find("nav:settings").performClick());
            settings = (SettingsActivity) monitor.waitForActivityWithTimeout(5000); assertNotNull(settings);
            getInstrumentation().waitForIdleSync();
            long readyDeadline = android.os.SystemClock.uptimeMillis() + 6000;
            while ((!settings.hasWindowFocus() || settings.getWindow().getDecorView().findViewWithTag("nav:computers") == null)
                && android.os.SystemClock.uptimeMillis() < readyDeadline) { android.os.SystemClock.sleep(30); getInstrumentation().waitForIdleSync(); }
            assertNotNull("Settings rail must be attached before clicking", settings.getWindow().getDecorView().findViewWithTag("nav:computers"));
            assertTrue(settings.getIntent().getBooleanExtra(PageTransitions.MAIN_DESTINATION, false));
            assertTrue((settings.getIntent().getFlags() & Intent.FLAG_ACTIVITY_NO_ANIMATION) != 0);
            SettingsActivity opened = settings;
            ui(() -> opened.getWindow().getDecorView().findViewWithTag("nav:computers").performClick());
            long deadline = android.os.SystemClock.uptimeMillis() + 5000;
            while ((!settings.isFinishing() || !activity.hasWindowFocus() || !"computers".equals(field("screen")))
                && android.os.SystemClock.uptimeMillis() < deadline) {
                android.os.SystemClock.sleep(30); getInstrumentation().waitForIdleSync();
            }
            assertTrue(settings.isFinishing()); getInstrumentation().waitForIdleSync();
            assertEquals("computers", field("screen"));
            ui(() -> {
                PageTransitions pages = (PageTransitions) field("pages");
                assertEquals(1, pages.getChildCount()); assertEquals(0f, pages.getChildAt(0).getTranslationX());
            });
        } finally {
            getInstrumentation().removeMonitor(monitor);
            NativeActivityCleanup.finish(getInstrumentation(), settings);
        }
    }

    private void seedHome(int recent) throws Exception {
        JSONObject hp = computer(HP, "HP"), other = computer(CUHK, "CUHK");
        RemoteListCache cache = RemoteListCache.workbench(activity); cache.remove(hp); cache.remove(other);
        JSONArray rows = new JSONArray();
        rows.put(new JSONObject().put("id", "running").put("title", "进行中的任务").put("engine", "codex")
            .put("activity", "running").put("updatedAt", 1000));
        for (int i = 0; i < recent; i++) rows.put(new JSONObject().put("id", "recent-" + i)
            .put("title", "最近的会话 " + (i + 1)).put("engine", "codex").put("modelName", "GPT-6.1-Sol")
            .put("activity", "idle").put("updatedAt", 900 - i));
        cache.put(hp, rows, -1, new JSONArray(), true);
        ui(() -> { set("homeRecentExpanded", false); set("tabletHomeActiveY", 0); set("tabletHomeRecentY", 0); invoke("homeScreen"); });
    }

    private int recentCount() { return countRows(activity.getWindow().getDecorView()); }
    private int countRows(View view) {
        int count = view.getTag() instanceof String && ((String) view.getTag()).startsWith("homeRecent:") ? 1 : 0;
        if (view instanceof android.view.ViewGroup) {
            var group = (android.view.ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) count += countRows(group.getChildAt(i));
        }
        return count;
    }
    private void assertHomeAlignment() {
        TextView active = (TextView) find("homeRunningTitle"), recent = (TextView) find("homeRecentTitle");
        int[] left = new int[2], right = new int[2]; active.getLocationOnScreen(left); recent.getLocationOnScreen(right);
        assertEquals("Heading baselines", left[1] + active.getBaseline(), right[1] + recent.getBaseline());
        find("homeActive:" + HP + "#running").getLocationOnScreen(left);
        find("homeRecent:" + HP + "#recent-0").getLocationOnScreen(right);
        assertEquals("First cards", left[1], right[1]);
    }

    public void testSelectingComputerDoesNotChangeTheActiveProfile() throws Exception {
        if (!wide()) return;
        ui(() -> {
            boolean zh = (boolean) field("chinese");
            ((Map<String, String>) field("computerStates")).put(HP, zh ? "已连接" : "Connected");
            ((Map<String, String>) field("computerStates")).put(CUHK, zh ? "已连接" : "Connected");
            ((Map<String, String>) field("computerRoutes")).put(HP, zh ? "直连 · 点对点" : "Direct · Peer to peer");
            ((Map<String, String>) field("computerRoutes")).put(CUHK, zh ? "公网中继 · DERP SIN" : "Public relay · DERP SIN");
            JSONObject info = new JSONObject().put("permission", "control").put("capabilities", new JSONArray().put("desktop-restart"));
            ((Map<String, JSONObject>) field("computerInformation")).put(HP, info);
            ((Map<String, JSONObject>) field("computerInformation")).put(CUHK, info);
            invoke("computersScreen");
        });
        String original = ((JSONObject) field("credentials")).optString("address");
        ui(() -> find("tabletDevice:" + CUHK).performClick());
        assertEquals(CUHK, field("tabletComputerAddress"));
        assertEquals(original, ((JSONObject) field("credentials")).optString("address"));
        assertEquals("DERP SIN", ((TextView) find("tabletConnectionPath")).getText().toString());
        ui(() -> find("tabletDevice:" + HP).performClick()); capture("native-computers");
        assertSameBaseline("tabletConnectionTitle", "tabletConnectionTest");
        if (bounds(find("tabletConnectionMethodLabel")).top == bounds(find("tabletConnectionPathLabel")).top) {
            assertSameBaseline("tabletConnectionMethodLabel", "tabletConnectionPathLabel");
            assertSameBaseline("tabletConnectionMethodLabel", "tabletComputerPermissionLabel");
            assertSameBaseline("tabletConnectionMethod", "tabletConnectionPath");
        } else {
            assertAlignedRow("tabletConnectionMethodLabel", "tabletConnectionMethod");
            assertAlignedRow("tabletConnectionPathLabel", "tabletConnectionPath");
            assertAlignedRow("tabletComputerPermissionLabel", "tabletComputerPermission");
            assertTrue(bounds(find("tabletConnectionMethodLabel")).bottom <= bounds(find("tabletConnectionPathLabel")).top);
            assertTrue(bounds(find("tabletConnectionPathLabel")).bottom <= bounds(find("tabletComputerPermissionLabel")).top);
        }
        assertEquals("编辑备注", ((TextView) find("tabletComputerRenameTitle")).getText().toString());
        assertTrue(bounds(find("tabletComputerRenameTitle")).bottom <= bounds(find("tabletComputerRenameDescription")).top);
        ui(() -> find("tabletComputerMore").performClick());
        assertTrue(find("tabletComputerRestart").isEnabled());
        capture("native-computers-expanded");
        ui(() -> {
            ((Map<String, String>) field("computerStates")).put(HP, (boolean) field("chinese") ? "网络暂不可用" : "Network unavailable");
            ((TabletComputerPane) field("tabletComputerPane")).update(HP);
        });
        assertFalse(find("tabletComputerRestart").isEnabled());
        assertEquals((boolean) field("chinese") ? "待确认" : "Unconfirmed", ((TextView) find("tabletConnectionPath")).getText().toString());
        capture("native-computers-offline");
    }

    public void testComputerActionTitlesFitWithLongNamesInCompactWindows() throws Exception {
        if (!wide()) return;
        String longName = "Research workstation with an exceptionally long display name";
        new ComputerStore(new CredentialStore(activity)).save(computer(HP, longName));
        ui(() -> { set("tabletComputerAddress", HP); invoke("computersScreen"); });
        for (String tag : new String[]{"tabletComputerRenameTitle"}) {
            TextView title = (TextView) find(tag); assertNotNull(title.getLayout());
            assertEquals("Primary action title must remain readable: " + title.getText(), 0, title.getLayout().getEllipsisCount(0));
            assertTrue("Action text must fit vertically", title.getHeight() >= title.getLayout().getHeight());
        }
        assertNavigationLabelsFit(find("tabletNavigation"));
        for (String tag : new String[]{"tabletConnectionMethod", "tabletConnectionPath"}) {
            TextView value = (TextView) find(tag);
            assertEquals("Connection values must not break inside a single word: " + value.getText(), 1, value.getLineCount());
        }
        View rename = find("tabletComputerRename");
        assertTrue("The remark action must remain visible", rename.getWidth() > 0 && rename.getHeight() > 0);
        capture("native-computer-compact-audit");
    }

    public void testConnectionPreferenceSurvivesRediscoveryAfterTurningLanOff() throws Exception {
        if (!wide()) return;
        String lan = "https://192.168.3.8:43129", identity = "tablet-route-fixture", fingerprint = "b".repeat(64);
        ComputerStore store = new ComputerStore(new CredentialStore(activity));
        JSONObject paired = computer(HP, "HP").put("computerId", identity).put("lanAddress", lan)
            .put("lanFingerprint", fingerprint).put("activeTransport", ComputerRoutes.LAN).put("lanPaired", true);
        LanDiscovery.Service service = new LanDiscovery.Service("fixture", identity, "HP", lan, fingerprint, false);
        ui(() -> {
            store.save(paired);
            ((java.util.List<LanDiscovery.Service>) field("lanServices")).add(service);
            set("tabletComputerAddress", HP);
            invoke("computersScreen");
            find("tabletComputerMore").performClick();
            assertNull(find("tabletComputerLanPin"));
            find("tabletComputerConnectionSettings").performClick();
            android.app.Dialog dialog = (android.app.Dialog) field("computerDialog");
            android.widget.Switch automatic = dialog.findViewById(android.R.id.content).findViewWithTag("manageAutoLan");
            assertTrue(automatic.isChecked());
            assertEquals(lan, ComputerRoutes.route(HP).url);
            automatic.performClick();
            assertEquals(HP, ComputerRoutes.route(HP).url);
            assertFalse(store.findByComputerId(identity).getBoolean("lanPreferred"));
            ((java.util.List<LanDiscovery.Service>) field("lanServices")).add(service);
            invoke("applyLanRoutes");
            assertEquals(HP, ComputerRoutes.route(HP).url);
            assertEquals(ComputerRoutes.TAILSCALE, store.findByComputerId(identity).getString("activeTransport"));

            automatic.performClick();
            assertEquals(lan, ComputerRoutes.route(HP).url);
            ((java.util.List<?>) field("lanServices")).clear();
            invoke("applyLanRoutes");
            assertEquals(HP, ComputerRoutes.route(HP).url);
            assertTrue(store.findByComputerId(identity).getBoolean("lanPreferred"));
            dialog.dismiss();
        });
    }

    private void assertNavigationLabelsFit(View view) {
        if (view instanceof TextView) {
            TextView label = (TextView) view;
            float available = label.getWidth() - label.getCompoundPaddingLeft() - label.getCompoundPaddingRight();
            assertTrue("Navigation label must remain fully readable: " + label.getText(), label.getPaint().measureText(label.getText().toString()) <= available + 1);
        }
        if (view instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) assertNavigationLabelsFit(group.getChildAt(index));
        }
    }

    public void testDeviceSelectionAndExpansionSurviveRebuild() throws Exception {
        if (!wide()) return;
        ui(() -> { invoke("computersScreen"); find("tabletDevice:" + CUHK).performClick(); find("tabletComputerMore").performClick(); invoke("computersScreen"); });
        assertTrue(find("tabletDevice:" + CUHK).isSelected());
        assertNotNull(find("tabletComputerForget"));
    }

    public void testSessionsKeepRealListInTheMasterPane() throws Exception {
        if (!wide()) return;
        ui(() -> invoke("listScreen"));
        assertNotNull("Master/detail shell", find("tabletSessionListSplit")); assertNotNull("Real conversation filters", find("conversationFilters"));
        assertNotNull(find("remoteComputerPicker")); capture("native-session-list");
    }

    public void testSettingsReuseTheExistingFormsWithCategories() throws Exception {
        if (!wide()) return;
        var context = getInstrumentation().getTargetContext();
        SettingsActivity settings = (SettingsActivity) getInstrumentation().startActivitySync(new Intent(context, SettingsActivity.class)
            .putExtra("section", "reading").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            long deadline = android.os.SystemClock.uptimeMillis() + 6000;
            while (settings.getWindow().getDecorView().findViewWithTag("readingPreview") == null && android.os.SystemClock.uptimeMillis() < deadline) {
                android.os.SystemClock.sleep(50); getInstrumentation().waitForIdleSync();
            }
            View root = settings.getWindow().getDecorView();
            assertNotNull(root.findViewWithTag("tabletSettingsCategories")); assertNotNull(root.findViewWithTag("readingPreview"));
            View fontRow = root.findViewWithTag("preference:chatFontSize");
            View fontTitle = fontRow.findViewWithTag(SettingsStyle.ROW_TITLE), fontValue = fontRow.findViewWithTag(SettingsStyle.ROW_VALUE);
            assertTrue("Inline preference must keep its title visible", fontTitle.getWidth() > 60);
            assertTrue("Preference title and value must not overlap", fontTitle.getRight() <= fontValue.getLeft() + 1);
            getInstrumentation().runOnMainSync(() -> root.findViewWithTag("tabletSettings:notifications").performClick());
            getInstrumentation().waitForIdleSync();
            assertNotNull(settings.getWindow().getDecorView().findViewWithTag("preference:chatNotifications"));
            getInstrumentation().runOnMainSync(() -> settings.getWindow().getDecorView().findViewWithTag("tabletSettings:reading").performClick());
            getInstrumentation().waitForIdleSync(); capture("native-settings");
        } finally { NativeActivityCleanup.finish(getInstrumentation(), settings); }
    }

    public void testLocalListSharesTheTabletShell() throws Exception {
        if (!wide()) return;
        var context = getInstrumentation().getTargetContext();
        LocalChatActivity local = (LocalChatActivity) getInstrumentation().startActivitySync(new Intent(context, LocalChatActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            assertNotNull(local.getWindow().getDecorView().findViewWithTag("tabletNavigation"));
            assertNotNull(local.getWindow().getDecorView().findViewWithTag("tabletLocalListSplit"));
        } finally { NativeActivityCleanup.finish(getInstrumentation(), local); }
    }

    public void testSidebarFilteringAndFocusModePreserveDraftAndConversation() throws Exception {
        if (!wide()) return;
        JSONObject computer = (JSONObject) field("credentials");
        String id = "a0000000-0000-0000-0000-000000000001";
        JSONArray rows = new JSONArray().put(new JSONObject().put("id", id).put("title", "布局设计")
            .put("engine", "codex").put("activity", "idle").put("workspaceName", "Camellia"));
        RemoteListCache.get(activity).put(computer, rows, -1, new JSONArray(), true);
        ui(() -> {
            set("conversationId", id); set("conversationTitle", "布局设计"); invoke("detailScreen");
            ((android.widget.EditText) field("composer")).setText("筛选与专注模式都保留的草稿");
            ((android.widget.EditText) find("remoteSearchInput")).setText("没有匹配项");
        });
        assertEquals(id, field("conversationId"));
        assertEquals("筛选与专注模式都保留的草稿", ((android.widget.EditText) field("composer")).getText().toString());
        ui(() -> { find("remoteSearchClose").performClick(); find("tabletToggleSidebar").performClick(); });
        assertEquals(View.GONE, find("conversationListPane").getVisibility());
        ui(() -> find("tabletToggleSidebar").performClick());
        assertEquals(View.VISIBLE, find("conversationListPane").getVisibility());
        capture("native-chat");
    }

    public void testKeyboardKeepsSplitAndComposerVisible() throws Exception {
        if (!wide()) return;
        ui(() -> {
            set("conversationId", "b0000000-0000-0000-0000-000000000001"); set("conversationTitle", "键盘布局检查"); invoke("detailScreen");
            android.widget.EditText composer = (android.widget.EditText) field("composer");
            composer.setEnabled(true); composer.requestFocus();
            ((android.view.inputmethod.InputMethodManager) activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE))
                .showSoftInput(composer, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
        });
        android.os.SystemClock.sleep(1200); getInstrumentation().waitForIdleSync();
        android.graphics.Rect visible = new android.graphics.Rect(); activity.getWindow().getDecorView().getWindowVisibleDisplayFrame(visible);
        android.widget.EditText composer = (android.widget.EditText) field("composer"); int[] position = new int[2]; composer.getLocationOnScreen(position);
        capture("native-chat-keyboard");
        assertTrue("Composer must remain above the keyboard: composerBottom=" + (position[1] + composer.getHeight()) + ", visibleBottom=" + visible.bottom,
            position[1] + composer.getHeight() <= visible.bottom + 2);
        assertNotNull(find("tabletNavigation")); assertEquals(View.VISIBLE, find("conversationListPane").getVisibility());
        capture("native-chat-keyboard");
        ui(() -> ((android.view.inputmethod.InputMethodManager) activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE))
            .hideSoftInputFromWindow(composer.getWindowToken(), 0));
    }

    private JSONObject computer(String address, String name) throws Exception { return new JSONObject().put("address", address).put("computerName", name).put("token", "a".repeat(43)); }
    private android.graphics.Rect bounds(View view) {
        int[] location = new int[2]; view.getLocationOnScreen(location);
        return new android.graphics.Rect(location[0], location[1], location[0] + view.getWidth(), location[1] + view.getHeight());
    }
    private void assertAlignedRow(String label, String value) {
        android.graphics.Rect left = bounds(find(label)), right = bounds(find(value));
        assertTrue("Metric labels and values must not overlap", left.right <= right.left);
        assertTrue("Each stacked metric must remain vertically aligned", Math.abs(left.centerY() - right.centerY()) <= 4 * activity.getResources().getDisplayMetrics().density);
    }
    private void assertSameBaseline(String leftTag, String rightTag) {
        TextView left = (TextView) find(leftTag), right = (TextView) find(rightTag); int[] a = new int[2], b = new int[2];
        left.getLocationOnScreen(a); right.getLocationOnScreen(b);
        assertEquals(leftTag + " and " + rightTag + " baselines", a[1] + left.getBaseline(), b[1] + right.getBaseline());
    }
    private boolean wide() { return MobileLayout.useTabletRail(activity.getResources().getConfiguration()); }
    private View find(String tag) { return activity.getWindow().getDecorView().findViewWithTag(tag); }
    private Object field(String name) throws Exception { var f = MainActivity.class.getDeclaredField(name); f.setAccessible(true); return f.get(activity); }
    private void set(String name, Object value) throws Exception { var f = MainActivity.class.getDeclaredField(name); f.setAccessible(true); f.set(activity, value); }
    private void invoke(String name) throws Exception { var m = MainActivity.class.getDeclaredMethod(name); m.setAccessible(true); m.invoke(activity); }
    private interface Step { void run() throws Exception; }
    private void ui(Step step) { getInstrumentation().runOnMainSync(() -> { try { step.run(); } catch (Exception error) { throw new AssertionError(error); } }); getInstrumentation().waitForIdleSync(); }
    private void capture(String name) throws Exception {
        android.os.SystemClock.sleep(450); getInstrumentation().waitForIdleSync();
        android.graphics.Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull(image); java.io.File file = new java.io.File(activity.getExternalFilesDir(null), name + ".png");
        try (var output = new java.io.FileOutputStream(file)) { image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output); }
        image.recycle();
    }
}
