package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import org.json.JSONArray;
import org.json.JSONObject;

/** Captures the four refreshed surfaces for manual visual review. */
public class WorkbenchVisualCaptureTest extends InstrumentationTestCase {
    private static final String ADDRESS = "http://100.64.0.10:43127";

    @Override protected void setUp() throws Exception {
        super.setUp();
        EmbeddedNetwork.initialize(getInstrumentation().getTargetContext());
        EmbeddedNetwork.setEnabled(false);
        new CredentialStore(getInstrumentation().getTargetContext()).clear();
    }

    @Override protected void tearDown() throws Exception {
        var context = getInstrumentation().getTargetContext();
        new CredentialStore(context).clear();
        super.tearDown();
    }

    public void testCaptureAllWorkbenchSurfaces() throws Exception {
        for (String language : new String[]{"zh-CN", "en"}) {
            for (String theme : new String[]{"light", "dark"}) {
                MobilePreferences.set(getInstrumentation().getTargetContext(), "language", language);
                MobilePreferences.set(getInstrumentation().getTargetContext(), "theme", theme);
                seed();
                activity = getInstrumentation().startActivitySync(new Intent(
                    getInstrumentation().getTargetContext(), MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                try {
                    waitForPage();
                    screenshot(activity, "home", language, theme);
                    ui(() -> {
                        Object scroll = field(activity, "scroll");
                        if (scroll instanceof android.widget.ScrollView) {
                            ((android.widget.ScrollView) scroll).fullScroll(android.view.View.FOCUS_DOWN);
                        }
                    });
                    waitForPage();
                    screenshot(activity, "home-recents", language, theme);
                    ui(() -> {
                        Object scroll = field(activity, "scroll");
                        if (scroll instanceof android.widget.ScrollView) {
                            ((android.widget.ScrollView) scroll).fullScroll(android.view.View.FOCUS_UP);
                        }
                    });
                    ui(() -> {
                        invoke(activity, "listScreen");
                        field(activity, "listLoaded", true);
                        field(activity, "listLoadFailed", false);
                        field(activity, "canCreate", true);
                        field(activity, "canCreateWorkspace", true);
                        field(activity, "allowIndependent", true);
                        field(activity, "canDiscussions", false);
                        field(activity, "availableWorkspaces", new JSONArray().put(
                            new JSONObject().put("id", "workspace").put("name", "Camellia Mobile")));
                        @SuppressWarnings("unchecked") java.util.Map<String, JSONObject> rows =
                            (java.util.Map<String, JSONObject>) field(activity, "conversations");
                        rows.clear();
                        rows.put("11111111-1111-1111-1111-111111111111", conversation(
                            "11111111-1111-1111-1111-111111111111", "修复移动端消息队列", "running", "codex",
                            "queue-regression.test.js", true));
                        rows.put("22222222-2222-2222-2222-222222222222", conversation(
                            "22222222-2222-2222-2222-222222222222", "检查 API 用量异常", "permission", "dsh",
                            "", false));
                        rows.put("33333333-3333-3333-3333-333333333333", conversation(
                            "33333333-3333-3333-3333-333333333333", "整理本周发布说明", "idle", "antigravity",
                            "release-notes.md", false));
                        invoke(activity, "renderConversations");
                    });
                    waitForPage();
                    screenshot(activity, "sessions", language, theme);
                    ui(() -> {
                        field(activity, "conversationId", "11111111-1111-1111-1111-111111111111");
                        field(activity, "conversationTitle", "修复移动端消息队列");
                        invoke(activity, "detailScreen");
                        field(activity, "connected", true);
                        field(activity, "controlAllowed", true);
                        try {
                            field(activity, "remoteSettings", new JSONObject()
                                .put("model", "gpt-5.6-sol").put("thinking", "high")
                                .put("permissionMode", "ask").put("editable", true));
                            JSONObject shown = new JSONObject().put("id", "11111111-1111-1111-1111-111111111111")
                                .put("title", "修复移动端消息队列").put("currentEngine", "codex")
                                .put("activity", "running").put("seq", 2);
                            field(activity, "displayedConversation", shown);
                            @SuppressWarnings("unchecked") java.util.Map<Long, JSONObject> history =
                                (java.util.Map<Long, JSONObject>) field(activity, "history");
                            history.clear();
                            history.put(1L, new JSONObject().put("seq", 1).put("role", "user")
                                .put("text", "把重复提交也一起修掉，补一个回归测试。"));
                            history.put(2L, new JSONObject().put("seq", 2).put("role", "assistant")
                                .put("text", "已经修好。请求返回前会先锁定按钮，异步失败也会恢复。\n\n"
                                    + "队列顺序、草稿和未确认命令都保持不变。\n\n"
                                    + "已生成 `queue-regression.test.js`。")
                                .put("process", new JSONArray().put(new JSONObject().put("type", "tool")
                                    .put("title", "Shell").put("text", "npm test").put("status", "completed")))
                                .put("at", System.currentTimeMillis()));
                            field(activity, "conversationSeq", 2L);
                            invoke(activity, "renderMessages", new Class<?>[]{JSONObject.class}, new Object[]{null});
                            invoke(activity, "updateControls");
                        } catch (Exception error) { throw new AssertionError(error); }
                    });
                    waitForPage();
                    screenshot(activity, "chat", language, theme);
                    ui(() -> invoke(activity, "pickImage"));
                    waitForPage();
                    screenshot(activity, "attachments", language, theme);
                    ui(() -> {
                        Object dialog = field(activity, "computerDialog");
                        if (dialog instanceof android.app.Dialog) ((android.app.Dialog) dialog).dismiss();
                    });
                    ui(() -> invoke(activity, "settingsScreen"));
                    waitForPage();
                    screenshot(activity, "settings", language, theme);
                    Activity general = getInstrumentation().startActivitySync(new Intent(
                        getInstrumentation().getTargetContext(), SettingsActivity.class)
                        .putExtra("section", "general").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    try {
                        waitForPage();
                        screenshot(general, "settings-general", language, theme);
                    } finally {
                        ui(general::finish);
                        getInstrumentation().waitForIdleSync();
                    }
                } finally {
                    ui(activity::finish);
                    getInstrumentation().waitForIdleSync();
                }
            }
        }
    }

    private void seed() throws Exception {
        var context = getInstrumentation().getTargetContext();
        CredentialStore store = new CredentialStore(context);
        ComputerStore computers = new ComputerStore(store);
        JSONObject computer = new JSONObject().put("address", ADDRESS)
            .put("token", "a".repeat(43)).put("deviceId", "visual-qa")
            .put("computerName", "研究电脑");
        computers.save(computer);
        JSONArray rows = new JSONArray()
            .put(conversation("11111111-1111-1111-1111-111111111111", "修复移动端消息队列", "running", "codex", "queue-regression.test.js", true))
            .put(conversation("22222222-2222-2222-2222-222222222222", "检查 API 用量异常", "permission", "dsh", "", false))
            .put(conversation("33333333-3333-3333-3333-333333333333", "整理本周发布说明", "idle", "antigravity", "release-notes.md", false));
        RemoteListCache.get(context).put(computer, rows, -1, new JSONArray(), true);
    }

    private JSONObject conversation(String id, String title, String activity, String engine,
                                    String file, boolean pinned) throws Exception {
        JSONObject conversation = new JSONObject().put("id", id).put("title", title)
            .put("activity", activity).put("currentEngine", engine)
            .put("workspaceId", "workspace").put("workspaceName", "Camellia Mobile")
            .put("updatedAt", System.currentTimeMillis() - 12 * 60_000L)
            .put("pinned", pinned).put("seq", 2);
        if (!file.isEmpty()) conversation.put("filePreview", new JSONObject().put("name", file).put("count", 2));
        return conversation;
    }

    private void screenshot(Activity activity, String screen, String language, String theme) throws Exception {
        // Let the page transition and compositor settle before capturing.
        android.os.SystemClock.sleep(650);
        getInstrumentation().waitForIdleSync();
        getInstrumentation().getUiAutomation().waitForIdle(250, 3000);
        var configuration = activity.getResources().getConfiguration();
        String name = "workbench-" + screen + "-" + language + "-" + theme + "-"
            + configuration.screenWidthDp + "dp-fs" + configuration.fontScale + ".png";
        java.io.File directory = new java.io.File(activity.getExternalFilesDir(null), "workbench-visuals");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        android.graphics.Bitmap bitmap = getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull(bitmap);
        try (var output = new java.io.FileOutputStream(new java.io.File(directory, name))) {
            assertTrue(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output));
        } finally { bitmap.recycle(); }
    }

    private void waitForPage() throws Exception {
        android.os.SystemClock.sleep(350);
        getInstrumentation().waitForIdleSync();
        getInstrumentation().getUiAutomation().waitForIdle(200, 3000);
    }

    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    private Object field(String name) throws Exception {
        var field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); return field.get(activity);
    }
    private Object field(Activity activity, String name) throws Exception {
        var field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); return field.get(activity);
    }
    private void field(Activity activity, String name, Object value) throws Exception {
        var field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); field.set(activity, value);
    }
    private void invoke(Activity activity, String name) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity);
    }
    private void invoke(Activity activity, String name, Class<?>[] types, Object[] values) throws Exception {
        var method = MainActivity.class.getDeclaredMethod(name, types); method.setAccessible(true); method.invoke(activity, values);
    }
    private Activity activity;
}
