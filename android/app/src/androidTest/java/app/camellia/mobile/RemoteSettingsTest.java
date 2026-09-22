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
                    assertNotNull(panel.findViewWithTag("remoteModelOption:second-model"));
                    panel.findViewWithTag("remoteThinkingSettings").performClick();
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
