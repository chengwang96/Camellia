package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import org.json.JSONObject;

public class MobileDeviceTest extends InstrumentationTestCase {
    @Override protected void setUp() throws Exception {
        super.setUp();
        EmbeddedNetwork.initialize(getInstrumentation().getTargetContext());
        EmbeddedNetwork.setEnabled(false);
        new CredentialStore(getInstrumentation().getTargetContext()).clear();
    }

    @Override protected void tearDown() throws Exception {
        new CredentialStore(getInstrumentation().getTargetContext()).clear();
        super.tearDown();
    }

    public void testKeystoreRoundTripAndNoPlaintextToken() throws Exception {
        var context = getInstrumentation().getTargetContext();
        CredentialStore store = new CredentialStore(context);
        String token = "a".repeat(43);
        store.save(new JSONObject().put("address", "http://100.80.1.2:43127").put("token", token).put("claim", "pending-secret"));
        assertEquals(token, new CredentialStore(context).load().getString("token"));
        String raw = context.getSharedPreferences("remote-private", 0).getString("credential", "");
        assertFalse(raw.contains(token));
        assertFalse(raw.contains("pending-secret"));
        assertFalse(raw.contains("100.80.1.2"));
        store.clear(); assertEquals(0, store.load().length());
    }

    public void testPairingScreenRejectsNonTailnetAddressAndSurvivesRecreate() throws Exception {
        Intent intent = new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity activity = getInstrumentation().startActivitySync(intent);
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                View root = activity.getWindow().getDecorView();
                assertTrue(hasText(root, "Settings", "设置"));
                root.findViewWithTag("remoteControlEntry").performClick();
                findText(root, "Add computer", "添加电脑").performClick();
                root = activity.getWindow().getDecorView();
                assertTrue(hasText(root, "Connect your computer", "连接你的电脑"));
                assertTrue(hasText(root, "Request pairing", "请求配对"));
                assertEquals(0, activity.getWindow().getAttributes().flags & android.view.WindowManager.LayoutParams.FLAG_SECURE);
                View button = findText(root, "Request pairing", "请求配对");
                button.performClick();
                assertTrue(hasText(root, "Check the Tailscale address, device name and 24-character pairing code.", "请检查 Tailscale 地址、设备名称和 24 位配对码。"));
            });
            getInstrumentation().runOnMainSync(() -> {
                getInstrumentation().callActivityOnPause(activity);
                getInstrumentation().callActivityOnStop(activity);
                getInstrumentation().callActivityOnRestart(activity);
                getInstrumentation().callActivityOnStart(activity);
                getInstrumentation().callActivityOnResume(activity);
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> assertEquals(0,
                activity.getWindow().getAttributes().flags & android.view.WindowManager.LayoutParams.FLAG_SECURE));
            android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
            assertNotNull(screenshot);
            screenshot.recycle();
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testControlComposerPersistsRequestBeforeNetworkAndShowsApproval() throws Exception {
        var context = getInstrumentation().getTargetContext();
        new CredentialStore(context).save(new JSONObject().put("address", "http://100.80.1.2:43127").put("token", "a".repeat(43)));
        Activity activity = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().waitForIdleSync();
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var id = MainActivity.class.getDeclaredField("conversationId"); id.setAccessible(true); id.set(activity, "12345678-1234-1234-1234-123456789abc");
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                    var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true);
                    JSONObject snapshot = new JSONObject().put("instanceId", "test-instance").put("cursor", 1).put("permission", "control")
                        .put("conversation", new JSONObject().put("id", id.get(activity)).put("seq", 3)).put("messages", new org.json.JSONArray()).put("nextBefore", JSONObject.NULL);
                    apply.invoke(activity, snapshot);
                    View root = activity.getWindow().getDecorView();
                    assertFalse(findText(root, "Send", "发送").isEnabled());
                    assertFalse(findText(root, "Stop", "停止").isEnabled());
                    var composer = MainActivity.class.getDeclaredField("composer"); composer.setAccessible(true);
                    ((android.widget.EditText) composer.get(activity)).setText("A phone instruction");
                    assertTrue(findText(root, "Send", "发送").isEnabled());
                    findText(root, "Send", "发送").performClick();
                    JSONObject pending = new CredentialStore(context).load().getJSONObject("pendingCommand").getJSONObject("payload");
                    assertEquals("A phone instruction", pending.getString("prompt"));
                    assertEquals(3, pending.getLong("expectedSeq"));
                    assertEquals("test-instance", pending.getString("instanceId"));
                    snapshot.put("cursor", 2).put("live", new JSONObject().put("runId", 8).put("text", "Running").put("approvals", new org.json.JSONArray().put(
                        new JSONObject().put("toolName", "Test tool").put("details", "echo test").put("actionable", true).put("requestId", "approve-1").put("fingerprint", "hash"))));
                    apply.invoke(activity, snapshot);
                    assertTrue(hasText(root, "Allow once", "允许一次"));
                    assertTrue(hasText(root, "Deny", "拒绝"));
                    assertFalse(findText(root, "Send", "发送").isEnabled());
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    private boolean hasText(View view, String english, String chinese) { return findText(view, english, chinese) != null; }
    public void testComposerLayoutAndActionStates() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().waitForIdleSync();
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var id = MainActivity.class.getDeclaredField("conversationId"); id.setAccessible(true); id.set(activity, "12345678-1234-1234-1234-123456789abc");
                    var title = MainActivity.class.getDeclaredField("conversationTitle"); title.setAccessible(true); title.set(activity, "Camellia mobile design");
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                    var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true);
                    JSONObject snapshot = new JSONObject().put("instanceId", "preview").put("cursor", 1).put("permission", "control")
                        .put("conversation", new JSONObject().put("id", id.get(activity)).put("seq", 2))
                        .put("messages", new org.json.JSONArray().put(new JSONObject().put("seq", 1).put("role", "user").put("text", "Make the message box feel lighter."))
                            .put(new JSONObject().put("seq", 2).put("role", "assistant").put("text", "A single rounded input, with a compact action button. Your tasks still run on your computer."))).put("nextBefore", JSONObject.NULL);
                    apply.invoke(activity, snapshot);
                    View root = activity.getWindow().getDecorView();
                    android.widget.EditText input = (android.widget.EditText) findText(root, "Message input", "消息输入框");
                    assertFalse(input.isVerticalScrollBarEnabled());
                    var scrollField = MainActivity.class.getDeclaredField("scroll"); scrollField.setAccessible(true);
                    assertFalse(((View) scrollField.get(activity)).isVerticalScrollBarEnabled());
                    View send = findText(root, "Send", "发送"), stop = findText(root, "Stop", "停止");
                    assertEquals(View.VISIBLE, send.getVisibility()); assertEquals(View.GONE, stop.getVisibility());
                    assertFalse(send.isEnabled()); input.setText("   "); assertFalse(send.isEnabled());
                    input.setText("Continue with the mobile layout"); assertTrue(send.isEnabled());
                    snapshot.put("cursor", 2).put("live", new JSONObject().put("runId", 9).put("text", "Working…")); apply.invoke(activity, snapshot);
                    assertEquals(View.GONE, send.getVisibility()); assertEquals(View.VISIBLE, stop.getVisibility()); assertTrue(stop.isEnabled());
                    snapshot.put("cursor", 3).put("permission", "read"); apply.invoke(activity, snapshot); assertFalse(stop.isEnabled());
                    snapshot.put("cursor", 4).put("permission", "control").remove("live"); apply.invoke(activity, snapshot);
                    input.setText("Continue with the mobile layout\nKeep the controls compact.");
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                View root = activity.getWindow().getDecorView(), bar = root.findViewWithTag("composerBar");
                View input = findText(root, "Message input", "消息输入框"), send = findText(root, "Send", "发送");
                assertFalse(((ViewGroup) bar.getParent()).getClipToPadding());
                assertTrue(input.getWidth() > 0); assertTrue(input.getBottom() <= ((View) send.getParent()).getTop());
                assertTrue(send.getRight() <= bar.getWidth()); assertTrue(send.getHeight() >= 48 * activity.getResources().getDisplayMetrics().density);
            });
            android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(screenshot);
            try (java.io.FileOutputStream output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), "composer.png"))) {
                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
            }
            screenshot.recycle();
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testSnapshotsDoNotChangeComposerFocus() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().setInTouchMode(true);
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var id = MainActivity.class.getDeclaredField("conversationId"); id.setAccessible(true); id.set(activity, "12345678-1234-1234-1234-123456789abc");
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            for (boolean focused : new boolean[] {false, true}) {
                getInstrumentation().runOnMainSync(() -> {
                    View input = findText(activity.getWindow().getDecorView(), "Message input", "消息输入框");
                    if (focused) assertTrue(input.requestFocus());
                    else assertFalse(input.hasFocus());
                });
                for (int cursor = 1; cursor <= 4; cursor++) {
                    final int revision = cursor;
                    getInstrumentation().runOnMainSync(() -> {
                        try {
                            var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true);
                            JSONObject snapshot = new JSONObject().put("instanceId", "focus-test").put("cursor", revision + (focused ? 4 : 0)).put("permission", "control")
                                .put("conversation", new JSONObject().put("id", "12345678-1234-1234-1234-123456789abc").put("seq", revision))
                                .put("messages", new org.json.JSONArray().put(new JSONObject().put("seq", 1).put("role", "assistant").put("text", "Updated message\n".repeat(revision * 20))))
                                .put("nextBefore", JSONObject.NULL);
                            if (revision % 2 == 0) snapshot.put("live", new JSONObject().put("runId", 9).put("text", "Working…"));
                            apply.invoke(activity, snapshot);
                        } catch (Exception error) { throw new AssertionError(error); }
                    });
                    getInstrumentation().waitForIdleSync();
                    getInstrumentation().runOnMainSync(() -> assertEquals(focused, findText(activity.getWindow().getDecorView(), "Message input", "消息输入框").hasFocus()));
                }
            }
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testWorkspaceGroupsPersistCollapseAndMergePages() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().waitForIdleSync();
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    activity.getPreferences(Activity.MODE_PRIVATE).edit().clear().commit();
                    var list = MainActivity.class.getDeclaredMethod("listScreen"); list.setAccessible(true); list.invoke(activity);
                    var apply = MainActivity.class.getDeclaredMethod("applyConversationPage", JSONObject.class, boolean.class); apply.setAccessible(true);
                    JSONObject research = new JSONObject().put("id", "research").put("title", "Review experiment results").put("workspaceId", "workspace").put("workspaceName", "Research").put("engine", "codex").put("activity", "running");
                    JSONObject independent = new JSONObject().put("id", "independent").put("title", "Plan the next release").put("workspaceId", JSONObject.NULL).put("engine", "kimi");
                    JSONObject second = new JSONObject().put("id", "second").put("title", "Desktop and mobile design").put("workspaceId", "design").put("workspaceName", "Camellia").put("engine", "codex");
                    JSONObject page = new JSONObject().put("conversations", new org.json.JSONArray().put(research).put(independent).put(second)).put("nextOffset", 100);
                    apply.invoke(activity, page, false);
                    View root = activity.getWindow().getDecorView();
                    assertNotNull(root.findViewWithTag("group:"));
                    assertNotNull(root.findViewWithTag("conversation:independent"));
                    root.findViewWithTag("group:workspace").performClick();
                    assertNull(root.findViewWithTag("conversation:research"));
                    JSONObject next = new JSONObject().put("id", "next").put("title", "Follow-up analysis").put("workspaceId", "workspace").put("workspaceName", "Research").put("engine", "kimi");
                    apply.invoke(activity, new JSONObject().put("conversations", new org.json.JSONArray().put(next).put(research)).put("nextOffset", JSONObject.NULL), true);
                    assertNull(root.findViewWithTag("conversation:next"));
                    root.findViewWithTag("group:workspace").performClick();
                    assertNotNull(root.findViewWithTag("conversation:next"));
                    assertNotNull(root.findViewWithTag("conversation:research"));
                    var search = MainActivity.class.getDeclaredField("searchInput"); search.setAccessible(true);
                    ((android.widget.EditText) search.get(activity)).setText("next release");
                    assertNotNull(root.findViewWithTag("conversation:independent"));
                    assertNull(root.findViewWithTag("conversation:research"));
                    ((android.widget.EditText) search.get(activity)).setText("");
                    assertNull(findText(root, "Load more conversations", "加载更多会话"));
                    root.findViewWithTag("group:workspace").performClick();
                    var collapsed = MainActivity.class.getDeclaredField("collapsedGroups"); collapsed.setAccessible(true); ((java.util.Map<?, ?>) collapsed.get(activity)).clear();
                    list.invoke(activity); apply.invoke(activity, page, false);
                    root = activity.getWindow().getDecorView();
                    assertNull(root.findViewWithTag("conversation:research"));
                    root.findViewWithTag("group:workspace").performClick();
                    assertNotNull(root.findViewWithTag("conversation:research"));
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().getUiAutomation().waitForIdle(300, 3000);
            android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
            assertNotNull(screenshot);
            try (java.io.FileOutputStream output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), "workspace-groups.png"))) {
                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
            }
            screenshot.recycle();
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    private View findText(View view, String english, String chinese) {
        if (english.contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())
            || chinese.contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())) return view;
        if (view instanceof TextView) {
            String text = ((TextView) view).getText().toString();
            if (text.equals(english) || text.equals(chinese)) return view;
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                View found = findText(group.getChildAt(index), english, chinese);
                if (found != null) return found;
            }
        }
        return null;
    }
}
