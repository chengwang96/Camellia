package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;

public class NavigationTest extends InstrumentationTestCase {
    private CredentialStore encrypted;

    @Override protected void setUp() throws Exception {
        super.setUp();
        encrypted = new CredentialStore(getInstrumentation().getTargetContext()); encrypted.clear();
        EmbeddedNetwork.initialize(getInstrumentation().getTargetContext()); EmbeddedNetwork.setEnabled(false);
    }

    @Override protected void tearDown() throws Exception { encrypted.clear(); super.tearDown(); }

    private JSONObject computer(String address, String token) throws Exception {
        return new JSONObject().put("address", address).put("token", token.repeat(43)).put("deviceId", token);
    }

    public void testRemoteEntryChecksEveryComputerWithoutWaitingForChatWorker() throws Exception {
        ComputerStore computers = new ComputerStore(encrypted);
        java.util.List<String> addresses = new java.util.ArrayList<>();
        for (int index = 1; index <= 6; index++) {
            String address = "http://100.80.1." + index + ":43127"; addresses.add(address);
            computers.save(new JSONObject().put("address", address).put("deviceId", "revoked-" + index));
        }
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch started = new java.util.concurrent.CountDownLatch(2);
        try {
            var field = MainActivity.class.getDeclaredField("worker"); field.setAccessible(true);
            java.util.concurrent.ExecutorService worker = (java.util.concurrent.ExecutorService) field.get(activity);
            for (int index = 0; index < 2; index++) worker.submit(() -> {
                started.countDown();
                try { release.await(); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            });
            assertTrue(started.await(3, java.util.concurrent.TimeUnit.SECONDS));
            getInstrumentation().runOnMainSync(() -> {
                activity.getWindow().getDecorView().findViewWithTag("remoteControlEntry").performClick();
                for (String address : addresses) {
                    TextView label = activity.getWindow().getDecorView().findViewWithTag("computerState:" + address);
                    assertTrue(label.getText().toString().matches("Checking…|正在检查…"));
                }
            });
            long deadline = android.os.SystemClock.uptimeMillis() + 3000;
            java.util.concurrent.atomic.AtomicBoolean complete = new java.util.concurrent.atomic.AtomicBoolean();
            while (!complete.get() && android.os.SystemClock.uptimeMillis() < deadline) {
                getInstrumentation().runOnMainSync(() -> {
                    boolean ready = true;
                    for (String address : addresses) {
                        TextView label = activity.getWindow().getDecorView().findViewWithTag("computerState:" + address);
                        ready &= label.getText().toString().matches("Pair again|需要重新配对");
                    }
                    complete.set(ready);
                });
                if (!complete.get()) android.os.SystemClock.sleep(20);
            }
            assertTrue("All computer checks must finish even when chat workers are busy", complete.get());
            getInstrumentation().runOnMainSync(() -> {
                try {
                    invoke(activity, "refreshComputers");
                    for (String address : addresses) {
                        TextView label = activity.getWindow().getDecorView().findViewWithTag("computerState:" + address);
                        assertTrue(label.getText().toString().matches("Checking…|正在检查…"));
                    }
                    activity.onBackPressed();
                    assertNotNull(activity.getWindow().getDecorView().findViewWithTag("remoteControlEntry"));
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally {
            release.countDown(); getInstrumentation().runOnMainSync(activity::finish);
            getInstrumentation().waitForIdleSync();
        }
    }

    public void testWorkspaceDialogRequiresCapabilityAndValidatesFields() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    invoke(activity, "stopNetwork"); invoke(activity, "createWorkspace"); assertNull(currentDialog(activity));
                    var update = MainActivity.class.getDeclaredMethod("updateCapabilities", JSONObject.class); update.setAccessible(true);
                    update.invoke(activity, new JSONObject().put("permission", "control").put("capabilities", new org.json.JSONArray().put("create-workspace")));
                    invoke(activity, "createWorkspace"); android.app.Dialog dialog = currentDialog(activity); assertTrue(dialog.isShowing());
                    View root = dialog.getWindow().getDecorView();
                    android.widget.EditText name = root.findViewWithTag("remoteWorkspaceName"), folder = root.findViewWithTag("remoteWorkspacePath");
                    root.findViewWithTag("remoteWorkspaceCreate").performClick(); assertTrue(name.createAccessibilityNodeInfo().isContentInvalid()); assertNull(name.getError()); assertTrue(dialog.isShowing());
                    name.setText("Research"); assertFalse(name.createAccessibilityNodeInfo().isContentInvalid());
                    root.findViewWithTag("remoteWorkspaceCreate").performClick(); assertTrue(folder.createAccessibilityNodeInfo().isContentInvalid()); assertNull(folder.getError()); assertTrue(dialog.isShowing());
                    assertNotNull(findText(root, "Enter the full path of an existing folder on the computer, not this phone.", "填写电脑上已存在文件夹的完整路径，不是手机路径。"));
                    dialog.dismiss();
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testStyledRenameValidationCancelAndSave() throws Exception {
        ComputerStore computers = new ComputerStore(encrypted);
        JSONObject profile = computer("http://100.80.1.2:43127", "a"); computers.save(profile);
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    invoke(activity, "stopNetwork");
                    var rename = MainActivity.class.getDeclaredMethod("renameComputer", JSONObject.class); rename.setAccessible(true); rename.invoke(activity, profile);
                    android.app.Dialog dialog = currentDialog(activity);
                    assertTrue(dialog instanceof CamelliaDialog);
                    View root = dialog.getWindow().getDecorView();
                    android.widget.EditText input = root.findViewWithTag("computerNameInput");
                    assertTrue(input.getBackground() instanceof android.graphics.drawable.StateListDrawable);
                    input.setText("   "); root.findViewWithTag("renameSave").performClick(); assertTrue(dialog.isShowing());
                    assertNotNull(findText(root, "Enter a computer name", "请输入电脑名称"));
                    input.setText("Discarded name"); root.findViewWithTag("renameCancel").performClick();
                    assertFalse(computers.load().has("computerName"));
                    rename.invoke(activity, profile); root = currentDialog(activity).getWindow().getDecorView();
                    input = root.findViewWithTag("computerNameInput"); input.setText("  Work laptop  "); root.findViewWithTag("renameSave").performClick();
                    assertEquals("Work laptop", computers.load().getString("computerName"));
                    assertEquals("a".repeat(43), computers.load().getString("token"));
                    invoke(activity, "stopNetwork"); rename.invoke(activity, computers.load());
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().getUiAutomation().waitForIdle(300, 3000);
            android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(screenshot);
            try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), "rename-dialog.png"))) {
                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
            }
            screenshot.recycle();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    View root = currentDialog(activity).getWindow().getDecorView();
                    View input = root.findViewWithTag("computerNameInput"), save = root.findViewWithTag("renameSave");
                    assertTrue(input.getWidth() > 0); assertTrue(save.getHeight() >= 48 * activity.getResources().getDisplayMetrics().density);
                    currentDialog(activity).dismiss();
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    private android.app.Dialog currentDialog(Activity activity) throws Exception {
        var field = MainActivity.class.getDeclaredField("computerDialog"); field.setAccessible(true);
        return (android.app.Dialog) field.get(activity);
    }

    public void testMigrationRenameSwitchPendingAndRemovalIsolation() throws Exception {
        JSONObject first = computer("http://100.80.1.2:43127", "a"); encrypted.save(first);
        ComputerStore computers = new ComputerStore(encrypted); assertEquals(1, computers.all().size());
        computers.rename(first.getString("address"), "Research laptop");
        assertEquals("Research laptop", computers.load().getString("computerName"));
        JSONObject second = computer("http://100.80.1.3:43127", "b");
        second.put("pendingCommand", new JSONObject().put("id", "retry-second")); computers.save(second);
        assertEquals(2, computers.all().size());
        computers.save(new JSONObject().put("address", "http://100.80.1.4:43127").put("claim", "pairing-secret"));
        assertEquals(2, computers.all().size()); assertEquals("pairing-secret", computers.load().getString("claim"));
        for (JSONObject profile : computers.all()) {
            if (profile.getString("address").equals(first.getString("address"))) {
                assertFalse(profile.has("pendingCommand")); assertEquals("Research laptop", profile.getString("computerName"));
            } else assertEquals("retry-second", profile.getJSONObject("pendingCommand").getString("id"));
        }
        computers.remove(first.getString("address"));
        assertEquals(1, computers.all().size()); computers.save(computers.all().get(0));
        assertEquals("b".repeat(43), computers.load().getString("token"));
        JSONObject revoked = computers.load(); revoked.remove("token"); computers.save(revoked);
        assertFalse(computers.all().get(0).has("token"));
        String raw = getInstrumentation().getTargetContext().getSharedPreferences("remote-private", 0).getString("credential", "");
        assertFalse(raw.contains("retry-second")); assertFalse(raw.contains("100.80"));
    }

    public void testLegacyRevocationWithoutDeviceId() throws Exception {
        JSONObject legacy = computer("http://100.80.1.2:43127", "a"); legacy.remove("deviceId"); encrypted.save(legacy);
        ComputerStore computers = new ComputerStore(encrypted); computers.rename(legacy.getString("address"), "Laptop");
        JSONObject revoked = computers.load(); revoked.remove("token"); computers.save(revoked);
        assertFalse(computers.all().get(0).has("token"));
    }

    public void testDispatchedPullOnlyAtTop() {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        RefreshScrollView[] container = new RefreshScrollView[1];
        try {
            getInstrumentation().runOnMainSync(() -> {
                RefreshScrollView scroll = new RefreshScrollView(activity);
                TextView child = new TextView(activity); child.setText("Scrollable test content"); child.setMinHeight(6000); child.setOnClickListener(view -> {});
                scroll.addView(child, new android.widget.FrameLayout.LayoutParams(-1, 6000)); activity.setContentView(scroll);
                container[0] = scroll;
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                RefreshScrollView scroll = container[0];
                int[] refreshed = {0}; scroll.setRefreshAction(() -> refreshed[0]++, ready -> {});
                dispatchGesture(scroll); assertEquals(1, refreshed[0]);
                scroll.scrollTo(0, 800); assertTrue(scroll.canScrollVertically(-1));
                dispatchGesture(scroll); assertEquals(1, refreshed[0]);
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    private void dispatchGesture(RefreshScrollView scroll) {
        long time = android.os.SystemClock.uptimeMillis();
        int[] actions = {MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE, MotionEvent.ACTION_MOVE, MotionEvent.ACTION_UP};
        float[] positions = {20, 60, 400, 400};
        for (int index = 0; index < actions.length; index++) {
            MotionEvent event = MotionEvent.obtain(time, time + index * 40, actions[index], 20, positions[index], 0);
            scroll.dispatchTouchEvent(event); event.recycle();
        }
    }

    public void testThreeLevelsAndFooter() throws Exception {
        ComputerStore computers = new ComputerStore(encrypted);
        JSONObject profile = computer("http://100.80.1.2:43127", "a"); computers.save(profile);
        computers.rename(profile.getString("address"), "Research laptop");
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    View root = activity.getWindow().getDecorView();
                    root.findViewWithTag("remoteControlEntry").performClick();
                    assertNotNull(findText(root, "Remote control", "远程控制")); assertNotNull(findText(root, "Research laptop", "Research laptop"));
                    assertNull(findText(root, "MOBILE", "移动端"));
                    assertNull(findText(root, "Appearance & language · System default", "外观与语言 · 跟随系统"));
                    assertNotNull(root.findViewWithTag("computerState:" + profile.getString("address")));
                    root.findViewWithTag("computer:" + profile.getString("address")).performClick(); invoke(activity, "stopNetwork");
                    root = activity.getWindow().getDecorView();
                    assertNull(findText(root, "Refresh conversations", "刷新会话")); assertNull(findText(root, "Conversations", "会话"));
                    assertNull(findText(root, "Network settings", "网络设置")); assertNull(findText(root, "Forget computer", "移除电脑"));
                    assertNull(findText(root, profile.getString("address"), profile.getString("address")));
                    assertNotNull(root.findViewWithTag("searchBar")); assertNotNull(root.findViewWithTag("newIndependent"));
                    assertTrue(root.findViewWithTag("remoteNewWorkspace") instanceof android.widget.ImageButton);
                    assertNull(root.findViewWithTag("group:"));
                    assertEquals("Research laptop", ((TextView) root.findViewWithTag("headerComputerName")).getText().toString());
                    JSONObject conversation = new JSONObject().put("id", "12345678-1234-1234-1234-123456789abc").put("title", "Mobile navigation").put("workspaceId", "research").put("workspaceName", "Research");
                    var apply = MainActivity.class.getDeclaredMethod("applyConversationPage", JSONObject.class, boolean.class); apply.setAccessible(true);
                    apply.invoke(activity, new JSONObject().put("conversations", new org.json.JSONArray().put(conversation)), false);
                    assertNotNull(root.findViewWithTag("newWorkspace:research"));
                    assertNotNull(root.findViewWithTag("remoteNewWorkspace"));
                    assertNull(root.findViewWithTag("group:"));
                    JSONObject independent = new JSONObject().put("id", "22345678-1234-1234-1234-123456789abc").put("title", "Independent").put("workspaceId", JSONObject.NULL);
                    apply.invoke(activity, new JSONObject().put("conversations", new org.json.JSONArray().put(conversation).put(independent)), false);
                    assertNotNull(root.findViewWithTag("group:"));
                    assertTrue(root.findViewWithTag("newStandalone") instanceof android.widget.ImageButton);
                    root.findViewWithTag("conversation:" + conversation.getString("id")).performClick(); invoke(activity, "stopNetwork");
                    root = activity.getWindow().getDecorView(); assertNotNull(root.findViewWithTag("composerBar"));
                    assertEquals("Mobile navigation", ((TextView) root.findViewWithTag("pageTitle")).getText().toString());
                    View footer = root.findViewWithTag("connectionStatus"); LinearLayout parent = (LinearLayout) footer.getParent();
                    assertEquals(parent.getChildCount() - 1, parent.indexOfChild(footer));
                    assertEquals(parent.indexOfChild(footer) - 1, parent.indexOfChild(root.findViewWithTag("composerBar")));
                    activity.onBackPressed(); invoke(activity, "stopNetwork");
                    assertNull(activity.getWindow().getDecorView().findViewWithTag("composerBar"));
                    activity.onBackPressed(); invoke(activity, "stopNetwork");
                    assertNotNull(findText(activity.getWindow().getDecorView(), "Remote control", "远程控制"));
                    activity.onBackPressed(); assertNotNull(activity.getWindow().getDecorView().findViewWithTag("settingsEntry"));
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(screenshot);
            try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), "settings-navigation.png"))) {
                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
            }
            screenshot.recycle();
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testConnectionFailureStaysBelowBarsOnOneLine() throws Exception {
        JSONObject profile = computer("http://100.80.1.2:43127", "a");
        new ComputerStore(encrypted).save(profile);
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    activity.getWindow().getDecorView().findViewWithTag("remoteControlEntry").performClick();
                    activity.getWindow().getDecorView().findViewWithTag("computer:" + profile.optString("address")).performClick();
                    invoke(activity, "stopNetwork");
                    var failure = MainActivity.class.getDeclaredMethod("showFailure", Exception.class, boolean.class);
                    failure.setAccessible(true); failure.invoke(activity, new java.io.IOException(), true);
                    assertSingleLineFooter(activity, "searchBar");
                    invoke(activity, "detailScreen"); invoke(activity, "stopNetwork");
                    failure.invoke(activity, new java.io.IOException(), true);
                    assertSingleLineFooter(activity, "composerBar");
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    private void assertSingleLineFooter(Activity activity, String barTag) {
        TextView status = activity.getWindow().getDecorView().findViewWithTag("connectionStatus");
        LinearLayout parent = (LinearLayout) status.getParent();
        LinearLayout bar = parent.findViewWithTag(barTag);
        assertEquals(parent.getChildCount() - 1, parent.indexOfChild(status));
        assertEquals(parent.indexOfChild(bar) + 1, parent.indexOfChild(status));
        assertFalse(bar.getClipChildren()); assertFalse(bar.getClipToPadding());
        assertEquals(android.text.TextUtils.TruncateAt.END, status.getEllipsize());
        String[] messages = {
            status.getText().toString(),
            "无法连接。请检查「网络连接设置」中的登录状态、电脑在线状态和「手机访问」开关。",
            "Cannot connect. Check login in Network connection, that the computer is awake, and Mobile access."
        };
        float density = activity.getResources().getDisplayMetrics().density;
        assertEquals(Math.round(2 * density), status.getPaddingTop());
        assertEquals(Math.round(2 * density), status.getPaddingBottom());
        View page = (View) parent.getParent().getParent();
        android.view.WindowInsets original = page.getRootWindowInsets();
        assertNotNull(original);
        for (int bottom : new int[] {0, Math.round(24 * density), Math.round(280 * density)}) {
            page.dispatchApplyWindowInsets(original.replaceSystemWindowInsets(0, 0, 0, bottom));
            assertEquals(Math.round(8 * density) + bottom, page.getPaddingBottom());
        }
        if (original != null) page.dispatchApplyWindowInsets(original);
        for (int width : new int[] {320, 412}) {
            for (String message : messages) {
                status.setText(message); status.setTextSize(18);
                parent.measure(View.MeasureSpec.makeMeasureSpec((int) (width * density), View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec((int) (640 * density), View.MeasureSpec.EXACTLY));
                parent.layout(0, 0, parent.getMeasuredWidth(), parent.getMeasuredHeight());
                assertEquals(1, status.getLineCount());
                assertTrue(status.getTop() - bar.getBottom() >= Math.round(8 * density));
                assertTrue(status.getBottom() <= parent.getHeight() - parent.getPaddingBottom());
                assertTrue(bar.getHeight() >= (int) (48 * density));
                assertEquals(message, status.getText().toString());
            }
        }
    }

    public void testPullThresholdCancelBusyAndAccessibility() {
        getInstrumentation().runOnMainSync(() -> {
            RefreshScrollView scroll = new RefreshScrollView(getInstrumentation().getTargetContext());
            int[] refreshed = {0}; scroll.setRefreshAction(() -> refreshed[0]++, ready -> {});
            float density = scroll.getResources().getDisplayMetrics().density;
            gesture(scroll, 90 * density, MotionEvent.ACTION_UP); assertEquals(1, refreshed[0]);
            gesture(scroll, 35 * density, MotionEvent.ACTION_UP); assertEquals(1, refreshed[0]);
            gesture(scroll, 90 * density, MotionEvent.ACTION_CANCEL); assertEquals(1, refreshed[0]);
            scroll.setRefreshing(true); gesture(scroll, 90 * density, MotionEvent.ACTION_UP); assertEquals(1, refreshed[0]);
            scroll.setRefreshing(false); assertTrue(scroll.performAccessibilityAction(android.R.id.button1, null)); assertEquals(2, refreshed[0]);
            scroll.setRefreshing(true); scroll.performAccessibilityAction(android.R.id.button1, null); assertEquals(2, refreshed[0]);
        });
    }

    public void testListFailureAndFooterSpacing() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    invoke(activity, "listScreen");
                    var failure = MainActivity.class.getDeclaredMethod("showFailure", Exception.class, boolean.class); failure.setAccessible(true);
                    failure.invoke(activity, new RemoteApi.Failure(404), true);
                    TextView status = activity.getWindow().getDecorView().findViewWithTag("connectionStatus");
                    assertTrue(status.getText().toString().contains("endpoint") || status.getText().toString().contains("接口"));
                    var unavailable = MainActivity.class.getDeclaredField("listEventsUnavailable"); unavailable.setAccessible(true); unavailable.setBoolean(activity, true);
                    var watch = MainActivity.class.getDeclaredMethod("watchList", RemoteApi.class, int.class); watch.setAccessible(true); watch.invoke(activity, null, -1);
                    assertTrue(status.getText().toString().contains("periodically") || status.getText().toString().contains("定时刷新"));
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                View root = activity.getWindow().getDecorView();
                ViewGroup bar = root.findViewWithTag("searchBar"); View status = root.findViewWithTag("connectionStatus");
                View fade = root.findViewWithTag("searchBarFade"); assertNotNull(fade);
                float density = activity.getResources().getDisplayMetrics().density;
                assertEquals(Math.round(36 * density), fade.getHeight());
                assertTrue(fade.getBackground() instanceof android.graphics.drawable.GradientDrawable);
                assertTrue(((View) fade.getParent()).getLayoutParams() instanceof android.widget.FrameLayout.LayoutParams);
                assertEquals(android.view.Gravity.BOTTOM, ((android.widget.FrameLayout.LayoutParams) ((View) fade.getParent()).getLayoutParams()).gravity);
                View search = bar.getChildAt(0); assertEquals(Math.round(7 * density), search.getElevation(), 0f);
                assertEquals(Math.round(1 * density), search.getTranslationZ(), 0f);
                assertTrue("Status must leave room below the search shadow", status.getTop() - bar.getBottom() >= Math.round(8 * density));
                assertFalse("Search shadow must not be clipped", bar.getClipChildren());
                assertFalse("Page must allow nested shadows outside the search bar bounds", ((ViewGroup) bar.getParent()).getClipChildren());
                assertFalse(((ViewGroup) bar.getParent()).getClipToPadding());
                assertFalse(bar.getClipToPadding());
                assertTrue(bar.getHeight() >= Math.round(48 * density));
            });
            android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(screenshot);
            try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), "list-footer.png"))) {
                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
            }
            screenshot.recycle();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var id = MainActivity.class.getDeclaredField("conversationId"); id.setAccessible(true); id.set(activity, "00000000-0000-4000-8000-000000000001");
                    invoke(activity, "detailScreen"); invoke(activity, "stopNetwork");
                    var failure = MainActivity.class.getDeclaredMethod("showFailure", Exception.class, boolean.class); failure.setAccessible(true);
                    failure.invoke(activity, new RemoteApi.Failure(404), true);
                    TextView status = activity.getWindow().getDecorView().findViewWithTag("connectionStatus");
                    assertTrue(status.getText().toString().contains("Conversation unavailable") || status.getText().toString().contains("会话不可用"));
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    private void gesture(RefreshScrollView scroll, float distance, int end) {
        long time = android.os.SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(time, time, MotionEvent.ACTION_DOWN, 20, 20, 0);
        MotionEvent move = MotionEvent.obtain(time, time + 20, MotionEvent.ACTION_MOVE, 20, 20 + distance, 0);
        MotionEvent up = MotionEvent.obtain(time, time + 40, end, 20, 20 + distance, 0);
        scroll.onInterceptTouchEvent(down);
        if (scroll.onInterceptTouchEvent(move)) { scroll.onTouchEvent(move); scroll.onTouchEvent(up); }
        down.recycle(); move.recycle(); up.recycle();
    }

    private void invoke(Activity activity, String method) throws Exception {
        var target = MainActivity.class.getDeclaredMethod(method); target.setAccessible(true); target.invoke(activity);
    }

    public void testRaisedBackButtonsAndComputerHeader() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    View root = activity.getWindow().getDecorView();
                    root.findViewWithTag("remoteControlEntry").performClick(); invoke(activity, "stopNetwork");
                    assertNull(findText(root, "Camellia", "Camellia"));
                    View title = root.findViewWithTag("remoteControlTitle"); assertNotNull(title);
                    assertEquals(1, countText(root, "Remote control", "远程控制"));
                    assertSame(title.getParent(), root.findViewWithTag("pageBack").getParent());
                    for (String page : new String[]{"computersScreen", "listScreen", "detailScreen", "pairScreen", "settingsScreen", "showNetwork"}) {
                        invoke(activity, page); invoke(activity, "stopNetwork");
                        View back = root.findViewWithTag(page.equals("settingsScreen") || page.equals("showNetwork") ? "settingsBack" : "pageBack");
                        assertTrue(back instanceof android.widget.ImageButton);
                        assertEquals(Math.round(4 * activity.getResources().getDisplayMetrics().density), back.getElevation(), 0f);
                        assertNotNull(back.getStateListAnimator()); assertNotNull(back.getContentDescription());
                        ViewGroup header = (ViewGroup) back.getParent(); assertFalse(header.getClipChildren()); assertFalse(header.getClipToPadding());
                    }
                    invoke(activity, "computersScreen"); invoke(activity, "stopNetwork");
                } catch (Exception error) { throw new AssertionError(error); }
            });
            android.os.SystemClock.sleep(700); getInstrumentation().waitForIdleSync();
            android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
            try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), "remote-control-raised-back.png"))) {
                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
            } finally { screenshot.recycle(); }
            getInstrumentation().runOnMainSync(() -> {
                activity.getWindow().getDecorView().findViewWithTag("pageBack").performClick();
                assertNotNull(activity.getWindow().getDecorView().findViewWithTag("remoteControlEntry"));
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    private int countText(View view, String english, String chinese) {
        int count = view instanceof TextView && (english.contentEquals(((TextView) view).getText()) || chinese.contentEquals(((TextView) view).getText())) ? 1 : 0;
        if (view instanceof ViewGroup) for (int index = 0; index < ((ViewGroup) view).getChildCount(); index++) count += countText(((ViewGroup) view).getChildAt(index), english, chinese);
        return count;
    }

    private View findText(View view, String english, String chinese) {
        if (view instanceof TextView && (english.contentEquals(((TextView) view).getText()) || chinese.contentEquals(((TextView) view).getText()))) return view;
        if (view instanceof ViewGroup) for (int index = 0; index < ((ViewGroup) view).getChildCount(); index++) {
            View found = findText(((ViewGroup) view).getChildAt(index), english, chinese); if (found != null) return found;
        }
        return null;
    }
}
