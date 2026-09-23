package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

public class LocalChatStyleTest extends InstrumentationTestCase {
    private CredentialStore encrypted;

    @Override protected void setUp() throws Exception {
        super.setUp(); encrypted = new CredentialStore(getInstrumentation().getTargetContext(), "local-chat-private"); encrypted.clear();
    }

    @Override protected void tearDown() throws Exception { encrypted.clear(); super.tearDown(); }

    public void testWorkspaceAndDetailShareRemoteDesign() throws Exception {
        LocalChatStore store = new LocalChatStore(getInstrumentation().getTargetContext());
        JSONObject provider = new JSONObject().put("id", "example").put("name", "Example").put("protocol", "openai")
            .put("baseUrl", "https://example.com/v1").put("keys", new JSONArray().put(new JSONObject().put("key", "test-key")))
            .put("models", new JSONArray().put(new JSONObject().put("id", "test-model").put("upstream", "test-model")));
        store.importConfig(LocalChatConfig.parse(new JSONObject().put("format", "camellia-api-routes").put("version", 2)
            .put("config", new JSONObject().put("providers", new JSONArray().put(provider))).toString()));
        String routeId = LocalChatConfig.routes(store.config()).get(0).id;
        JSONObject workspace = store.createWorkspace("Research");
        String workspaceId = workspace.getString("id");
        JSONObject conversation = store.createConversation(workspaceId, routeId);
        String conversationId = conversation.getString("id");
        conversation.put("title", "Review experiment results");
        conversation.getJSONArray("messages").put(new JSONObject().put("role", "user").put("at", 1790056800000L).put("content", "不需要，我可能会用这个程序，所以重启的时机需要我自己控制"))
            .put(new JSONObject().put("role", "assistant").put("at", 1790056860000L).put("content", "明白，不加热重载——开发版现在就保持原样跑着，你手动控制重启时机，正在进行的会话也不会被打断。\n\n当前状态确认一下：\n\n- 开发版 `npm run dev` 正在后台运行，窗口已打开\n- 本机安装的 Camellia 已彻底卸载，开始菜单无残留\n- 新打好的安装包还在 `dist` 里，以后想装回正式版随时双击即可\n\n祝用得顺手，有别的需要随时叫我。")
                .put("process", new JSONArray().put(new JSONObject().put("type", "thinking").put("text", "Compare the reported results with the baseline before summarizing."))));
        store.createConversation("", routeId).put("title", "Plan the next release"); store.save();
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                View root = activity.getWindow().getDecorView();
                View group = root.findViewWithTag("localGroup:" + workspaceId);
                LinearLayout header = (LinearLayout) group.getParent();
                assertTrue(header.getChildAt(0) instanceof ImageView);
                assertTrue(group instanceof DisclosureHeader);
                assertTrue(root.findViewWithTag("localWorkspaceMenu:" + workspaceId) instanceof ImageButton);
                assertTrue(root.findViewWithTag("localAdd:" + workspaceId) instanceof ImageButton);
                assertTrue(root.findViewWithTag("localBack") instanceof ImageButton);
                assertEquals(dp(4), root.findViewWithTag("localBack").getElevation(), 0f);
                assertNotNull(root.findViewWithTag("localBack").getStateListAnimator());
                assertTrue(root.findViewWithTag("localNewStandalone") instanceof ImageButton);
                View row = root.findViewWithTag("localConversation:" + conversationId);
                assertEquals(dp(32), row.getPaddingLeft());
                View bar = root.findViewWithTag("localSearchBar"), status = root.findViewWithTag("localStatus");
                assertDockInsets(bar, status);
                assertFalse(((ViewGroup) bar.getParent()).getClipChildren());
                assertFalse(((ViewGroup) bar.getParent()).getClipToPadding());
                assertFalse(((ViewGroup) bar).getClipChildren());
                assertTrue(bar.getBottom() <= status.getTop());
                boolean chinese = activity.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
                String localStatus = chinese ? "本机模式 · 聊天记录仅保存在此设备" : "Local mode · Chat history stays on this device";
                assertEquals(localStatus, ((TextView) status).getText().toString());
                group.performClick(); assertNull(root.findViewWithTag("localConversation:" + conversationId));
                root.findViewWithTag("localGroup:" + workspaceId).performClick();
                EditText search = root.findViewWithTag("localSearch"); search.setText("not found");
                assertEquals(localStatus, ((TextView) status).getText().toString());
                assertNull(root.findViewWithTag("localConversation:" + conversationId)); search.setText("");
                assertNotNull(root.findViewWithTag("localConversation:" + conversationId));
            });
            screenshot(activity, "local-workspaces-unified");
            getInstrumentation().runOnMainSync(() -> activity.getWindow().getDecorView().findViewWithTag("localConversation:" + conversationId).performClick());
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                View root = activity.getWindow().getDecorView();
                EditText composer = root.findViewWithTag("localComposer");
                View model = root.findViewWithTag("localModel");
                assertEquals((float) dp(2), model.getElevation());
                assertTrue(model.getBackground() instanceof android.graphics.drawable.RippleDrawable);
                if (android.os.Build.VERSION.SDK_INT >= 28) {
                    assertEquals(0x18000000, model.getOutlineAmbientShadowColor());
                    assertEquals(0x20000000, model.getOutlineSpotShadowColor());
                }
                assertFalse(composer.isVerticalScrollBarEnabled());
                try {
                    var scrollField = LocalChatActivity.class.getDeclaredField("scroll"); scrollField.setAccessible(true);
                    assertFalse(((View) scrollField.get(activity)).isVerticalScrollBarEnabled());
                } catch (Exception error) { throw new AssertionError(error); }
                assertFalse(composer.hasFocus());
                View send = root.findViewWithTag("localSend"), stop = root.findViewWithTag("localStop");
                assertTrue(send instanceof ImageButton); assertTrue(stop instanceof ImageButton);
                assertFalse(send.isEnabled()); assertEquals(View.GONE, stop.getVisibility());
                composer.setText("   "); assertFalse(send.isEnabled()); composer.setText("Draft for later"); assertTrue(send.isEnabled());
                assertEquals(dp(48), send.getWidth()); assertEquals(dp(48), send.getHeight());
                assertTrue(composer.getRight() <= send.getLeft());
                View bar = root.findViewWithTag("localComposerBar"), status = root.findViewWithTag("localStatus");
                assertDockInsets(bar, status);
                assertFalse(((ViewGroup) bar.getParent()).getClipToPadding());
                assertTrue(bar.getBottom() <= status.getTop());
                ViewGroup user = root.findViewWithTag("localMessage:0"), assistant = root.findViewWithTag("localMessage:1");
                assertNotNull(user.getBackground()); assertNull(assistant.getBackground());
                assertEquals(dp(14), user.getPaddingLeft());
                assertEquals(0, ((LinearLayout.LayoutParams) user.getLayoutParams()).bottomMargin);
                assertEquals(android.view.Gravity.END, ((LinearLayout.LayoutParams) user.getLayoutParams()).gravity);
                assertEquals(15f * activity.getResources().getDisplayMetrics().scaledDensity, ((TextView) user.getChildAt(0)).getTextSize(), .1f);
                assertEquals((float) dp(7), ((TextView) user.getChildAt(0)).getLineSpacingExtra());
                for (ViewGroup message : new ViewGroup[] { user, assistant }) {
                    ViewGroup wrapper = (ViewGroup) message.getParent();
                    TextView timestamp = wrapper.findViewWithTag("messageTimestamp"); assertNotNull(timestamp);
                    assertTrue(timestamp.getText().length() > 0);
                    View footer = wrapper.findViewWithTag("messageFooter");
                    assertEquals(message == user ? android.view.Gravity.END : android.view.Gravity.START,
                        ((LinearLayout.LayoutParams) footer.getLayoutParams()).gravity);
                    wrapper.findViewWithTag("copyMessage").performClick();
                    android.content.ClipboardManager clipboard = (android.content.ClipboardManager) activity.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
                    assertTrue(clipboard.getPrimaryClip().getItemAt(0).getText().toString().startsWith(message == user ? "不需要" : "明白"));
                }
                assertNotNull(root.findViewWithTag("localModel"));
                assertEquals(View.GONE, root.findViewWithTag("processBody:" + conversationId + ":1").getVisibility());
                root.findViewWithTag("processToggle:" + conversationId + ":1").performClick();
                assertEquals(View.VISIBLE, root.findViewWithTag("processBody:" + conversationId + ":1").getVisibility());
                root.findViewWithTag("processToggle:" + conversationId + ":1").performClick();
                composer.setText("First line\nSecond line\nThird line");
            });
            getInstrumentation().waitForIdleSync();
            screenshot(activity, "local-conversation-unified");
            getInstrumentation().runOnMainSync(() -> {
                View root = activity.getWindow().getDecorView();
                View composer = root.findViewWithTag("localComposer"), send = root.findViewWithTag("localSend");
                assertTrue(composer.getHeight() > dp(48)); assertTrue(composer.getRight() <= send.getLeft());
                activity.onBackPressed();
            });
            assertEquals("First line\nSecond line\nThird line", new LocalChatStore(getInstrumentation().getTargetContext()).conversation(conversationId).getString("draft"));
        } finally { getInstrumentation().runOnMainSync(activity::finish); getInstrumentation().waitForIdleSync(); }
    }

    private void assertDockInsets(View bar, View status) {
        assertEquals(dp(2), status.getPaddingTop()); assertEquals(dp(2), status.getPaddingBottom());
        assertEquals(dp(8), ((LinearLayout.LayoutParams) bar.getLayoutParams()).bottomMargin);
        View parent = (View) bar.getParent();
        View fade = ((ViewGroup) parent).getChildAt(0);
        assertEquals(bar.getTag() + "Fade", fade.getTag()); assertEquals(dp(36), fade.getHeight());
        assertTrue(fade.getBackground() instanceof android.graphics.drawable.GradientDrawable);
        assertNotNull("The dock must mask body content behind the composer and status line", parent.getBackground());
        assertTrue("The dock backdrop below the fade band must be fully opaque, or scrolled text shows through",
            isOpaqueBelowFade(parent.getBackground()));
        android.graphics.Rect backdropPadding = new android.graphics.Rect();
        parent.getBackground().getPadding(backdropPadding);
        assertEquals("The dock backdrop must not pad its view, or the fade band shifts below the mask",
            0, backdropPadding.top);
        assertEquals(0, backdropPadding.bottom);
        assertEquals(0, backdropPadding.left);
        assertEquals(0, backdropPadding.right);
        assertEquals("The dock must not inherit backdrop padding", 0, parent.getPaddingTop());
        assertEquals("The fade band must sit flush at the dock top so the gradient starts where the mask begins",
            0, fade.getTop());
        assertTrue("The backdrop must stay clear inside the fade band so the gradient composites over content",
            isClearInsideFade(parent.getBackground(), fade.getHeight()));
        assertDockFadeCompositesOverContent(bar, fade);
        assertTrue(parent.getLayoutParams() instanceof android.widget.FrameLayout.LayoutParams);
        assertEquals(android.view.Gravity.BOTTOM, ((android.widget.FrameLayout.LayoutParams) parent.getLayoutParams()).gravity);
        if (!String.valueOf(bar.getTag()).contains("SearchBar")) {
            assertEquals(dp(7), bar.getElevation(), 0f); assertEquals(dp(1), bar.getTranslationZ(), 0f);
        }
        View page = (View) parent.getParent().getParent();
        android.view.WindowInsets original = page.getRootWindowInsets();
        assertNotNull(original);
        for (int bottom : new int[] {0, dp(24), dp(280)}) {
            page.dispatchApplyWindowInsets(original.replaceSystemWindowInsets(0, 0, 0, bottom));
            assertEquals(dp(8) + bottom, page.getPaddingBottom());
        }
        if (original != null) page.dispatchApplyWindowInsets(original);
    }

    private boolean isOpaqueBelowFade(android.graphics.drawable.Drawable backdrop) {
        android.graphics.Rect originalBounds = new android.graphics.Rect(backdrop.getBounds());
        android.graphics.Bitmap probe = android.graphics.Bitmap.createBitmap(4, 400, android.graphics.Bitmap.Config.ARGB_8888);
        android.graphics.Canvas canvas = new android.graphics.Canvas(probe);
        backdrop.setBounds(0, 0, 4, 400);
        backdrop.draw(canvas);
        boolean opaque = true;
        for (int y : new int[] {dp(36) + dp(4), 250, 399}) opaque &= android.graphics.Color.alpha(probe.getPixel(2, y)) == 255;
        backdrop.setBounds(originalBounds);
        probe.recycle();
        return opaque;
    }

    private boolean isClearInsideFade(android.graphics.drawable.Drawable backdrop, int fadeHeight) {
        android.graphics.Rect originalBounds = new android.graphics.Rect(backdrop.getBounds());
        android.graphics.Bitmap probe = android.graphics.Bitmap.createBitmap(4, 400, android.graphics.Bitmap.Config.ARGB_8888);
        android.graphics.Canvas canvas = new android.graphics.Canvas(probe);
        backdrop.setBounds(0, 0, 4, 400);
        backdrop.draw(canvas);
        boolean clear = true;
        for (int y : new int[] {0, fadeHeight / 2}) clear &= android.graphics.Color.alpha(probe.getPixel(2, y)) == 0;
        backdrop.setBounds(originalBounds);
        probe.recycle();
        return clear;
    }

    private void assertDockFadeCompositesOverContent(View bar, View fade) {
        View dock = (View) bar.getParent();
        ViewGroup stage = (ViewGroup) dock.getParent();
        View body = stage.getChildAt(0);
        android.graphics.drawable.Drawable originalForeground = body.getForeground();
        ChatStyle style = new ChatStyle(bar.getContext());
        int contrast = android.graphics.Color.red(style.background) < 128 ? android.graphics.Color.WHITE : android.graphics.Color.BLACK;
        Bitmap probe = Bitmap.createBitmap(stage.getWidth(), stage.getHeight(), Bitmap.Config.ARGB_8888);
        try {
            body.setForeground(new android.graphics.drawable.ColorDrawable(contrast));
            stage.draw(new android.graphics.Canvas(probe));
            int backgroundRed = android.graphics.Color.red(style.background);
            int previousDistance = 256;
            for (int step = 0; step < 4; step++) {
                int sampleY = dock.getTop() + fade.getTop() + fade.getHeight() * step / 4;
                int distance = Math.abs(android.graphics.Color.red(probe.getPixel(stage.getWidth() / 2, sampleY)) - backgroundRed);
                assertTrue("Content must remain visible throughout the upper fade band", distance > 0);
                assertTrue("Content must fade gradually instead of ending at a solid strip", distance < previousDistance);
                previousDistance = distance;
            }
            assertEquals("The area below the editor must still fully mask content", style.background,
                probe.getPixel(stage.getWidth() / 2, dock.getTop() + bar.getBottom() + dp(4)));
        } finally {
            body.setForeground(originalForeground);
            probe.recycle();
        }
    }

    private void screenshot(Activity activity, String name) throws Exception {
        getInstrumentation().waitForIdleSync(); getInstrumentation().getUiAutomation().waitForIdle(300, 3000);
        Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(image);
        try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), name + ".png"))) { image.compress(Bitmap.CompressFormat.PNG, 100, output); }
        finally { image.recycle(); }
    }

    private int dp(int value) { return Math.round(value * getInstrumentation().getTargetContext().getResources().getDisplayMetrics().density); }
}
