package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/** Unsaved native forms must outlive the page rebuilt underneath them. */
public class DialogRotationTest extends InstrumentationTestCase {
    private Activity activity;
    private AlertDialog dialog;
    private String oldTheme, oldLanguage;

    @Override protected void setUp() throws Exception {
        super.setUp(); var context = getInstrumentation().getTargetContext();
        oldTheme = MobilePreferences.get(context, "theme"); oldLanguage = MobilePreferences.get(context, "language");
        MobilePreferences.set(context, "theme", (context.getResources().getConfiguration().uiMode & 48) == 32 ? "dark" : "light");
        MobilePreferences.set(context, "language", "zh-CN");
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false); new CredentialStore(context).clear();
        NativeActivityCleanup.prepareTabletLandscape(getInstrumentation());
    }

    @Override protected void tearDown() throws Exception {
        try {
            if (dialog != null) ui(() -> dialog.dismiss());
            NativeActivityCleanup.finish(getInstrumentation(), activity);
            var context = getInstrumentation().getTargetContext(); LocalChatFixture.clear(context); new CredentialStore(context).clear();
            MobilePreferences.set(context, "theme", oldTheme); MobilePreferences.set(context, "language", oldLanguage);
        } finally { super.tearDown(); }
    }

    public void testLocalWorkspaceDraftAndTypingSurviveBothRotations() throws Exception {
        var context = getInstrumentation().getTargetContext(); LocalChatFixture.clear(context);
        LocalChatFixture fixture = new LocalChatFixture(context); JSONObject workspace = fixture.createWorkspace("Original workspace");
        activity = LocalChatFixture.start(getInstrumentation(), new Intent(context, LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        rotate(true);
        ui(() -> invoke("nameDialog", JSONObject.class, workspace));
        dialog = (AlertDialog) read(activity, "dialog"); verifyForm("localWorkspaceName");
        ui(() -> dialog.getButton(AlertDialog.BUTTON_NEGATIVE).performClick());
        assertEquals("Cancelling must not save the rotated draft", "Original workspace", new LocalChatFixture(context).workspaces().getJSONObject(0).getString("name"));
    }

    public void testLocalConversationRenameKeepsTheDraftAndCancel() throws Exception {
        var context = getInstrumentation().getTargetContext(); LocalChatFixture.clear(context);
        LocalChatFixture fixture = new LocalChatFixture(context); JSONObject conversation = fixture.createConversation("", "missing-route");
        String original = conversation.optString("title");
        activity = LocalChatFixture.start(getInstrumentation(), new Intent(context, LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        rotate(true);
        ui(() -> invoke("renameConversation", JSONObject.class, conversation));
        dialog = (AlertDialog) read(activity, "dialog"); verifyForm("localRename");
        ui(() -> dialog.getButton(AlertDialog.BUTTON_NEGATIVE).performClick());
        assertEquals(original, new LocalChatFixture(context).conversation(conversation.getString("id")).optString("title"));
    }

    public void testComputerRenameKeepsItsEditorWithoutChangingTheSavedName() throws Exception {
        var context = getInstrumentation().getTargetContext();
        JSONObject computer = new JSONObject().put("address", "http://100.80.1.22:43127").put("token", "r".repeat(43)).put("computerName", "Original computer");
        ComputerStore store = new ComputerStore(new CredentialStore(context, "rotation-computer-test")); store.save(computer);
        activity = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        rotate(true);
        ui(() -> {
            set("foreground", false); invoke("stopNetwork"); EmbeddedNetwork.setNetworkListener(null);
            set("store", store); set("credentials", computer); invoke("computersScreen");
            invoke("renameComputer", JSONObject.class, computer);
        });
        dialog = (AlertDialog) read(activity, "computerDialog"); verifyForm("computerNameInput");
        ui(() -> dialog.getButton(AlertDialog.BUTTON_NEGATIVE).performClick());
        assertEquals("Original computer", store.load().getString("computerName"));
        ui(() -> { invoke("renameComputer", JSONObject.class, computer); dialog = (AlertDialog) read(activity, "computerDialog"); invoke("homeScreen"); });
        assertFalse("Normal navigation must still dismiss the obsolete form", dialog.isShowing());
    }

    public void testComputerRemarkLeavesTheComputersOwnNameIntact() throws Exception {
        var context = getInstrumentation().getTargetContext();
        JSONObject computer = new JSONObject().put("address", "http://100.80.1.23:43127")
            .put("token", "s".repeat(43)).put("computerName", "Original computer");
        ComputerStore store = new ComputerStore(new CredentialStore(context, "rotation-computer-remark-test")); store.save(computer);
        store.rename(computer.getString("address"), "Local label");
        assertEquals("Original computer", store.load().getString("computerName"));
        assertEquals("Local label", store.load().getString("remark"));
        store.updateComputerName(computer.getString("address"), "Renamed on desktop");
        assertEquals("Renamed on desktop", store.load().getString("computerName"));
        assertEquals("Local label", store.load().getString("remark"));
        store.clearRemark(computer.getString("address"));
        assertEquals("Renamed on desktop", store.load().getString("computerName"));
        assertFalse(store.load().has("remark"));
        new CredentialStore(context, "rotation-computer-remark-test").clear();
    }

    public void testQueueEditorKeepsFocusAboveTheConversationAndClosesOnNavigation() throws Exception {
        var context = getInstrumentation().getTargetContext();
        activity = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        rotate(true);
        ui(() -> {
            set("foreground", false); invoke("stopNetwork"); EmbeddedNetwork.setNetworkListener(null);
            set("credentials", new JSONObject().put("address", "http://100.80.1.22:43127").put("token", "r".repeat(43)));
            set("conversationId", "queue-rotation"); invoke("detailScreen"); set("instance", "fixture");
            set("connected", true); set("controlAllowed", true);
            EditText composer = activity.getWindow().getDecorView().findViewWithTag("remoteComposer"); composer.setText("Background draft"); composer.requestFocus();
            var open = MainActivity.class.getDeclaredMethod("showQueueEditor", String.class, String.class, String.class); open.setAccessible(true);
            open.invoke(activity, "queued-entry", "old", "queue draft");
            dialog = (AlertDialog) DialogWindows.focused(activity);
        });
        verifyForm("remoteQueueEditor");
        assertEquals("Background draft", ((EditText) activity.getWindow().getDecorView().findViewWithTag("remoteComposer")).getText().toString());
        ui(() -> invoke("homeScreen"));
        assertFalse(dialog.isShowing()); assertNull(DialogWindows.focused(activity));
    }

    private void verifyForm(String tag) throws Exception {
        assertNotNull(dialog); assertTrue(dialog.isShowing());
        EditText editor = dialog.getWindow().getDecorView().findViewWithTag(tag); assertNotNull(editor);
        await(() -> dialog.getWindow().getDecorView().hasWindowFocus() && editor.isLaidOut(), "Wait for the form window before requesting its keyboard");
        ui(() -> { editor.setText("abcdef"); editor.requestFocus(); editor.setSelection(2, 4); keyboard().showSoftInput(editor, InputMethodManager.SHOW_IMPLICIT); });
        await(() -> ime() && keyboard().isActive(editor), "The form must own a real keyboard before rotating");
        rotate(false); assertTrue("Rotation must keep the unsaved form open", dialog.isShowing());
        assertSame(editor, dialog.getWindow().getDecorView().findViewWithTag(tag));
        await(() -> typingReady(editor), "The form must retain keyboard ownership");
        assertEquals(2, editor.getSelectionStart()); assertEquals(4, editor.getSelectionEnd());
        InputDeliveryFixture.type(getInstrumentation(), "x");
        assertEquals("abxef", editor.getText().toString());
        rotate(true); assertTrue(dialog.isShowing());
        await(() -> typingReady(editor), "Typing must also continue after rotating back");
        InputDeliveryFixture.type(getInstrumentation(), "y");
        assertEquals("abxyef", editor.getText().toString());
        ui(() -> keyboard().hideSoftInputFromWindow(editor.getWindowToken(), 0));
        await(() -> !ime(), "The keyboard must be dismissible"); rotate(false);
        assertTrue(dialog.isShowing()); assertEquals("abxyef", editor.getText().toString());
        assertFalse("Rotation must not reopen a manually dismissed keyboard", ime());
    }

    private boolean typingReady(EditText editor) {
        return editor.hasWindowFocus() && editor.hasFocus() && keyboard().isActive(editor) && ime();
    }
    private InputMethodManager keyboard() { return activity.getSystemService(InputMethodManager.class); }
    private boolean ime() { WindowInsets insets = dialog.getWindow().getDecorView().getRootWindowInsets(); return insets != null && insets.isVisible(WindowInsets.Type.ime()); }
    private void rotate(boolean landscape) throws Exception {
        ui(() -> activity.setRequestedOrientation(landscape ? ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
        await(() -> {
            var bounds = activity.getWindowManager().getCurrentWindowMetrics().getBounds();
            return (bounds.width() > bounds.height()) == landscape && activity.getResources().getConfiguration().orientation
                == (landscape ? Configuration.ORIENTATION_LANDSCAPE : Configuration.ORIENTATION_PORTRAIT);
        }, "System rotation must update the window and configuration");
        View decor = (dialog == null ? activity.getWindow() : dialog.getWindow()).getDecorView();
        RenderedFrameFixture.awaitFrames(getInstrumentation(), decor);
    }
    private static Object read(Object owner, String name) throws Exception { var f=owner.getClass().getDeclaredField(name); f.setAccessible(true); return f.get(owner); }
    private void set(String name, Object value) throws Exception { var f=activity.getClass().getDeclaredField(name); f.setAccessible(true); f.set(activity,value); }
    private void invoke(String name) throws Exception { var m=activity.getClass().getDeclaredMethod(name); m.setAccessible(true); m.invoke(activity); }
    private void invoke(String name, Class<?> type, Object value) throws Exception { var m=activity.getClass().getDeclaredMethod(name,type); m.setAccessible(true); m.invoke(activity,value); }
    private interface Step { void run() throws Exception; }
    private interface Check { boolean run() throws Exception; }
    private void ui(Step step) { AtomicReference<Throwable> error=new AtomicReference<>(); getInstrumentation().runOnMainSync(()->{try{step.run();}catch(Throwable e){error.set(e);}}); if(error.get()!=null)throw new AssertionError(error.get()); }
    private void await(Check check, String message) throws Exception {
        long deadline = android.os.SystemClock.uptimeMillis() + 6000;
        boolean[] ready = {false};
        do {
            ui(() -> ready[0] = check.run());
            if (!ready[0]) android.os.SystemClock.sleep(60);
        } while (!ready[0] && android.os.SystemClock.uptimeMillis() < deadline);
        assertTrue(message, ready[0]);
    }
}
