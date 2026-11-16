package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

public class ChatPreferencesTest extends InstrumentationTestCase {
    private Context context;
    @Override protected void setUp() throws Exception {
        super.setUp(); context = getInstrumentation().getTargetContext();
        LocalChatFixture.clear(context);
        context.getSharedPreferences("mobile-preferences", 0).edit().clear().commit();
        context.getSharedPreferences("markdown", 0).edit().clear().commit();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        ChatNotifications.clear(context);
    }
    @Override protected void tearDown() throws Exception {
        ChatNotifications.clear(context);
        context.getSharedPreferences("mobile-preferences", 0).edit().clear().commit();
        context.getSharedPreferences("markdown", 0).edit().clear().commit();
        LocalChatFixture.clear(context); super.tearDown();
    }
    private void ui(Runnable action) {
        var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private View root(Activity activity) { return activity.getWindow().getDecorView(); }
    private float sp(Activity activity, float value) {
        // Android 14+ scales fonts nonlinearly; scaledDensity multiplication is not an SP conversion.
        return android.util.TypedValue.applyDimension(android.util.TypedValue.COMPLEX_UNIT_SP, value, activity.getResources().getDisplayMetrics());
    }
    private void assertNoticeCount(NotificationManager manager, int expected) {
        long deadline = android.os.SystemClock.uptimeMillis() + 3000;
        while (manager.getActiveNotifications().length != expected && android.os.SystemClock.uptimeMillis() < deadline)
            android.os.SystemClock.sleep(20);
        assertEquals(expected, manager.getActiveNotifications().length);
    }
    private Activity settings(String section) {
        return LocalChatFixture.start(getInstrumentation(), new Intent(context, SettingsActivity.class)
            .putExtra("section", section).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_MULTIPLE_TASK));
    }
    private void choose(Activity activity, String key, int index) {
        root(activity).findViewWithTag("preference:" + key).performClick();
        try {
            var member = SettingsActivity.class.getDeclaredField("choiceDropdown"); member.setAccessible(true);
            ((ChoiceDropdown) member.get(activity)).panel.findViewWithTag("dropdownChoice:" + index).performClick();
        } catch (Exception error) { throw new AssertionError(error); }
    }

    public void testReadingChoicesPersistAndScaleRealMarkdownUserMessagesAndComposer() throws Throwable {
        Activity activity = settings("reading");
        try {
            ui(() -> {
                choose(activity, "chatFontSize", 3);
                assertEquals("largest", MobilePreferences.get(activity, "chatFontSize"));
                TextView code = root(activity).findViewWithTag("markdownCodeText");
                assertEquals(sp(activity, 13f * 1.3f), code.getTextSize(), .1f);
                View rendered = new MarkdownView(activity, Color.BLACK, Color.GRAY, Color.WHITE, Color.BLUE).render("Chat body");
                assertEquals(sp(activity, 15f * 1.3f), ((TextView) ((LinearLayout) rendered).getChildAt(0)).getTextSize(), .1f);
                ChatStyle style = new ChatStyle(activity);
                TextView user = new TextView(activity); user.setTextSize(16); style.messageTypography(user);
                assertEquals(sp(activity, 16f * 1.3f), user.getTextSize(), .1f);
                ChatComposer composer = new ChatComposer(new LinearLayout(activity), style, false, "", 10000, () -> {}, () -> {}, () -> {}, () -> {});
                assertEquals(sp(activity, Palette.TEXT_ROW * 1.3f), composer.input.getTextSize(), .1f);
                root(activity).findViewWithTag("preference:codeWrap").performClick();
                assertTrue(MobilePreferences.codeWrap(activity));
                choose(activity, "processMode", 1);
                assertEquals("live", MobilePreferences.get(activity, "processMode"));
            });
        } finally { ui(activity::finish); }
        Activity reopened = settings("reading");
        try {
            ui(() -> {
                assertTrue(((android.widget.Switch) root(reopened).findViewWithTag("preference:codeWrap")).isChecked());
                TextView code = root(reopened).findViewWithTag("markdownCodeText");
                assertEquals("markdownCode", ((View) code.getParent()).getTag());
                assertEquals("largest", MobilePreferences.get(reopened, "chatFontSize"));
                assertTrue(MobilePreferences.processExpanded(reopened, true));
                assertFalse(MobilePreferences.processExpanded(reopened, false));
            });
        } finally { ui(reopened::finish); }
    }

    public void testCodeSettingAndInlineButtonSharePreferenceAndPreserveCopiedCode() throws Throwable {
        Activity activity = settings("reading");
        try {
            ui(() -> {
                MobilePreferences.codeWrap(activity, true);
                String source = "a long code line that should wrap instead of scrolling horizontally\n";
                View first = new MarkdownView(activity, Color.BLACK, Color.GRAY, Color.WHITE, Color.BLUE).render("```text\n" + source + "```");
                activity.setContentView(first);
                TextView code = first.findViewWithTag("markdownCodeText");
                assertEquals("markdownCode", ((View) code.getParent()).getTag());
                first.findViewWithTag("markdownCodeCopy").performClick();
                android.content.ClipboardManager clipboard = activity.getSystemService(android.content.ClipboardManager.class);
                assertEquals(source, clipboard.getPrimaryClip().getItemAt(0).getText().toString());
                first.findViewWithTag("markdownCodeWrap").performClick();
                assertFalse(MobilePreferences.codeWrap(activity));
                assertEquals("markdownCodeScroll", ((View) code.getParent()).getTag());
                View second = new MarkdownView(activity, Color.BLACK, Color.GRAY, Color.WHITE, Color.BLUE).render("```text\nnext\n```");
                assertFalse(second.findViewWithTag("markdownCodeWrap").isSelected());
            });
        } finally { ui(activity::finish); }
    }

    public void testProcessPolicyRespectsManualChoiceAndFoldsAfterCompletion() throws Throwable {
        ui(() -> {
            try {
                JSONArray entries = new JSONArray().put(new JSONObject().put("type", "thinking").put("text", "Reasoning"));
                MobilePreferences.set(context, "processMode", "live");
                ExecutionProcessView process = new ExecutionProcessView(context, new ChatStyle(context), new ExecutionProcessView.State(), "preview");
                process.update(entries, true);
                assertEquals(View.VISIBLE, process.findViewWithTag("processBody:preview").getVisibility());
                process.findViewWithTag("processToggle:preview").performClick(); process.update(entries, true);
                assertEquals(View.GONE, process.findViewWithTag("processBody:preview").getVisibility());
                process.update(entries, false);
                assertEquals(View.GONE, process.findViewWithTag("processBody:preview").getVisibility());
                MobilePreferences.set(context, "processMode", "expanded");
                ExecutionProcessView history = new ExecutionProcessView(context, new ChatStyle(context), new ExecutionProcessView.State(), "history");
                history.update(entries, false);
                assertEquals(View.VISIBLE, history.findViewWithTag("processBody:history").getVisibility());
                history.findViewWithTag("processToggle:history").performClick(); history.update(entries, false);
                assertEquals(View.GONE, history.findViewWithTag("processBody:history").getVisibility());
            } catch (Exception error) { throw new AssertionError(error); }
        });
    }

    public void testNotificationGatesPostRealAlertsAndCancelOnlyChatNotifications() throws Throwable {
        boolean granted = android.os.Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED;
        if (android.os.Build.VERSION.SDK_INT >= 33 && !granted)
            getInstrumentation().getUiAutomation().grantRuntimePermission(context.getPackageName(), android.Manifest.permission.POST_NOTIFICATIONS);
        Activity activity = settings("notifications");
        try {
            ui(() -> {
                try {
                    assertFalse(ChatNotifications.enabled(activity));
                    String id = java.util.UUID.randomUUID().toString();
                    ChatNotifications notices = new ChatNotifications();
                    notices.local(activity, id, 1, "Test chat", "complete", false);
                    NotificationManager manager = activity.getSystemService(NotificationManager.class);
                    assertNoticeCount(manager, 0);
                    root(activity).findViewWithTag("preference:chatNotifications").performClick();
                    assertTrue(ChatNotifications.enabled(activity));
                    notices.local(activity, id, 1, "Test chat", "complete", false);
                    assertNoticeCount(manager, 0);
                    notices.local(activity, id, 2, "Test chat", "complete", true);
                    assertNoticeCount(manager, 0);
                    root(activity).findViewWithTag("preference:notifyForeground").performClick();
                    notices.local(activity, id, 3, "Test chat", "complete", true);
                    assertNoticeCount(manager, 1);
                    assertEquals("chat-reply", manager.getActiveNotifications()[0].getNotification().getChannelId());
                    root(activity).findViewWithTag("preference:notify:reply").performClick();
                    assertNoticeCount(manager, 0);
                    notices.local(activity, id, 4, "Test chat", "complete", false);
                    assertNoticeCount(manager, 0);
                    notices.local(activity, id, 5, "Test chat", "error", false);
                    assertNoticeCount(manager, 1);
                    assertEquals("chat-error", manager.getActiveNotifications()[0].getNotification().getChannelId());
                    root(activity).findViewWithTag("preference:chatNotifications").performClick();
                    assertNoticeCount(manager, 0);
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally {
            ui(activity::finish);
            // Revoking this process's permission kills the instrumentation runner.
            // The disposable emulator is shut down by the host after the suite.
        }
    }
}
