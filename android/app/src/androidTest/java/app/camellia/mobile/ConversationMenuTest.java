package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import org.json.JSONObject;

public class ConversationMenuTest extends InstrumentationTestCase {
    private CredentialStore encrypted;
    private Activity activity;

    @Override protected void setUp() throws Exception {
        super.setUp();
        assertTrue("This test clears local conversations; use a disposable Android emulator, not a personal phone",
            android.os.Build.HARDWARE.equals("ranchu") || android.os.Build.HARDWARE.equals("goldfish"));
    }

    private interface Check { void run() throws Exception; }
    private void stage(String name) {
        android.os.Bundle progress = new android.os.Bundle();
        progress.putString("stream", "\nConversation menu: " + name + "\n");
        getInstrumentation().sendStatus(0, progress);
    }
    private void ui(Check check) {
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable error) { failure.set(error); } });
        getInstrumentation().waitForIdleSync();
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    private Object field(String name) throws Exception {
        var field = activity.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(activity);
    }

    private void set(String name, Object value) throws Exception {
        var field = activity.getClass().getDeclaredField(name); field.setAccessible(true); field.set(activity, value);
    }

    private View root() { return activity.getWindow().getDecorView(); }
    private ConversationMenu menu() throws Exception { return (ConversationMenu) field("conversationPopup"); }

    @Override protected void tearDown() throws Exception {
        if (activity != null) ui(() -> activity.finish());
        if (encrypted != null) encrypted.clear();
        super.tearDown();
    }

    public void testLocalLongPressGlassRenamePinAndMultiSelection() throws Exception {
        stage("initialize encrypted fixture");
        encrypted = new CredentialStore(getInstrumentation().getTargetContext(), "local-chat-private"); encrypted.clear();
        LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext());
        JSONObject first = store.createConversation("", "missing-route"), second = store.createConversation("", "missing-route");
        first.put("title", "First chat"); second.put("title", "Second chat"); store.save();
        String id = first.getString("id"), other = second.getString("id");
        stage("launch local conversation list");
        activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        stage("open long-press menu");
        ui(() -> {
            View row = root().findViewWithTag("localConversation:" + id);
            assertNull(root().findViewWithTag("localConversationMenu:" + id));
            assertTrue(row.performLongClick()); assertEquals(1f, row.getAlpha()); assertEquals(0f, row.getTranslationY());
            ViewGroup scroll = (ViewGroup) menu().panel.getChildAt(menu().panel.getChildCount() - 1);
            assertEquals(4, ((ViewGroup) scroll.getChildAt(0)).getChildCount());
            if (PopupSurface.supportsBlur(activity)) assertNotNull(menu().panel.findViewWithTag("glassBackdrop"));
        });
        stage("capture menu screenshot");
        android.graphics.Bitmap shot = getInstrumentation().getUiAutomation().takeScreenshot();
        if (shot != null) {
            try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), "conversation-menu.png"))) {
                shot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
            } finally { shot.recycle(); }
        }
        stage("pin conversation");
        ui(() -> menu().panel.findViewWithTag("conversationAction:pin").performClick());
        assertTrue(new LocalChatStore(activity).conversation(id).getBoolean("pinned"));
        assertEquals(id, new LocalChatStore(activity).orderedConversations("").get(0).getString("id"));
        stage("rename conversation");
        ui(() -> root().findViewWithTag("localConversation:" + id).performLongClick());
        ui(() -> menu().panel.findViewWithTag("conversationAction:edit").performClick());
        ui(() -> {
            AlertDialog dialog = (AlertDialog) field("dialog");
            ((EditText) dialog.findViewById(android.R.id.content).findViewWithTag("localRename")).setText("New title");
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
        });
        assertEquals("New title", new LocalChatStore(activity).conversation(id).getString("title"));
        stage("select and delete conversations");
        ui(() -> root().findViewWithTag("localConversation:" + id).performLongClick());
        ui(() -> menu().panel.findViewWithTag("conversationAction:select").performClick());
        stage("select second conversation");
        ui(() -> root().findViewWithTag("localConversation:" + other).performClick());
        assertEquals(2, ((java.util.Set<?>) field("selectedConversations")).size());
        stage("open delete confirmation");
        ui(() -> root().findViewWithTag("selectionDelete").performClick());
        ui(() -> ((AlertDialog) field("dialog")).getButton(AlertDialog.BUTTON_NEGATIVE).performClick());
        stage("verify cancelled deletion");
        assertNotNull(new LocalChatStore(activity).conversation(id));
        ui(() -> root().findViewWithTag("selectionDelete").performClick());
        ui(() -> ((AlertDialog) field("dialog")).getButton(AlertDialog.BUTTON_POSITIVE).performClick());
        stage("verify confirmed deletion");
        assertNull(new LocalChatStore(activity).conversation(id)); assertNull(new LocalChatStore(activity).conversation(other));
    }

    public void testRemoteRowHasLongPressMenuAndMultiSelectWithoutOpeningChat() throws Exception {
        activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        JSONObject conversation = new JSONObject().put("id", "12345678-1234-1234-1234-123456789abc").put("title", "Remote chat").put("seq", 1);
        ui(() -> {
            var stop = MainActivity.class.getDeclaredMethod("stopNetwork"); stop.setAccessible(true); stop.invoke(activity);
            set("screen", "list"); set("canManageConversations", true);
            ((java.util.Map<String, JSONObject>) field("conversations")).put(conversation.getString("id"), conversation);
            var card = MainActivity.class.getDeclaredMethod("conversationCard", JSONObject.class); card.setAccessible(true);
            View row = (View) card.invoke(activity, conversation);
            ((ViewGroup) field("content")).addView(row);
            assertNull(row.findViewWithTag("remoteConversationMenu:" + conversation.getString("id")));
        });
        ui(() -> root().findViewWithTag("conversation:" + conversation.getString("id")).performLongClick());
        ui(() -> menu().panel.findViewWithTag("conversationAction:select").performClick());
        assertTrue((Boolean) field("selectingConversations"));
        assertEquals(1, ((java.util.Set<?>) field("selectedConversations")).size());
        ui(() -> root().findViewWithTag("conversation:" + conversation.getString("id")).performClick());
        assertTrue(((java.util.Set<?>) field("selectedConversations")).isEmpty());
        ui(() -> activity.onBackPressed());
        assertFalse((Boolean) field("selectingConversations"));
    }
}
