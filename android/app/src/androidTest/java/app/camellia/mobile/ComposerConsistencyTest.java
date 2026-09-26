package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

// The local and remote conversation screens share one composer, so the elements
// inside the input row must stay interchangeable: same order, same sizes, the
// same icon colour while idle and the same "model · thinking level" wording.
public class ComposerConsistencyTest extends InstrumentationTestCase {
    private CredentialStore encrypted;

    @Override protected void setUp() throws Exception {
        super.setUp();
        encrypted = new CredentialStore(getInstrumentation().getTargetContext(), "local-chat-private");
        encrypted.clear();
        MobilePreferences.set(getInstrumentation().getTargetContext(), "language", "zh-CN");
    }

    @Override protected void tearDown() throws Exception { encrypted.clear(); super.tearDown(); }

    public void testBothModesRenderTheSameComposerElements() throws Exception {
        Activity local = localConversation();
        String[] localRow;
        try {
            idle();
            capture(local, "composer-local");
            localRow = describe(local, "localComposerBar", "localModel", "localTools");
        } finally { getInstrumentation().runOnMainSync(local::finish); idle(); }
        Activity remote = remoteConversation();
        String[] remoteRow;
        try {
            idle();
            capture(remote, "composer-remote");
            remoteRow = describe(remote, "composerBar", "remoteModelPicker", "remoteAttach");
        } finally { getInstrumentation().runOnMainSync(remote::finish); idle(); }
        assertEquals("The input, model and send elements must match in both modes", localRow[0], remoteRow[0]);
        assertEquals("Sol · 默认", localRow[1]);
        assertEquals("The remote button shows the same abbreviation and localised level", "Sol · 进阶", remoteRow[1]);
        assertEquals("Idle tool icons must share one colour", localRow[2], remoteRow[2]);
    }

    // Returns [trailing element signature, model label, idle tool icon colour].
    private String[] describe(Activity activity, String barTag, String modelTag, String toolTag) throws Exception {
        String[] result = new String[3];
        getInstrumentation().runOnMainSync(() -> {
            View root = activity.getWindow().getDecorView();
            ViewGroup tools = (ViewGroup) root.findViewWithTag("composerTools");
            int modelIndex = tools.indexOfChild(root.findViewWithTag(modelTag));
            assertTrue("The model button must sit in the composer tools row", modelIndex > 0);
            for (int index = 0; index < modelIndex; index++) {
                View tool = tools.getChildAt(index);
                assertTrue("Composer tools must be icon buttons, not " + tool.getClass().getSimpleName(), tool instanceof ImageButton);
                assertEquals(dp(activity, 48), tool.getLayoutParams().height);
                assertEquals(dp(activity, 48), tool.getLayoutParams().width);
            }
            StringBuilder signature = new StringBuilder();
            for (int index = modelIndex; index < tools.getChildCount(); index++) {
                View child = tools.getChildAt(index);
                signature.append(child.getClass().getSimpleName()).append(':')
                    .append(child.getLayoutParams().width).append('x').append(child.getLayoutParams().height).append(';');
            }
            result[0] = signature.toString();
            result[1] = ((TextView) root.findViewWithTag(modelTag)).getText().toString();
            result[2] = Integer.toHexString(((LineIcon) ((ImageButton) root.findViewWithTag(toolTag)).getDrawable()).color());
            assertEquals("The model label must hug the chevron and send button", android.view.Gravity.RIGHT,
                ((TextView) root.findViewWithTag(modelTag)).getGravity() & android.view.Gravity.HORIZONTAL_GRAVITY_MASK);
            assertTrue("The composer bar must stay the shared floating bar", root.findViewWithTag(barTag) != null);
        });
        return result;
    }

    private int dp(Activity activity, int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }

    private Activity localConversation() throws Exception {
        LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext());
        JSONObject provider = new JSONObject().put("id", "example").put("name", "Example").put("protocol", "openai")
            .put("baseUrl", "https://example.com/v1").put("keys", new JSONArray().put(new JSONObject().put("key", "test-key")))
            .put("models", new JSONArray().put(new JSONObject().put("id", "gpt-5.6-sol").put("upstream", "gpt-5.6-sol")));
        store.importConfig(LocalChatConfig.parse(new JSONObject().put("format", "camellia-api-routes").put("version", 2)
            .put("config", new JSONObject().put("providers", new JSONArray().put(provider))).toString()));
        String routeId = LocalChatConfig.routes(store.config()).get(0).id;
        // A standalone chat keeps the row directly in the list; a workspace group
        // may start collapsed depending on earlier tests.
        JSONObject conversation = store.createConversation("", routeId);
        conversation.put("title", "Composer comparison");
        conversation.getJSONArray("messages").put(new JSONObject().put("role", "user").put("at", 1790056800000L).put("content", "Hello"));
        store.save();
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        idle();
        String row = "localConversation:" + conversation.optString("id");
        long deadline = android.os.SystemClock.uptimeMillis() + 5_000;
        while (activity.getWindow().getDecorView().findViewWithTag(row) == null && android.os.SystemClock.uptimeMillis() < deadline) {
            Thread.sleep(100); idle();
        }
        getInstrumentation().runOnMainSync(() -> activity.getWindow().getDecorView().findViewWithTag(row).performClick());
        idle();
        return activity;
    }

    private Activity remoteConversation() throws Exception {
        MainActivity activity = (MainActivity) getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        idle();
        getInstrumentation().runOnMainSync(() -> {
            try {
                field(activity, "conversationId", "12345678-1234-1234-1234-123456789abc");
                invoke(activity, "detailScreen");
                field(activity, "remoteSettings", new JSONObject().put("model", "gpt-5.6-sol").put("thinking", "high")
                    .put("permissionMode", "ask").put("editable", true));
                field(activity, "connected", true);
                field(activity, "controlAllowed", true);
                invoke(activity, "updateControls");
                ((EditText) activity.getWindow().getDecorView().findViewWithTag("remoteComposer")).setText("Draft");
            } catch (Exception error) { throw new AssertionError(error); }
        });
        return activity;
    }

    private void field(Activity activity, String name, Object value) throws Exception {
        java.lang.reflect.Field member = MainActivity.class.getDeclaredField(name);
        member.setAccessible(true); member.set(activity, value);
    }

    private void invoke(Activity activity, String name) throws Exception {
        java.lang.reflect.Method method = activity.getClass().getDeclaredMethod(name);
        method.setAccessible(true); method.invoke(activity);
    }

    private void capture(Activity activity, String name) throws Exception {
        android.os.SystemClock.sleep(600); idle();
        Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
        try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), name + ".png"))) {
            screenshot.compress(Bitmap.CompressFormat.PNG, 100, output);
        } finally { screenshot.recycle(); }
    }

    // A remote conversation keeps fetching in the background, so an unbounded
    // waitForIdleSync can block until the process is killed; this is bounded.
    private void idle() {
        try { getInstrumentation().getUiAutomation().waitForIdle(200, 3000); }
        catch (Exception ignored) { }
    }
}
