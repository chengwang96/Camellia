package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import org.json.JSONArray;
import org.json.JSONObject;

public class RemoteAttachmentRenderingTest extends InstrumentationTestCase {
    public void testAttachmentPreviewPathIsAllowlistedWithoutOpeningOtherRoutes() {
        Endpoint endpoint = new Endpoint("http://100.64.0.1:43127");
        String base = "/v1/conversations/12345678-1234-1234-1234-123456789abc/attachments/";
        assertNotNull(endpoint.uri(base + "42/0"));
        assertNotNull(endpoint.uri(base + "999999999999/19"));
        for (String path : new String[]{base + "0/0", base + "42/20", base + "42/0?x=1", base + "42/0/"})
            try { endpoint.uri(path); fail("Accepted " + path); }
            catch (IllegalArgumentException expected) { }
    }

    public void testSentAttachmentsKeepImageAndFileIdentity() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(
            new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    JSONArray files = new JSONArray()
                        .put(new JSONObject().put("name", "screen.jpg").put("isImage", true))
                        .put(new JSONObject().put("name", "notes.pdf").put("isImage", false).put("size", 120));
                    View tray = RemoteAttachmentTray.create(activity, new ChatStyle(activity), files, 9,
                        "http://100.64.0.1:43127", "t".repeat(43), "12345678-1234-1234-1234-123456789abc", true);
                    assertNotNull(tray);
                    assertEquals("screen.jpg", findByTag(tray, "remoteAttachmentImage:0").getContentDescription());
                    assertNotNull(findText(tray, "notes.pdf"));
                } catch (Exception error) {
                    throw new AssertionError(error);
                }
            });
        } finally {
            getInstrumentation().runOnMainSync(activity::finish);
        }
    }

    public void testRemoteHistoryPassesAttachmentsIntoTheUserBubble() throws Exception {
        Activity activity = getInstrumentation().startActivitySync(
            new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    JSONArray files = new JSONArray()
                        .put(new JSONObject().put("name", "screen.jpg").put("isImage", true))
                        .put(new JSONObject().put("name", "notes.pdf").put("isImage", false).put("size", 120));
                    set(activity, "chatStyle", new ChatStyle(activity));
                    set(activity, "chinese", true);
                    set(activity, "conversationId", "12345678-1234-1234-1234-123456789abc");
                    set(activity, "credentials", new JSONObject());
                    var method = MainActivity.class.getDeclaredMethod("addMessage", String.class, String.class,
                        String.class, boolean.class, boolean.class, JSONArray.class, boolean.class, String.class,
                        long.class, long.class, JSONObject.class, JSONArray.class);
                    method.setAccessible(true);
                    method.invoke(activity, "message:5", "You", "Summary", true, false, null, false,
                        "turn:5", 1L, 5L, null, files);
                    View bubble = (View) ((java.util.Map<?, ?>) field(activity, "renderedMessages")).get("message:5");
                    assertNotNull(findByTag(bubble, "remoteAttachmentImage:0"));
                    assertNotNull(findText(bubble, "notes.pdf"));
                } catch (Exception error) {
                    throw new AssertionError(error);
                }
            });
        } finally {
            getInstrumentation().runOnMainSync(activity::finish);
        }
    }

    private static Object field(Object target, String name) throws Exception {
        var member = target.getClass().getDeclaredField(name);
        member.setAccessible(true);
        return member.get(target);
    }

    private static void set(Object target, String name, Object value) throws Exception {
        var member = target.getClass().getDeclaredField(name);
        member.setAccessible(true);
        member.set(target, value);
    }

    private static View findByTag(View root, String tag) {
        if (tag.equals(root.getTag())) return root;
        if (root instanceof ViewGroup) for (int index = 0; index < ((ViewGroup) root).getChildCount(); index++) {
            View found = findByTag(((ViewGroup) root).getChildAt(index), tag);
            if (found != null) return found;
        }
        return null;
    }

    private static android.widget.TextView findText(View root, String value) {
        if (root instanceof android.widget.TextView && ((android.widget.TextView) root).getText().toString().equals(value))
            return (android.widget.TextView) root;
        if (root instanceof ViewGroup) for (int index = 0; index < ((ViewGroup) root).getChildCount(); index++) {
            android.widget.TextView found = findText(((ViewGroup) root).getChildAt(index), value);
            if (found != null) return found;
        }
        return null;
    }
}
