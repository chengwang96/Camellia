package app.camellia.mobile;

import android.app.AlertDialog;
import android.app.Dialog;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Questions must be answerable from the same work sheet that announces them. */
public class RemoteApprovalSheetTest extends InstrumentationTestCase {
    private MainActivity activity;
    private JSONObject snapshot, request;
    private String oldLanguage, oldTheme;

    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private Object field(String name) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); return member.get(activity);
    }
    private void field(String name, Object value) throws Exception {
        var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); member.set(activity, value);
    }
    private void apply() throws Exception {
        var method = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); method.setAccessible(true); method.invoke(activity, new JSONObject(snapshot.toString()));
    }
    private Dialog sheet() throws Exception { return (Dialog) field("workDialog"); }
    private AlertDialog form() throws Exception { return (AlertDialog) field("remoteApprovalDialog"); }
    private View openSheet() throws Exception {
        View root = activity.getWindow().getDecorView();
        assertNull("Work state must not create a separate row above the composer", root.findViewWithTag("remoteWorkSummary"));
        TextView footer = root.findViewWithTag("connectionStatus");
        assertTrue(footer.isShown());
        assertTrue(footer.getText().toString().contains("1"));
        assertTrue(footer.performClick());
        assertNotNull(sheet()); return sheet().getWindow().getDecorView();
    }
    public void testQuestionDraftAndTypingSurviveBothTabletRotations() throws Exception {
        if (activity.getResources().getConfiguration().smallestScreenWidthDp < 600) return;
        ui(() -> activity.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
        awaitRotation(true);
        ui(() -> openSheet().findViewWithTag("workApprovalAnswer:question-1").performClick());
        AlertDialog original = form(); assertNotNull(original);
        EditText editor = original.getWindow().getDecorView().findViewWithTag("approvalAnswer:network");
        var keyboard = activity.getSystemService(android.view.inputmethod.InputMethodManager.class);
        ui(() -> { editor.setText("abcdef"); editor.requestFocus(); editor.setSelection(2, 4); keyboard.showSoftInput(editor, 0); });
        long end = android.os.SystemClock.uptimeMillis() + 6000;
        while (!keyboard.isActive(editor) && android.os.SystemClock.uptimeMillis() < end) Thread.sleep(60);
        assertTrue(keyboard.isActive(editor));
        for (boolean landscape : new boolean[]{false, true}) {
            ui(() -> activity.setRequestedOrientation(landscape ? android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE : android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            awaitRotation(landscape);
            assertTrue("Rotation must keep the unanswered question form open", original.isShowing());
            assertSame(original, form()); assertNull("The work sheet was closed when its question form opened", sheet());
            end = android.os.SystemClock.uptimeMillis() + 6000;
            while ((!editor.hasFocus() || !keyboard.isActive(editor)) && android.os.SystemClock.uptimeMillis() < end) { Thread.sleep(60); getInstrumentation().waitForIdleSync(); }
            assertTrue(editor.hasFocus()); assertTrue(keyboard.isActive(editor));
            getInstrumentation().sendStringSync(landscape ? "y" : "x"); getInstrumentation().waitForIdleSync();
            assertEquals(landscape ? "abxyef" : "abxef", editor.getText().toString());
        }
        ui(() -> { original.getButton(AlertDialog.BUTTON_NEUTRAL).performClick(); snapshot.getJSONObject("live").put("approvals", new JSONArray()).put("pendingApprovals", 0); apply(); });
        assertFalse(original.isShowing());
        var pending = MainActivity.class.getDeclaredMethod("pendingCommand"); pending.setAccessible(true);
        assertNull("Rotation and Later must not submit answers", pending.invoke(activity));
    }

    public void testWorkSheetStaysOpenAndUpdatesAcrossBothTabletRotations() throws Exception {
        if (activity.getResources().getConfiguration().smallestScreenWidthDp < 600) return;
        ui(() -> activity.setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE)); awaitRotation(true);
        ui(() -> openSheet()); Dialog original = sheet(); assertNotNull(original);
        for (boolean landscape : new boolean[]{false, true}) {
            ui(() -> activity.setRequestedOrientation(landscape ? android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE : android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
            awaitRotation(landscape); assertTrue("Rotation must keep the work sheet open", original.isShowing()); assertSame(original, sheet());
            ui(() -> { request.put("fingerprint", landscape ? "landscape" : "portrait"); apply(); });
            assertNotNull(original.getWindow().getDecorView().findViewWithTag("workApprovalAnswer:question-1"));
        }
        ui(() -> { var home = MainActivity.class.getDeclaredMethod("homeScreen"); home.setAccessible(true); home.invoke(activity); });
        assertFalse("Leaving the conversation must release its work sheet", original.isShowing());
    }

    private void awaitRotation(boolean landscape) throws Exception {
        long end = android.os.SystemClock.uptimeMillis() + 6000;
        int expected = landscape ? android.content.res.Configuration.ORIENTATION_LANDSCAPE : android.content.res.Configuration.ORIENTATION_PORTRAIT;
        while (activity.getResources().getConfiguration().orientation != expected && android.os.SystemClock.uptimeMillis() < end) { Thread.sleep(60); getInstrumentation().waitForIdleSync(); }
        assertEquals(expected, activity.getResources().getConfiguration().orientation); getInstrumentation().waitForIdleSync();
    }

    private boolean hasText(View view, String text) {
        if (view instanceof TextView && text.equals(((TextView) view).getText().toString())) return true;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++)
            if (hasText(((ViewGroup) view).getChildAt(i), text)) return true;
        return false;
    }
    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        oldLanguage = MobilePreferences.get(context, "language"); oldTheme = MobilePreferences.get(context, "theme");
        android.os.Bundle args = ((android.test.InstrumentationTestRunner) getInstrumentation()).getArguments();
        MobilePreferences.set(context, "language", args.getString("approvalLanguage", "zh"));
        MobilePreferences.set(context, "theme", args.getString("approvalTheme", "light"));
        activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            var stop = MainActivity.class.getDeclaredMethod("stopNetwork"); stop.setAccessible(true); stop.invoke(activity);
            CredentialStore store = new CredentialStore(context, "remote-approval-sheet-test"); store.clear(); field("store", new ComputerStore(store));
            field("foreground", false); field("credentials", new JSONObject().put("address", "http://100.64.0.1:43128").put("token", "a".repeat(43)));
            field("conversationId", "approval-sheet-test"); field("conversationTitle", "连接修复");
            var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
            request = new JSONObject().put("requestId", "question-1").put("fingerprint", "original").put("toolName", "Codex needs your input")
                .put("details", "{}").put("responseSupported", true).put("actionable", false)
                .put("questions", new JSONArray().put(new JSONObject().put("id", "network").put("header", "连接修复")
                    .put("question", "是否允许短暂断开连接，以重启服务？")
                    .put("options", new JSONArray().put(new JSONObject().put("label", "允许重启").put("description", "重启后自动重连")) )));
            snapshot = new JSONObject().put("instanceId", "host-1").put("cursor", 1).put("permission", "control")
                .put("conversation", new JSONObject().put("id", "approval-sheet-test").put("seq", 1).put("title", "连接修复"))
                .put("messages", new JSONArray()).put("live", new JSONObject().put("runId", 42).put("text", "等待确认")
                    .put("approvals", new JSONArray().put(request)).put("pendingApprovals", 1));
            apply();
        });
    }
    @Override protected void tearDown() throws Exception {
        ui(() -> activity.finish()); getInstrumentation().waitForIdleSync(); super.tearDown();
        long deadline = android.os.SystemClock.uptimeMillis() + 5000;
        while (!activity.isDestroyed() && android.os.SystemClock.uptimeMillis() < deadline) android.os.SystemClock.sleep(20);
        MobilePreferences.set(getInstrumentation().getTargetContext(), "language", oldLanguage);
        MobilePreferences.set(getInstrumentation().getTargetContext(), "theme", oldTheme);
    }
    private void capture(String name) throws Exception {
        getInstrumentation().waitForIdleSync(); android.os.SystemClock.sleep(600);
        android.graphics.Bitmap bitmap = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(bitmap);
        java.io.File folder = new java.io.File(activity.getExternalFilesDir(null), "approval-visuals");
        assertTrue(folder.isDirectory() || folder.mkdirs());
        try (var output = new java.io.FileOutputStream(new java.io.File(folder, name + ".png"))) {
            assertTrue(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output));
        } finally { bitmap.recycle(); }
    }
    public void testWorkSheetOpensQuestionsDirectlyAndLaterKeepsThemPending() throws Exception {
        capture("work-footer");
        ui(() -> {
            View root = openSheet();
            assertTrue("The work sheet must preview the actual question", hasText(root, "是否允许短暂断开连接，以重启服务？"));
            assertFalse("An empty native tool input is not question details", hasText(root, "{}"));
            View answer = root.findViewWithTag("workApprovalAnswer:question-1"); assertNotNull(answer); assertTrue(answer.isEnabled());
        });
        capture("work-sheet");
        ui(() -> {
            View answer = sheet().getWindow().getDecorView().findViewWithTag("workApprovalAnswer:question-1");
            answer.performClick(); assertNotNull(form()); assertTrue(form().isShowing());
            assertTrue(sheet() == null || !sheet().isShowing());
            assertNotNull(form().getWindow().getDecorView().findViewWithTag("允许重启"));
        });
        capture("question-form");
        ui(() -> {
            android.graphics.Rect bounds = new android.graphics.Rect();
            assertTrue(form().getButton(AlertDialog.BUTTON_POSITIVE).getGlobalVisibleRect(bounds));
            assertTrue(bounds.height() > 0);
            form().getButton(AlertDialog.BUTTON_NEUTRAL).performClick();
            assertEquals(1, snapshot.getJSONObject("live").getJSONArray("approvals").length());
            openSheet().findViewWithTag("workApprovalAnswer:question-1").performClick(); assertTrue(form().isShowing());
        });
    }

    public void testFooterRetainsFailureDetailsRetryAndWorkActions() throws Exception {
        AtomicInteger retries = new AtomicInteger();
        ui(() -> {
            ChatStatusLine footer = (ChatStatusLine) field("workStatus");
            footer.error("fixture send failure", false);
            footer.retry(retries::incrementAndGet);
            activity.getWindow().getDecorView().findViewWithTag("connectionStatus").performClick();
        });
        getInstrumentation().waitForIdleSync();
        var root = activeWindowContaining("fixture send failure");
        assertFalse(root.findAccessibilityNodeInfosByText("fixture send failure").isEmpty());
        boolean zh = (boolean) field("chinese");
        var work = root.findAccessibilityNodeInfosByText(zh ? "工作状态" : "Work status");
        assertFalse(work.isEmpty());
        assertTrue(work.get(0).performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK));
        getInstrumentation().waitForIdleSync();
        ui(() -> {
            assertNotNull(sheet());
            assertNotNull(sheet().getWindow().getDecorView().findViewWithTag("workApprovalAnswer:question-1"));
            assertEquals(0, retries.get());
            sheet().dismiss();
            activity.getWindow().getDecorView().findViewWithTag("connectionStatus").performClick();
        });
        getInstrumentation().waitForIdleSync();
        root = activeWindowContaining(zh ? "重试同一请求" : "Retry same request");
        var retry = root.findAccessibilityNodeInfosByText(zh ? "重试同一请求" : "Retry same request");
        assertFalse(retry.isEmpty());
        assertTrue(retry.get(0).performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK));
        getInstrumentation().waitForIdleSync();
        assertEquals(1, retries.get());
    }

    private android.view.accessibility.AccessibilityNodeInfo activeWindowContaining(String text) {
        var automation = getInstrumentation().getUiAutomation();
        long deadline = android.os.SystemClock.uptimeMillis() + 5000;
        while (android.os.SystemClock.uptimeMillis() < deadline) {
            var root = automation.getRootInActiveWindow();
            if (root != null && !root.findAccessibilityNodeInfosByText(text).isEmpty()) return root;
            android.os.SystemClock.sleep(25);
        }
        throw new AssertionError("Accessibility window did not expose: " + text);
    }
    public void testWorkSheetTracksRequestChangesAndRejectsStaleQuestionButtons() throws Exception {
        ui(() -> {
            View root = openSheet(); View stale = root.findViewWithTag("workApprovalAnswer:question-1"); assertNotNull(stale);
            request.put("fingerprint", "changed"); apply();
            stale.performClick(); assertNull("A replaced request must not open an old form", form());
            View current = root.findViewWithTag("workApprovalAnswer:question-1"); assertNotNull(current); assertNotSame(stale, current);
            current.performClick(); assertTrue(form().isShowing());
            snapshot.getJSONObject("live").put("approvals", new JSONArray()).put("pendingApprovals", 0); apply();
            assertNull("Answering on the desktop must close the phone's obsolete form", form());
        });
    }
    public void testUnsupportedQuestionNeverBecomesAllowDenyInWorkSheet() throws Exception {
        ui(() -> {
            request.put("responseSupported", false); apply(); View root = openSheet();
            assertNull(root.findViewWithTag("workApprovalAnswer:question-1"));
            assertFalse(hasText(root, "允许一次")); assertFalse(hasText(root, "拒绝"));
        });
    }
    public void testReadOnlyOrDisconnectedWorkSheetCannotAnswer() throws Exception {
        ui(() -> {
            View root = openSheet();
            snapshot.put("permission", "read"); apply();
            assertNull(root.findViewWithTag("workApprovalAnswer:question-1"));
            sheet().dismiss(); snapshot.put("permission", "control"); apply(); root = openSheet();
            field("connected", false);
            var controls = MainActivity.class.getDeclaredMethod("updateControls"); controls.setAccessible(true); controls.invoke(activity);
            View answer = root.findViewWithTag("workApprovalAnswer:question-1"); assertNotNull(answer); assertFalse(answer.isEnabled());
            answer.performClick(); assertNull(form());
        });
    }
    public void testConversationAndSheetUseTheSameQuestionForm() throws Exception {
        ui(() -> {
            ViewGroup approvals = (ViewGroup) field("approvals");
            assertFalse(hasText(approvals, "{}"));
            assertTrue(hasText(approvals, "是否允许短暂断开连接，以重启服务？"));
            for (int i = 0; i < approvals.getChildCount(); i++) {
                View child = approvals.getChildAt(i);
                if (child instanceof android.widget.Button) { child.performClick(); break; }
            }
            assertNotNull(form()); assertTrue(form().isShowing());
            ((EditText) form().getWindow().getDecorView().findViewWithTag("approvalAnswer:network")).setText("先保存连接恢复方法，再重启");
            // No foreground session: the command must not dismiss the unsent answer.
            form().getButton(AlertDialog.BUTTON_POSITIVE).performClick();
            assertTrue(form().isShowing());
        });
    }
    public void testSheetSubmitsNativeAnswersOnceWithTheOriginalRequestIdentity() throws Exception {
        AtomicReference<JSONObject> sent = new AtomicReference<>(); AtomicInteger calls = new AtomicInteger();
        CountDownLatch dispatched = new CountDownLatch(1);
        RemoteApi capture = new RemoteApi("http://100.64.0.1:43128") {
            @Override public JSONObject json(String path, String token, JSONObject payload) throws java.io.IOException {
                try {
                    sent.set(new JSONObject(payload.toString())); calls.incrementAndGet(); dispatched.countDown();
                    return new JSONObject().put("ok", false).put("state", "pending");
                } catch (Exception error) { throw new java.io.IOException(error); }
            }
        };
        ui(() -> {
            ((java.util.Map<String, RemoteApi>) field("commandClients")).put(MainActivity.commandTransportKey((JSONObject) field("credentials")), capture);
            field("foreground", true);
            openSheet().findViewWithTag("workApprovalAnswer:question-1").performClick();
            View root = form().getWindow().getDecorView(); root.findViewWithTag("允许重启").performClick();
            AlertDialog original = form(); original.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
            assertFalse(original.isShowing());
            JSONObject pending = RemotePendingCommands.get((JSONObject) field("credentials"), "approval-sheet-test", false).getJSONObject("payload");
            assertEquals("approve", pending.getString("action")); assertEquals("host-1", pending.getString("instanceId"));
            assertEquals(42, pending.getLong("runId")); assertEquals("question-1", pending.getString("approvalId"));
            assertEquals("original", pending.getString("fingerprint")); assertTrue(pending.getBoolean("allow"));
            assertEquals("允许重启", pending.getJSONObject("input").getString("network"));
            original.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
            assertEquals(pending.getString("requestId"), RemotePendingCommands.get((JSONObject) field("credentials"), "approval-sheet-test", false).getJSONObject("payload").getString("requestId"));
        });
        assertTrue("The answer must reach the remote command transport", dispatched.await(5, TimeUnit.SECONDS));
        assertEquals(1, calls.get()); assertEquals("允许重启", sent.get().getJSONObject("input").getString("network"));
    }
}
