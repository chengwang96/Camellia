package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.Bitmap;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

/** Real window rotation, IME ownership and scrolling compositing regressions. */
public class TabletInteractionTest extends InstrumentationTestCase {
    private Activity activity;
    private String previousTheme, previousLanguage;

    @Override protected void setUp() throws Exception {
        super.setUp(); var context = getInstrumentation().getTargetContext();
        previousTheme = MobilePreferences.get(context, "theme"); previousLanguage = MobilePreferences.get(context, "language");
        boolean night = (context.getResources().getConfiguration().uiMode & 48) == 32;
        var arguments = ((android.test.InstrumentationTestRunner) getInstrumentation()).getArguments();
        MobilePreferences.set(context, "theme", night ? "dark" : "light"); MobilePreferences.set(context, "language", arguments.getString("language", "zh-CN"));
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false); new CredentialStore(context).clear();
    }

    @Override protected void tearDown() throws Exception {
        if (activity != null) {
            ui(() -> { keyboard().hideSoftInputFromWindow(activity.getWindow().getDecorView().getWindowToken(), 0); activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED); });
            NativeActivityCleanup.finish(getInstrumentation(), activity);
            getInstrumentation().waitForIdleSync();
        }
        var context = getInstrumentation().getTargetContext(); new CredentialStore(context).clear();
        LocalChatFixture.clear(context);
        MobilePreferences.set(context, "theme", previousTheme); MobilePreferences.set(context, "language", previousLanguage);
        super.tearDown();
    }

    public void testRemoteTypingAndSelectionContinueAfterBothRotations() throws Exception {
        openRemote(); if (!tablet()) return;
        verifyTypingAcrossRotation("remoteComposer");
    }

    public void testLocalTypingAndSelectionContinueAfterBothRotations() throws Exception {
        var context = getInstrumentation().getTargetContext(); LocalChatFixture.clear(context);
        LocalChatFixture store = new LocalChatFixture(context);
        String id = store.createConversation("", "missing-route").getString("id");
        activity = LocalChatFixture.start(getInstrumentation(), new Intent(context, LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        if (!tablet()) return;
        rotate(true);
        ui(() -> activity.getWindow().getDecorView().findViewWithTag("localConversation:" + id).performClick());
        await(() -> composer("localComposer") != null, "Local composer must load");
        verifyTypingAcrossRotation("localComposer");
    }

    public void testReadingRotationDoesNotOpenTheKeyboard() throws Exception {
        openRemote(); if (!tablet()) return;
        ui(() -> { ((LinearLayout) field("root")).requestFocus(); keyboard().hideSoftInputFromWindow(activity.getWindow().getDecorView().getWindowToken(), 0); });
        await(() -> !imeVisible(), "Keyboard must start hidden");
        rotate(false); assertFalse(composer("remoteComposer").hasFocus()); assertFalse(imeVisible());
    }

    public void testManuallyDismissedKeyboardStaysHiddenWhenTheEditorRotates() throws Exception {
        var context = getInstrumentation().getTargetContext(); LocalChatFixture.clear(context);
        activity = LocalChatFixture.start(getInstrumentation(), new Intent(context, LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        if (!tablet()) return; rotate(true);
        ui(() -> { EditText editor = composer("localSearch"); editor.setText("search"); editor.requestFocus(); });
        showEditorKeyboard("localSearch");
        await(this::imeVisible, "Open the search keyboard");
        rotate(false); await(this::imeVisible, "Keep the keyboard visible during the first rotation");
        ui(() -> keyboard().hideSoftInputFromWindow(composer("localSearch").getWindowToken(), 0));
        await(() -> !imeVisible(), "The user must be able to dismiss the keyboard");
        rotate(true); assertTrue(composer("localSearch").hasFocus());
        await(() -> keyboard().isActive(composer("localSearch")), "IME must reconnect to the focused search field");
        long heldUntil = android.os.SystemClock.uptimeMillis() + 750;
        do {
            ui(() -> assertFalse("Rotation must preserve the user's hidden keyboard", imeVisible()));
            android.os.SystemClock.sleep(50);
        } while (android.os.SystemClock.uptimeMillis() < heldUntil);
    }

    public void testRemoteListSearchKeepsTypingAcrossRotations() throws Exception {
        launchMain(); if (!tablet()) return; rotate(true);
        ui(() -> {
            set("foreground", false);
            set("credentials", new JSONObject().put("address", "http://100.80.1.7:43127").put("token", "a".repeat(43)));
            invoke("listScreen"); invoke("showConversationSearch");
        });
        verifyTypingAcrossRotation("remoteSearchInput");
    }

    public void testLocalListSearchKeepsTypingAcrossRotations() throws Exception {
        var context = getInstrumentation().getTargetContext(); LocalChatFixture.clear(context);
        activity = LocalChatFixture.start(getInstrumentation(), new Intent(context, LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        if (!tablet()) return; rotate(true);
        verifyTypingAcrossRotation("localSearch");
    }

    public void testSidebarSearchDoesNotLeaveAnOrphanedKeyboardInPortrait() throws Exception {
        openRemote(); if (!tablet()) return;
        ui(() -> {
            invoke("showConversationSearch"); EditText search = composer("remoteSearchInput"); search.setText("会话过滤"); search.requestFocus();
            keyboard().showSoftInput(search, InputMethodManager.SHOW_IMPLICIT);
        });
        await(this::imeVisible, "Sidebar search keyboard must open");
        rotate(false);
        await(() -> !imeVisible(), "An unavailable sidebar editor must dismiss its keyboard");
        assertFalse("Do not redirect sidebar input into the message composer", composer("remoteComposer").hasFocus());
        rotate(true);
        assertEquals("会话过滤", composer("remoteSearchInput").getText().toString()); assertFalse(imeVisible());
    }

    public void testBusyComposerKeepsItsDraftWithoutAnOrphanedKeyboard() throws Exception {
        openRemote(); if (!tablet()) return;
        ui(() -> {
            EditText editor = composer("remoteComposer"); editor.setText("Keep this pending draft"); editor.requestFocus();
            keyboard().showSoftInput(editor, InputMethodManager.SHOW_IMPLICIT);
        });
        await(this::imeVisible, "Composer keyboard must open");
        ui(() -> set("commandBusy", true)); rotate(false);
        assertFalse("Rotation must respect the disabled command state", composer("remoteComposer").isEnabled());
        assertEquals("Keep this pending draft", composer("remoteComposer").getText().toString());
        await(() -> !imeVisible(), "A disabled editor must not leave an active keyboard");
    }

    public void testSessionHeaderPixelsStayStableWhenTheListScrolls() throws Exception {
        launchMain();
        if (tablet()) rotate(true);
        ui(() -> {
            set("foreground", false); invoke("listScreen");
            set("credentials", new JSONObject().put("address", "http://100.80.1.7:43127").put("token", "a".repeat(43)));
            JSONArray rows = new JSONArray(), workspaces = new JSONArray();
            for (int i = 0; i < 35; i++) {
                workspaces.put(new JSONObject().put("id", "header-workspace-" + i).put("name", "工作区 " + i));
                rows.put(new JSONObject().put("id", "header-row-" + i).put("workspaceId", "header-workspace-" + i)
                    .put("workspaceName", "工作区 " + i).put("title", "滚动会话列表 " + i).put("engine", "codex"));
            }
            RemoteListCache.get(activity).put((JSONObject) field("credentials"), rows, -1, workspaces, true);
            invoke("listScreen");
            set("canCreate", true); set("canCreateWorkspace", true); invoke("renderConversations");
        });
        android.os.SystemClock.sleep(500); getInstrumentation().waitForIdleSync();
        View header = ((LinearLayout) field("root")).getChildAt(0); int[] origin = new int[2]; header.getLocationOnScreen(origin);
        Bitmap before = getInstrumentation().getUiAutomation().takeScreenshot();
        ui(() -> ((ScrollView) field("scroll")).scrollTo(0, 420));
        android.os.SystemClock.sleep(300); getInstrumentation().waitForIdleSync();
        Bitmap after = getInstrumentation().getUiAutomation().takeScreenshot();
        try {
            save(after, "native-session-header-scrolled");
            int changed = 0;
            for (int y = origin[1] + 2; y < origin[1] + header.getHeight() - 2; y++)
                for (int x = origin[0] + 2; x < origin[0] + header.getWidth() - 2; x++)
                    if (before.getPixel(x, y) != after.getPixel(x, y)) changed++;
            assertTrue("Scrolling list must not paint over the fixed header; changed pixels=" + changed, changed < 20);
        } finally { before.recycle(); after.recycle(); }
    }

    private void openRemote() throws Exception {
        launchMain(); if (!tablet()) return; rotate(true);
        ui(() -> {
            set("foreground", false);
            set("credentials", new JSONObject().put("address", "http://100.80.1.7:43127").put("token", "a".repeat(43)));
            set("conversationId", "rotation-input"); set("conversationTitle", "旋转后继续输入"); invoke("detailScreen");
        });
    }

    private void launchMain() {
        activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().waitForIdleSync();
    }

    private void verifyTypingAcrossRotation(String tag) throws Exception {
        ui(() -> {
            EditText editor = composer(tag); editor.setText("abcdef"); editor.requestFocus(); editor.setSelection(2, 4);
        });
        showEditorKeyboard(tag);
        await(this::imeVisible, "Real IME must open before rotating");
        rotate(false);
        assertTrue("The replacement composer must retain input focus", composer(tag).hasFocus());
        assertEquals(2, composer(tag).getSelectionStart()); assertEquals(4, composer(tag).getSelectionEnd());
        await(() -> keyboard().isActive(composer(tag)), "IME must serve the replacement composer");
        await(() -> composer(tag).hasWindowFocus() && imeVisible(), "The visible keyboard must remain open after rotation");
        InputDeliveryFixture.type(getInstrumentation(), "x");
        assertEquals("Typing must replace the selected range", "abxef", composer(tag).getText().toString());
        assertEquals("Typing must leave the cursor after the inserted character", 3, composer(tag).getSelectionStart());
        rotate(true);
        assertTrue(composer(tag).hasFocus()); await(() -> keyboard().isActive(composer(tag)), "IME must reconnect after rotating back");
        await(this::imeVisible, "The keyboard must remain visible after rotating back");
        android.os.SystemClock.sleep(700); getInstrumentation().waitForIdleSync();
        await(() -> composer(tag).hasWindowFocus() && imeVisible(), "The replacement editor must retain its keyboard after the old session closes");
        assertEquals("The restored cursor must remain in place after layout and IME attachment", 3, composer(tag).getSelectionStart());
        InputDeliveryFixture.type(getInstrumentation(), "y");
        assertEquals("abxyef", composer(tag).getText().toString());
        Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
        try { save(screenshot, "native-" + tag + "-rotation-input"); } finally { screenshot.recycle(); }
    }

    private void showEditorKeyboard(String tag) throws Exception {
        await(() -> keyboard().isActive(composer(tag)), "IME must serve the focused editor before opening");
        ui(() -> keyboard().showSoftInput(composer(tag), InputMethodManager.SHOW_IMPLICIT));
    }

    private EditText composer(String tag) { return activity.getWindow().getDecorView().findViewWithTag(tag); }
    private InputMethodManager keyboard() { return activity.getSystemService(InputMethodManager.class); }
    private boolean imeVisible() {
        WindowInsets insets = activity.getWindow().getDecorView().getRootWindowInsets();
        return insets != null && insets.isVisible(WindowInsets.Type.ime());
    }
    private boolean tablet() {
        var bounds = activity.getWindowManager().getMaximumWindowMetrics().getBounds();
        return !MobileOrientation.isPhoneSize(bounds.width(), bounds.height(), activity.getResources().getDisplayMetrics().density);
    }
    private void rotate(boolean landscape) throws Exception {
        ui(() -> activity.setRequestedOrientation(landscape ? ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
        await(() -> {
            var configuration = activity.getResources().getConfiguration();
            var bounds = activity.getWindowManager().getCurrentWindowMetrics().getBounds();
            return (bounds.width() > bounds.height()) == landscape && (configuration.screenWidthDp > configuration.screenHeightDp) == landscape;
        }, "Real system rotation must update the window and configuration");
        android.os.SystemClock.sleep(450); getInstrumentation().waitForIdleSync();
    }
    private interface Check { boolean ready() throws Exception; }
    private void await(Check check, String message) throws Exception {
        long deadline = android.os.SystemClock.uptimeMillis() + 6000; boolean[] ready = {false};
        while (!ready[0] && android.os.SystemClock.uptimeMillis() < deadline) {
            ui(() -> ready[0] = check.ready()); if (!ready[0]) android.os.SystemClock.sleep(50);
        }
        assertTrue(message, ready[0]);
    }
    private Object field(String name) throws Exception { var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); return member.get(activity); }
    private void set(String name, Object value) throws Exception { var member = MainActivity.class.getDeclaredField(name); member.setAccessible(true); member.set(activity, value); }
    private void invoke(String name) throws Exception { var method = MainActivity.class.getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity); }
    private interface Step { void run() throws Exception; }
    private void ui(Step step) { getInstrumentation().runOnMainSync(() -> { try { step.run(); } catch (Exception error) { throw new AssertionError(error); } }); getInstrumentation().waitForIdleSync(); }
    private void save(Bitmap image, String name) throws Exception {
        assertNotNull(image); try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), name + ".png"))) {
            image.compress(Bitmap.CompressFormat.PNG, 100, output);
        }
    }
}
