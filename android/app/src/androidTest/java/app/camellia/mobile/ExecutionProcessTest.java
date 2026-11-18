package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

public class ExecutionProcessTest extends InstrumentationTestCase {
    private String oldLanguage, oldTheme, oldMode;
    @Override protected void setUp() throws Exception {
        super.setUp();
        var context = getInstrumentation().getTargetContext();
        oldLanguage = MobilePreferences.get(context, "language"); oldTheme = MobilePreferences.get(context, "theme"); oldMode = MobilePreferences.get(context, "processMode");
        var arguments = ((android.test.InstrumentationTestRunner) getInstrumentation()).getArguments();
        if ("true".equals(arguments.getString("landscape")))
            assertTrue(getInstrumentation().getUiAutomation().setRotation(android.app.UiAutomation.ROTATION_FREEZE_90));
        MobilePreferences.set(context, "language", arguments.getString("language", "zh-CN"));
        MobilePreferences.set(context, "theme", arguments.getString("theme", "system"));
        MobilePreferences.set(context, "processMode", "collapsed");
    }
    @Override protected void tearDown() throws Exception {
        var context = getInstrumentation().getTargetContext();
        MobilePreferences.set(context, "language", oldLanguage); MobilePreferences.set(context, "theme", oldTheme); MobilePreferences.set(context, "processMode", oldMode);
        super.tearDown();
    }
    public void testRemoteSnapshotKeepsFinalAnswerOutsideProcess() throws Exception {
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        android.app.Activity activity = getInstrumentation().startActivitySync(new android.content.Intent(context, MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var id = MainActivity.class.getDeclaredField("conversationId"); id.setAccessible(true); id.set(activity, "fixture");
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                    var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true);
                    JSONArray process = new JSONArray().put(new JSONObject().put("type", "tool").put("title", "Shell").put("input", "echo test").put("text", "test").put("status", "completed"));
                    JSONArray messages = new JSONArray().put(new JSONObject().put("seq", 1).put("role", "user").put("text", "Hello"));
                    JSONObject snapshot = new JSONObject().put("conversation", new JSONObject().put("id", "fixture"))
                        .put("instanceId", "server").put("cursor", 1).put("messages", messages)
                        .put("live", new JSONObject().put("userSeq", 1).put("text", "Final answer").put("process", process));
                    apply.invoke(activity, snapshot);
                    View root = activity.getWindow().getDecorView();
                    String key = "fixture:turn:1";
                    assertEquals(View.GONE, root.findViewWithTag("processBody:" + key).getVisibility());
                    root.findViewWithTag("processToggle:" + key).performClick();
                    assertEquals(View.VISIBLE, root.findViewWithTag("processCollapseFooter:" + key).getVisibility());
                    root.findViewWithTag("processCollapse:" + key).performClick();
                    snapshot.put("cursor", 2); apply.invoke(activity, snapshot);
                    assertEquals(View.GONE, root.findViewWithTag("processBody:" + key).getVisibility());
                    root.findViewWithTag("processToggle:" + key).performClick();
                    snapshot.put("cursor", 2); apply.invoke(activity, snapshot);
                    assertEquals(View.VISIBLE, root.findViewWithTag("processBody:" + key).getVisibility());
                    messages.put(new JSONObject().put("seq", 2).put("role", "assistant").put("text", "Final answer").put("process", process));
                    snapshot.put("cursor", 3).put("live", JSONObject.NULL); apply.invoke(activity, snapshot);
                    View body = root.findViewWithTag("processBody:" + key); assertEquals(View.VISIBLE, body.getVisibility());
                    android.view.ViewGroup block = (android.view.ViewGroup) body.getParent().getParent();
                    assertTrue(block.getChildCount() >= 2); assertEquals(View.VISIBLE, block.findViewWithTag("markdown").getVisibility());
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testDefaultCollapseLiveChoiceCompletionAndHistory() throws Throwable {
        runTestOnUiThread(() -> {
            try {
                var context = getInstrumentation().getTargetContext(); ChatStyle style = new ChatStyle(context);
                ExecutionProcessView.State state = new ExecutionProcessView.State();
                JSONArray process = new JSONArray().put(new JSONObject().put("type", "thinking").put("text", "Published reasoning"))
                    .put(new JSONObject().put("type", "tool").put("title", "Shell").put("input", "echo test").put("text", "test").put("status", "completed"));
                ExecutionProcessView view = new ExecutionProcessView(context, style, state, "turn"); view.update(process, true);
                assertEquals(View.GONE, view.findViewWithTag("processBody:turn").getVisibility());
                view.findViewWithTag("processToggle:turn").performClick();
                assertEquals(View.VISIBLE, view.findViewWithTag("processBody:turn").getVisibility());
                LinearLayout processBody = (LinearLayout) view.findViewWithTag("processBody:turn");
                View toolHeading = processBody.findViewWithTag("processToolToggle:turn:tool:1");
                assertNotNull(toolHeading);
                assertTrue(toolHeading.isFocusable());
                toolHeading.performClick();
                assertEquals(View.VISIBLE, processBody.findViewWithTag("processToolBody:turn:tool:1").getVisibility());
                assertEquals(View.VISIBLE, view.findViewWithTag("processCollapseFooter:turn").getVisibility());
                View collapse = view.findViewWithTag("processCollapse:turn");
                assertTrue(collapse.isFocusable());
                assertTrue(collapse.performAccessibilityAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_COLLAPSE, null));
                assertEquals(View.GONE, view.findViewWithTag("processBody:turn").getVisibility());
                assertEquals(View.GONE, view.findViewWithTag("processCollapseFooter:turn").getVisibility());
                view.update(process, true);
                assertEquals(View.GONE, view.findViewWithTag("processBody:turn").getVisibility());
                view.findViewWithTag("processToggle:turn").performClick();
                ExecutionProcessView rebuilt = new ExecutionProcessView(context, style, state, "turn"); rebuilt.update(process, true);
                assertEquals(View.VISIBLE, rebuilt.findViewWithTag("processBody:turn").getVisibility());
                assertEquals(View.VISIBLE, rebuilt.findViewWithTag("processToolBody:turn:tool:1").getVisibility());
                rebuilt.update(process, false); assertEquals(View.VISIBLE, rebuilt.findViewWithTag("processBody:turn").getVisibility());
                rebuilt.findViewWithTag("processToggle:turn").performClick();
                rebuilt.findViewWithTag("processToggle:turn").performClick(); rebuilt.update(process, false);
                assertEquals(View.VISIBLE, rebuilt.findViewWithTag("processBody:turn").getVisibility());
                ExecutionProcessView reload = new ExecutionProcessView(context, style, new ExecutionProcessView.State(), "turn"); reload.update(process, false);
                assertEquals(View.GONE, reload.findViewWithTag("processBody:turn").getVisibility());
                reload.update(new JSONArray(), false); assertEquals(View.GONE, reload.getVisibility());
                assertEquals(View.GONE, reload.findViewWithTag("processCollapseFooter:turn").getVisibility());
            } catch (Exception error) { throw new AssertionError(error); }
        });
    }

    public void testBottomCollapseRevealsLongProcessHeaderAndLeavesOtherBlocksOpen() throws Exception {
        var context = getInstrumentation().getTargetContext();
        android.app.Activity activity = getInstrumentation().startActivitySync(new android.content.Intent(context, MarkdownTestActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var visual = MobilePreferences.wrap(activity); ChatStyle style = new ChatStyle(visual);
                    LinearLayout page = new LinearLayout(visual); page.setOrientation(LinearLayout.VERTICAL); page.setPadding(style.dp(16), style.dp(12), style.dp(16), style.dp(12));
                    ChatScrollView scroll = new ChatScrollView(activity); scroll.setTag("footerFixtureScroll"); scroll.setFillViewport(true); scroll.addView(page);
                    scroll.setOnApplyWindowInsetsListener((view, insets) -> {
                        var bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                        view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
                    });
                    View before = new View(visual); page.addView(before, new LinearLayout.LayoutParams(-1, style.dp(250)));
                    JSONArray entries = new JSONArray();
                    for (int index = 0; index < 30; index++) entries.put(new JSONObject().put("type", "tool").put("id", "step" + index).put("title", "commandExecution").put("input", "Inspect file " + index).put("status", "completed"));
                    ExecutionProcessView process = new ExecutionProcessView(visual, style, new ExecutionProcessView.State(), "long-footer"); process.update(entries, true); page.addView(process);

                    TextView answer = new TextView(visual); answer.setTag("footerFixtureAnswer"); answer.setText("Final answer remains outside the execution process."); page.addView(answer);
                    ExecutionProcessView other = new ExecutionProcessView(visual, style, new ExecutionProcessView.State(), "other-footer"); other.update(new JSONArray().put(new JSONObject().put("type", "thinking").put("text", "Another process")), false); page.addView(other); other.findViewWithTag("processToggle:other-footer").performClick();
                    View after = new View(visual); page.addView(after, new LinearLayout.LayoutParams(-1, style.dp(1100)));
                    page.setBackgroundColor(style.background); activity.setContentView(scroll);
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            View root = activity.getWindow().getDecorView(), collapse = root.findViewWithTag("processCollapse:long-footer");
            captureFooter(activity, "process-collapse-layout");
            View opener = root.findViewWithTag("processToggle:long-footer");
            android.graphics.Rect openBounds = new android.graphics.Rect(); assertTrue(opener.getGlobalVisibleRect(openBounds));
            long openTime = android.os.SystemClock.uptimeMillis();
            android.view.MotionEvent openDown = android.view.MotionEvent.obtain(openTime, openTime, android.view.MotionEvent.ACTION_DOWN, openBounds.exactCenterX(), openBounds.exactCenterY(), 0);
            android.view.MotionEvent openUp = android.view.MotionEvent.obtain(openTime, openTime + 60, android.view.MotionEvent.ACTION_UP, openBounds.exactCenterX(), openBounds.exactCenterY(), 0);
            openDown.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN); openUp.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
            try { assertTrue(getInstrumentation().getUiAutomation().injectInputEvent(openDown, true)); assertTrue(getInstrumentation().getUiAutomation().injectInputEvent(openUp, true)); }
            finally { openDown.recycle(); openUp.recycle(); }
            captureFooter(activity, "process-collapse-opened");
            getInstrumentation().runOnMainSync(() -> {
                android.widget.ScrollView pane = root.findViewWithTag("footerFixtureScroll");
                android.graphics.Rect target = new android.graphics.Rect(0, 0, collapse.getWidth(), collapse.getHeight());
                pane.offsetDescendantRectToMyCoords(collapse, target);
                pane.scrollTo(0, target.top - pane.getPaddingTop() - new ChatStyle(activity).dp(12));
            });
            getInstrumentation().waitForIdleSync();
            captureFooter(activity, "process-collapse-before");
            android.graphics.Rect hit = new android.graphics.Rect();
            assertTrue(collapse.getHeight() >= new ChatStyle(activity).dp(48));
            assertTrue("The footer must still be visible after the native frame", collapse.getGlobalVisibleRect(hit));
            long now = android.os.SystemClock.uptimeMillis();
            android.view.MotionEvent down = android.view.MotionEvent.obtain(now, now, android.view.MotionEvent.ACTION_DOWN, hit.exactCenterX(), hit.exactCenterY(), 0);
            android.view.MotionEvent up = android.view.MotionEvent.obtain(now, now + 60, android.view.MotionEvent.ACTION_UP, hit.exactCenterX(), hit.exactCenterY(), 0);
            down.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN); up.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
            try { assertTrue(getInstrumentation().getUiAutomation().injectInputEvent(down, true)); assertTrue(getInstrumentation().getUiAutomation().injectInputEvent(up, true)); }
            finally { down.recycle(); up.recycle(); }
            getInstrumentation().waitForIdleSync();
            captureFooter(activity, "process-collapse-after");
            assertEquals(View.GONE, root.findViewWithTag("processBody:long-footer").getVisibility());
            assertEquals(View.GONE, root.findViewWithTag("processCollapseFooter:long-footer").getVisibility());
            assertEquals(View.VISIBLE, root.findViewWithTag("processBody:other-footer").getVisibility());
            assertEquals(View.VISIBLE, root.findViewWithTag("footerFixtureAnswer").getVisibility());
            View header = root.findViewWithTag("processToggle:long-footer");
            android.graphics.Rect visible = new android.graphics.Rect(); assertTrue(header.getGlobalVisibleRect(visible));
            assertTrue("The process summary must be fully visible after collapsing from its bottom", visible.height() >= header.getHeight() - 1);
        } finally { NativeActivityCleanup.finish(getInstrumentation(), activity); }
    }

    private void captureFooter(android.app.Activity activity, String name) throws Exception {
        java.util.concurrent.CountDownLatch frames = new java.util.concurrent.CountDownLatch(1);
        getInstrumentation().runOnMainSync(() -> android.view.Choreographer.getInstance().postFrameCallback(first ->
            android.view.Choreographer.getInstance().postFrameCallback(second -> frames.countDown())));
        assertTrue("The native process layout must paint before inspection", frames.await(5, java.util.concurrent.TimeUnit.SECONDS));
        var screenshot = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(screenshot);
        try (var out = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), name + ".png"))) {
            screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out);
        } finally { screenshot.recycle(); }
    }

    public void testUserBubbleHugsRightAndAssistantUsesLeft() throws Throwable {
        runTestOnUiThread(() -> {
            var context = getInstrumentation().getTargetContext(); ChatStyle style = new ChatStyle(context);
            LinearLayout parent = new LinearLayout(context); parent.setOrientation(LinearLayout.VERTICAL);
            LinearLayout user = style.messageBlock(true), assistant = style.messageBlock(false);
            TextView body = new TextView(context); body.setText("你好"); user.addView(body);
            TextView answer = new TextView(context); answer.setText("Hello"); assistant.addView(answer);
            parent.addView(user); parent.addView(assistant);
            parent.measure(View.MeasureSpec.makeMeasureSpec(1000, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2000, View.MeasureSpec.AT_MOST));
            parent.layout(0, 0, 1000, parent.getMeasuredHeight());
            assertEquals(1000, user.getRight()); assertTrue(user.getLeft() > 0); assertEquals(0, assistant.getLeft());
            assertTrue(user.getWidth() < assistant.getWidth()); assertNull(assistant.getBackground());
        });
    }

    public void testCompletedHeaderDoesNotRepeatCompletionState() throws Throwable {
        runTestOnUiThread(() -> {
            try {
                var context = getInstrumentation().getTargetContext();
                ExecutionProcessView.State state = new ExecutionProcessView.State();
                JSONArray process = new JSONArray().put(new JSONObject().put("type", "tool")
                    .put("title", "Shell").put("text", "test").put("status", "completed"));
                ExecutionProcessView view = new ExecutionProcessView(context, new ChatStyle(context), state, "turn");
                view.update(process, false, new TurnDetails(new JSONObject().put("state", "complete").put("duration_ms", 138000)), 1);
                LinearLayout header = (LinearLayout) view.findViewWithTag("processToggle:turn");
                String caption = ((TextView) header.getChildAt(1)).getText().toString();
                String marker = caption.contains("已完成") ? "已完成" : "Completed";
                int first = caption.indexOf(marker);
                assertTrue(first >= 0);
                assertTrue(caption.indexOf(marker, first + marker.length()) < 0);
                assertTrue(caption.contains("耗时") || caption.contains("Elapsed"));
            } catch (Exception error) {
                throw new AssertionError(error);
            }
        });
    }

    public void testToolCardsKeepSeparateExactInputAndOutputAcrossLiveUpdates() throws Throwable {
        runTestOnUiThread(() -> {
            try {
                var context = getInstrumentation().getTargetContext();
                ExecutionProcessView.State state = new ExecutionProcessView.State();
                JSONObject command = new JSONObject().put("type", "tool").put("id", "command-1").put("title", "commandExecution")
                    .put("input", "Get-Content -LiteralPath 'D:\\Code\\Camellia\\src\\main.js'\nGet-Date").put("status", "in_progress");
                JSONArray entries = new JSONArray().put(command);
                ExecutionProcessView process = new ExecutionProcessView(context, new ChatStyle(context), state, "cards");
                process.update(entries, true); process.findViewWithTag("processToggle:cards").performClick();
                View toggle = process.findViewWithTag("processToolToggle:cards:tool:command-1");
                assertNotNull(toggle);
                assertEquals(View.GONE, process.findViewWithTag("processToolBody:cards:tool:command-1").getVisibility());
                assertNull(process.findViewWithTag("processTool:output:cards:tool:command-1"));
                TextView summary = (TextView) process.findViewWithTag("processToolSummary:cards:tool:command-1");
                assertTrue(summary.getText().toString().contains("Get-Content")); assertFalse(summary.getText().toString().contains("\n"));
                toggle.performClick();
                TextView input = (TextView) process.findViewWithTag("processTool:input:cards:tool:command-1");
                assertEquals(command.getString("input"), input.getText().toString()); assertTrue(input.isTextSelectable());
                TextView pending = (TextView) process.findViewWithTag("processTool:output:cards:tool:command-1");
                assertTrue(pending.getText().toString().contains("Waiting") || pending.getText().toString().contains("等待"));
                command.put("text", "Cannot find path.\nExit code: 1").put("status", "failed").put("truncated", true);
                process.update(entries, true);
                assertEquals(View.VISIBLE, process.findViewWithTag("processToolBody:cards:tool:command-1").getVisibility());
                TextView result = (TextView) process.findViewWithTag("processTool:output:cards:tool:command-1");
                assertEquals(command.getString("text"), result.getText().toString()); assertTrue(result.isTextSelectable());
                assertEquals(Palette.of(context).error, result.getCurrentTextColor());
                process.findViewWithTag("processToolToggle:cards:tool:command-1").performClick();
                assertEquals(View.GONE, process.findViewWithTag("processToolBody:cards:tool:command-1").getVisibility());
                process.update(entries, true);
                assertEquals(View.GONE, process.findViewWithTag("processToolBody:cards:tool:command-1").getVisibility());
            } catch (Exception error) { throw new AssertionError(error); }
        });
    }

    public void testLocalWebArgumentsAndEmptyCompletedOutputStayReadable() throws Throwable {
        runTestOnUiThread(() -> {
            try {
                var context = getInstrumentation().getTargetContext();
                String arguments = new JSONObject().put("query", "Camellia Android WiFi").toString();
                ProcessToolView card = new ProcessToolView(context, new ChatStyle(context), new ExecutionProcessView.State(), "web",
                    new JSONObject().put("title", "web_search").put("input", arguments).put("status", "completed"));
                TextView summary = (TextView) card.findViewWithTag("processToolSummary:web");
                assertEquals("Camellia Android WiFi", summary.getText().toString());
                card.findViewWithTag("processToolToggle:web").performClick();
                assertEquals(arguments, ((TextView) card.findViewWithTag("processTool:input:web")).getText().toString());
                TextView output = (TextView) card.findViewWithTag("processTool:output:web");
                assertTrue(output.getText().toString().equals("No output") || output.getText().toString().equals("无输出"));
                card.findViewWithTag("processToolToggle:web").performAccessibilityAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_COLLAPSE, null);
                assertEquals(View.GONE, card.findViewWithTag("processToolBody:web").getVisibility());
            } catch (Exception error) { throw new AssertionError(error); }
        });
    }

    public void testNativeToolCardsFitPhoneAndLargeTextWithBoundedLongOutput() throws Exception {
        var context = getInstrumentation().getTargetContext();
        android.app.Activity activity = getInstrumentation().startActivitySync(new android.content.Intent(context, MarkdownTestActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var visual = MobilePreferences.wrap(activity);
                    ChatStyle style = new ChatStyle(visual);
                    LinearLayout page = new LinearLayout(activity); page.setOrientation(LinearLayout.VERTICAL);
                    page.setPadding(style.dp(16), style.dp(12), style.dp(16), style.dp(16)); page.setBackgroundColor(style.background);
                    android.widget.ScrollView scroll = ScrollViews.plain(activity); scroll.setFillViewport(true); scroll.addView(page);
                    scroll.setOnApplyWindowInsetsListener((view, insets) -> {
                        var bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                        view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
                    });
                    activity.setContentView(scroll);
                    TextView title = new TextView(activity); title.setText("Camellia · " + (visual.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh") ? "执行过程" : "Execution process"));
                    title.setTextColor(style.ink); title.setTextSize(18); title.setPadding(0, 0, 0, style.dp(16)); page.addView(title);
                    JSONArray entries = new JSONArray().put(new JSONObject().put("type", "text").put("text", "检查连接选路逻辑与实际日志。\nInspect routing and connection logs."))
                        .put(new JSONObject().put("type", "tool").put("title", "commandExecution").put("input", "Get-Content src/main/remote/network.js").put("text", "Cannot find path.\nExit code: 1").put("status", "failed"))
                        .put(new JSONObject().put("type", "tool").put("title", "commandExecution").put("input", "rg --files src/main/remote").put("text", "src/main/remote/transport.js\nsrc/main/remote/read-model.js").put("status", "completed"))
                        .put(new JSONObject().put("type", "tool").put("title", "mcp__camellia__camellia_web_search_a_very_long_tool_name").put("input", "Camellia Android WiFi network routing").put("status", "in_progress"));
                    ExecutionProcessView process = new ExecutionProcessView(visual, style, new ExecutionProcessView.State(), "visual");
                    process.update(entries, true); page.addView(process); process.findViewWithTag("processToggle:visual").performClick();
                    process.findViewWithTag("processToolToggle:visual:tool:1").performClick();
                    ProcessToolView longCard = new ProcessToolView(visual, style, new ExecutionProcessView.State(), "long",
                        new JSONObject().put("title", "commandExecution").put("input", "Get-Content connection.log").put("text", "line of output\n".repeat(200)).put("status", "cancelled"));
                    page.addView(longCard); longCard.findViewWithTag("processToolToggle:long").performClick();
                    activity.getWindow().getDecorView().setTag("executionVisual");
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                View root = activity.getWindow().getDecorView();
                TextView longOutput = (TextView) root.findViewWithTag("processTool:output:long");
                View panel = (View) longOutput.getParent();
                assertTrue(panel.getHeight() <= new ChatStyle(activity).dp(220));
                assertTrue(longOutput.getHeight() > panel.getHeight());
                for (String key : new String[]{"visual:tool:1", "visual:tool:2", "visual:tool:3", "long"}) {
                    View toggle = root.findViewWithTag("processToolToggle:" + key);
                    assertTrue(toggle.getWidth() > 0); assertTrue(toggle.getHeight() >= new ChatStyle(activity).dp(48));
                    android.widget.LinearLayout row = (android.widget.LinearLayout) toggle;
                    View status = row.getChildAt(row.getChildCount() - 1);
                    assertTrue(status.getWidth() > 0); assertTrue(status.getRight() <= toggle.getWidth());
                    assertTrue(status.getLeft() > row.getChildAt(1).getRight());
                }
            });
            android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
            assertNotNull(screenshot);
            if ("true".equals(((android.test.InstrumentationTestRunner) getInstrumentation()).getArguments().getString("landscape")))
                assertTrue("Landscape must be measured, not just requested", screenshot.getWidth() > screenshot.getHeight());
            try (var file = new java.io.FileOutputStream(new java.io.File(context.getExternalFilesDir(null), "native-execution-cards.png"))) {
                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, file);
            } finally { screenshot.recycle(); }
        } finally { NativeActivityCleanup.finish(getInstrumentation(), activity); }
    }

    public void testMissingToolStatusDoesNotInventALiveCall() throws Throwable {
        runTestOnUiThread(() -> {
            try {
                var context = getInstrumentation().getTargetContext();
                ProcessToolView card = new ProcessToolView(context, new ChatStyle(context), new ExecutionProcessView.State(), "unknown",
                    new JSONObject().put("title", "Read"));
                View toggle = card.findViewWithTag("processToolToggle:unknown");
                String description = toggle.getContentDescription().toString();
                assertTrue(description.contains("Unknown") || description.contains("未知"));
                toggle.performClick();
                String output = ((TextView) card.findViewWithTag("processTool:output:unknown")).getText().toString();
                assertTrue(output.equals("No output") || output.equals("无输出"));
            } catch (Exception error) { throw new AssertionError(error); }
        });
    }

    public void testRemoteConversationShowsCompactToolCards() throws Exception {
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        android.app.Activity activity = getInstrumentation().startActivitySync(new android.content.Intent(context, MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var id = MainActivity.class.getDeclaredField("conversationId"); id.setAccessible(true); id.set(activity, "preview");
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                    var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true);
                    boolean zh = activity.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
                    JSONArray entries = new JSONArray().put(new JSONObject().put("type", "text").put("text", zh
                        ? "我先查看连接选路逻辑，以及这台 HP 上的实际连接日志。" : "Checking connection routing and the logs on this HP."))
                        .put(new JSONObject().put("type", "tool").put("title", "commandExecution").put("input", "Get-Content src/main/remote/network.js").put("text", "Cannot find path.\nExit code: 1").put("status", "failed"))
                        .put(new JSONObject().put("type", "tool").put("title", "commandExecution").put("input", "rg --files src/main/remote").put("text", "transport.js\nread-model.js").put("status", "completed"))
                        .put(new JSONObject().put("type", "tool").put("title", "Read").put("input", "src/main/remote/transport.js").put("text", "Connection routing").put("status", "completed"))
                        .put(new JSONObject().put("type", "tool").put("title", "commandExecution").put("input", "Get-Content connection.log -Tail 40").put("status", "in_progress"));
                    JSONObject snapshot = new JSONObject().put("conversation", new JSONObject().put("id", "preview").put("title", zh ? "连接问题排查" : "Connection diagnostics"))
                        .put("instanceId", "preview-host").put("cursor", 1).put("messages", new JSONArray().put(new JSONObject().put("seq", 1).put("role", "user").put("text", zh ? "帮我检查连接日志" : "Check the connection logs")))
                        .put("live", new JSONObject().put("userSeq", 1).put("text", "").put("process", entries));
                    apply.invoke(activity, snapshot);
                    View root = activity.getWindow().getDecorView(); root.findViewWithTag("processToggle:preview:turn:1").performClick();
                    PageTransitions transitions = root.findViewWithTag("pageTransitions"); if (transitions != null) transitions.finishTransition();
                    assertNotNull(root.findViewWithTag("processToolToggle:preview:turn:1:tool:4"));
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(screenshot);
            try (var file = new java.io.FileOutputStream(new java.io.File(context.getExternalFilesDir(null), "native-remote-tool-cards.png"))) {
                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, file);
            } finally { screenshot.recycle(); }
        } finally { NativeActivityCleanup.finish(getInstrumentation(), activity); }
    }
}
