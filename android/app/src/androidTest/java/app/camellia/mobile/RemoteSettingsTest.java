package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

public class RemoteSettingsTest extends InstrumentationTestCase {
    private static void field(Activity activity, String name, Object value) throws Exception {
        var field = MainActivity.class.getDeclaredField(name); field.setAccessible(true); field.set(activity, value);
    }
    private static Object field(Object target, String name) throws Exception {
        var field = target.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(target);
    }
    public void testRemoteSearchHasNoOuterFrame() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    field(activity, "credentials", new JSONObject());
                    var list = MainActivity.class.getDeclaredMethod("listScreen"); list.setAccessible(true); list.invoke(activity);
                    View root = activity.getWindow().getDecorView();
                    LinearLayout bar = root.findViewWithTag("searchBar");
                    assertNull("The search row must not draw a second frame behind the search pill", bar.getBackground());
                    assertEquals(0f, bar.getElevation(), 0f); assertEquals(0f, bar.getTranslationZ(), 0f);
                    View pill = bar.getChildAt(0);
                    ChatStyle style = new ChatStyle(activity);
                    assertNotNull(pill.getBackground());
                    assertEquals(style.dp(7), pill.getElevation(), 0f); assertEquals(style.dp(1), pill.getTranslationZ(), 0f);
                    assertNotNull(root.findViewWithTag("searchBarDock").getBackground());
                    assertNotNull(root.findViewWithTag("searchBarFade").getBackground());
                    assertNotNull(root.findViewWithTag("newIndependent").getBackground());
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally {
            getInstrumentation().runOnMainSync(activity::finish);
            getInstrumentation().waitForIdleSync();
        }
    }

    public void testRemoteTitleFollowsSnapshotsWithoutRebuildingComposer() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    String id = "12345678-1234-1234-1234-123456789abc";
                    field(activity, "conversationId", id);
                    field(activity, "conversationTitle", "New session");
                    field(activity, "credentials", new JSONObject());
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                    var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true);
                    View root = activity.getWindow().getDecorView();
                    TextView heading = root.findViewWithTag("pageTitle");
                    android.widget.EditText composer = (android.widget.EditText) field(activity, "composer");
                    composer.setText("Unsent draft"); composer.setSelection(4);
                    assertEquals("New session", heading.getText().toString());
                    JSONObject conversation = new JSONObject().put("id", id).put("seq", 1).put("title", "Generated title");
                    JSONObject snapshot = new JSONObject().put("instanceId", "preview").put("cursor", 2).put("permission", "control")
                        .put("conversation", conversation).put("messages", new JSONArray()).put("nextBefore", JSONObject.NULL);
                    apply.invoke(activity, snapshot);
                    assertEquals("Generated title", heading.getText().toString());
                    assertEquals("Generated title", field(activity, "conversationTitle"));
                    conversation.put("title", "Stale title"); snapshot.put("cursor", 1); apply.invoke(activity, snapshot);
                    assertEquals("Generated title", heading.getText().toString());
                    conversation.put("title", "Manual title"); snapshot.put("cursor", 3); apply.invoke(activity, snapshot);
                    assertEquals("Manual title", heading.getText().toString());
                    assertEquals("Manual title", field(activity, "conversationTitle"));
                    conversation.put("id", "another-conversation").put("title", "Wrong title");
                    snapshot.put("cursor", 4); apply.invoke(activity, snapshot);
                    assertEquals("Manual title", heading.getText().toString());
                    assertSame(composer, field(activity, "composer"));
                    assertEquals("Unsent draft", composer.getText().toString());
                    assertEquals(4, composer.getSelectionStart());
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally {
            getInstrumentation().runOnMainSync(activity::finish);
            getInstrumentation().waitForIdleSync();
        }
    }

    public void testRemoteComposerSettingsAndNeutralTitles() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    String id = "12345678-1234-1234-1234-123456789abc";
                    field(activity, "conversationId", id);
                    field(activity, "credentials", new JSONObject());
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                    var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true);
                    JSONObject settings = new JSONObject().put("model", "test-model").put("thinking", "high").put("permissionMode", "auto").put("editable", true).put("version", "one")
                        .put("models", new JSONArray().put(new JSONObject().put("id", "test-model").put("thinking", new JSONArray().put("high")))
                            .put(new JSONObject().put("id", "second-model").put("thinking", new JSONArray())));
                    JSONObject snapshot = new JSONObject().put("instanceId", "preview").put("cursor", 1).put("permission", "control").put("settings", settings)
                        .put("conversation", new JSONObject().put("id", id).put("seq", 0)).put("messages", new JSONArray()).put("nextBefore", JSONObject.NULL);
                    apply.invoke(activity, snapshot);
                    View root = activity.getWindow().getDecorView();
                    assertTrue(root.findViewWithTag("remoteModelPicker").isEnabled());
                    assertTrue(root.findViewWithTag("remotePermissionPicker").isEnabled());
                    settings.put("editable", false); snapshot.put("cursor", 2); apply.invoke(activity, snapshot);
                    assertFalse(root.findViewWithTag("remoteModelPicker").isEnabled());
                    settings.put("editable", true); snapshot.put("cursor", 3); apply.invoke(activity, snapshot);
                    var card = MainActivity.class.getDeclaredMethod("conversationCard", JSONObject.class); card.setAccessible(true);
                    JSONObject conversation = new JSONObject().put("title", "Same title").put("activity", "running");
                    LinearLayout running = (LinearLayout) card.invoke(activity, conversation);
                    conversation.put("activity", "idle"); LinearLayout idle = (LinearLayout) card.invoke(activity, conversation);
                    assertEquals(((TextView) idle.getChildAt(0)).getCurrentTextColor(), ((TextView) running.getChildAt(0)).getCurrentTextColor());
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    View anchor = activity.getWindow().getDecorView().findViewWithTag("remoteModelPicker");
                    anchor.performClick();
                    RemoteSettingsPopup selector = (RemoteSettingsPopup) field(activity, "settingsPopup");
                    PopupWindow popup = (PopupWindow) field(selector, "popup");
                    assertTrue(popup.isShowing());
                    View panel = popup.getContentView();
                    assertTrue(panel instanceof PopupSurface);
                    assertNotNull(((TextView) anchor).getCompoundDrawablesRelative()[2]);
                    View second = panel.findViewWithTag("remoteModelOption:second-model"); assertNotNull(second);
                    assertTrue(second.getBackground() instanceof android.graphics.drawable.RippleDrawable);
                    panel.findViewWithTag("remoteThinkingSettings").performClick();
                    LinearLayout back = (LinearLayout) panel.findViewWithTag("remoteThinkingBack");
                    assertFalse(((TextView) ((LinearLayout) back.getChildAt(0)).getChildAt(0)).getText().toString().startsWith("‹"));
                    assertTrue(back.getChildAt(back.getChildCount() - 1) instanceof android.widget.ImageView);
                    assertTrue(panel.findViewWithTag("remoteThinkingOption:high").isSelected());
                    selector.dismiss();
                    activity.getWindow().getDecorView().findViewWithTag("remotePermissionPicker").performClick();
                    selector = (RemoteSettingsPopup) field(activity, "settingsPopup"); popup = (PopupWindow) field(selector, "popup");
                    assertTrue(popup.getContentView().findViewWithTag("remotePermissionOption:auto").isSelected());
                    assertNotNull(popup.getContentView().findViewWithTag("remotePermissionOption:full"));
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            android.graphics.Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot();
            try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), "remote-settings.png"))) {
                image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
            }
            image.recycle();
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }
}
