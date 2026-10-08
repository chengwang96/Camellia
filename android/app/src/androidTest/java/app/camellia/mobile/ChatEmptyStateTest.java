package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Map;

public class ChatEmptyStateTest extends InstrumentationTestCase {
    private Activity activity;
    private CredentialStore encrypted;
    private JSONObject credentials;

    @Override protected void setUp() throws Exception {
        super.setUp();
        assertTrue(getInstrumentation().getUiAutomation().setRotation(android.app.UiAutomation.ROTATION_FREEZE_0));
        getInstrumentation().getUiAutomation().waitForIdle(200, 5000);
        LocalChatFixture.clear(getInstrumentation().getTargetContext());
    }

    @Override protected void tearDown() throws Exception {
        if (activity != null) finishActivity();
        if (encrypted != null) encrypted.clear();
        LocalChatFixture.clear(getInstrumentation().getTargetContext());
        getInstrumentation().getUiAutomation().setRotation(android.app.UiAutomation.ROTATION_UNFREEZE); super.tearDown();
    }

    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        var failure = new java.util.concurrent.atomic.AtomicReference<Throwable>();
        getInstrumentation().runOnMainSync(() -> {
            try { check.run(); } catch (Throwable error) { failure.set(error); }
        });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private void finishActivity() {
        ui(activity::finish);
        long deadline = android.os.SystemClock.uptimeMillis() + 10000;
        while (!activity.isDestroyed() && android.os.SystemClock.uptimeMillis() < deadline) {
            LocalChatFixture.idle(getInstrumentation()); android.os.SystemClock.sleep(20);
        }
        assertTrue("Activity did not finish pending storage writes", activity.isDestroyed());
    }
    private Object field(String name) throws Exception {
        var field = activity.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(activity);
    }
    private void field(String name, Object value) throws Exception {
        var field = activity.getClass().getDeclaredField(name); field.setAccessible(true); field.set(activity, value);
    }
    private void invoke(String name) throws Exception {
        var method = activity.getClass().getDeclaredMethod(name); method.setAccessible(true); method.invoke(activity);
    }
    private View root() { return activity.getWindow().getDecorView(); }
    private View view(String tag) { return root().findViewWithTag(tag); }
    private LocalChatFixture localFixture() throws Exception {
        LocalChatFixture fixture = new LocalChatFixture(getInstrumentation().getTargetContext());
        JSONObject provider = new JSONObject().put("id", "welcome-test").put("name", "Example API").put("protocol", "openai")
            .put("baseUrl", "https://example.com/v1").put("keys", new JSONArray().put(new JSONObject().put("key", "test-key")))
            .put("models", new JSONArray().put(new JSONObject().put("id", "test-model").put("upstream", "test-model")));
        fixture.importConfig(LocalChatConfig.parse(new JSONObject().put("format", "camellia-api-routes").put("version", 2)
            .put("config", new JSONObject().put("providers", new JSONArray().put(provider))).toString()));
        return fixture;
    }
    private void local() throws Exception {
        activity = LocalChatFixture.start(getInstrumentation(), new Intent(getInstrumentation().getTargetContext(), LocalChatActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        ui(() -> { field("chinese", true); invoke("list"); }); getInstrumentation().waitForIdleSync();
    }
    private void remote() throws Exception {
        var context = getInstrumentation().getTargetContext();
        EmbeddedNetwork.initialize(context); EmbeddedNetwork.setEnabled(false);
        encrypted = new CredentialStore(context, "welcome-test-computers"); encrypted.clear();
        ComputerStore computers = new ComputerStore(encrypted);
        credentials = new JSONObject().put("address", "http://100.64.0.91:43127").put("computerName", "Welcome test").put("token", "w".repeat(43));
        computers.save(credentials);
        activity = getInstrumentation().startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        ui(() -> {
            invoke("stopNetwork"); field("store", computers); field("credentials", credentials); field("chinese", true); field("foreground", false);
            ((RemoteListCache) field("listCache")).remove(credentials); invoke("listScreen");
        }); getInstrumentation().waitForIdleSync();
    }
    private JSONObject info(JSONArray workspaces, boolean control, boolean standalone, JSONArray discussions) throws Exception {
        return new JSONObject().put("permission", control ? "control" : "read").put("instanceId", "welcome-instance")
            .put("capabilities", new JSONArray().put("create").put("create-workspace").put("discussions"))
            .put("workspaces", workspaces).put("includeUnassigned", standalone).put("discussionGroups", discussions)
            .put("engines", new JSONArray().put("codex"));
    }
    private void snapshot(JSONObject info) throws Exception {
        var method = MainActivity.class.getDeclaredMethod("updateCapabilities", JSONObject.class); method.setAccessible(true); method.invoke(activity, info);
        invoke("renderConversations");
    }
    @SuppressWarnings("unchecked") private Map<String, JSONObject> conversations() throws Exception {
        return (Map<String, JSONObject>) field("conversations");
    }
    private JSONArray workspace() throws Exception { return new JSONArray().put(new JSONObject().put("id", "research").put("name", "研究工作区")); }
    private void screenshot(String name) throws Exception {
        ui(() -> ((PageTransitions) field("pages")).finishTransition()); getInstrumentation().waitForIdleSync();
        getInstrumentation().getUiAutomation().waitForIdle(150, 3000);
        android.graphics.Bitmap bitmap = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(bitmap);
        if ("true".equals(((android.test.InstrumentationTestRunner) getInstrumentation()).getArguments().getString("landscape")))
            assertTrue("Expected a short landscape viewport", bitmap.getWidth() > bitmap.getHeight());
        try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), "welcome-" + name + ".png"))) {
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
        } finally { bitmap.recycle(); }
    }

    public void testLocalWelcomeCreatesWorkspaceThenKeepsEmptyGroups() throws Exception {
        localFixture(); local(); screenshot("local-empty");
        ui(() -> {
            assertNotNull(view("chatEmptyState")); assertNull(view("localGroup:"));
            assertEquals(View.GONE, view("localSearchBarDock").getVisibility());
            assertEquals(Gravity.CENTER_VERTICAL, ((LinearLayout) field("content")).getGravity() & Gravity.VERTICAL_GRAVITY_MASK);
            assertNotNull(view("localEmptyNewStandalone")); view("localNewWorkspace").performClick();
        });
        getInstrumentation().waitForIdleSync();
        ui(() -> {
            AlertDialog dialog = (AlertDialog) field("dialog");
            ((EditText) dialog.getWindow().getDecorView().findViewWithTag("localWorkspaceName")).setText("研究工作区");
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
        });
        LocalChatFixture.idle(getInstrumentation());
        String id = new LocalChatFixture(activity).workspaces().getJSONObject(0).getString("id");
        ui(() -> {
            assertNull(view("chatEmptyState")); assertNotNull(view("localGroup:" + id)); assertNotNull(view("localAdd:" + id));
            assertEquals(View.VISIBLE, view("localSearchBarDock").getVisibility());
            assertNotNull(view("localGroup:")); assertEquals(Gravity.TOP, ((LinearLayout) field("content")).getGravity() & Gravity.VERTICAL_GRAVITY_MASK);
        }); screenshot("local-empty-workspace");
    }

    public void testLocalStandaloneCreationHasNoDuplicateComposerAction() throws Exception {
        localFixture(); local();
        ui(() -> view("localEmptyNewStandalone").performClick()); LocalChatFixture.idle(getInstrumentation());
        JSONObject conversation = new LocalChatFixture(activity).conversations().getJSONObject(0);
        assertEquals("", conversation.getString("workspaceId")); assertEquals(0, conversation.getJSONArray("messages").length());
        ui(() -> { assertNotNull(view("localComposer")); assertNotNull(view("chatEmptyState")); assertNull(view("emptyStateAction")); });
        screenshot("local-new-chat");
        ui(() -> activity.onBackPressed()); LocalChatFixture.idle(getInstrumentation());
        ui(() -> { assertNull(view("chatEmptyState")); assertNotNull(view("localConversation:" + conversation.getString("id"))); });
    }

    public void testLocalSearchEmptyIsSeparateAndClearRestoresList() throws Exception {
        LocalChatFixture fixture = localFixture();
        JSONObject chat = fixture.createConversation("", LocalChatConfig.routes(fixture.config()).get(0).id);
        chat.put("title", "Review results"); fixture.save(); local();
        ui(() -> {
            assertNull(view("chatEmptyState")); assertNotNull(view("localNewWorkspace"));
            ((EditText) view("localSearch")).setText("missing-query");
            assertNotNull(view("chatEmptyState")); assertNull(view("localGroup:")); assertNull(view("localNewWorkspace"));
            view("emptyStateAction").performClick();
            assertEquals("", ((EditText) view("localSearch")).getText().toString());
            assertNotNull(view("localConversation:" + chat.getString("id"))); assertNull(view("chatEmptyState"));
        });
    }

    public void testRemoteDoesNotTreatLoadingEmptyCacheOrFailureAsWelcome() throws Exception {
        remote();
        ui(() -> {
            assertNull(view("newStandalone")); assertNull(view("remoteNewWorkspace")); assertNull(view("emptyStateAction"));
            ((RemoteListCache) field("listCache")).put(credentials, new JSONArray(), -1, new JSONArray(), true);
            invoke("listScreen"); assertNull(view("newStandalone")); assertNull(view("remoteNewWorkspace"));
            field("listLoadFailed", true); invoke("renderConversations"); assertNotNull(view("emptyStateAction")); assertNull(view("newStandalone"));
            snapshot(info(new JSONArray(), true, true, new JSONArray()));
            assertNotNull(view("newStandalone")); assertNotNull(view("remoteNewWorkspace")); assertNull(view("group:")); assertNull(view("group:discussions"));
        }); screenshot("remote-empty");
        ui(() -> {
            snapshot(info(new JSONArray(), false, true, new JSONArray()));
            assertNull(view("newStandalone")); assertNull(view("remoteNewWorkspace")); assertNull(view("newDiscussion")); assertNotNull(view("emptyStateAction"));
        });
    }

    public void testRemoteWorkspaceAndStandaloneCreationUseExplicitTargets() throws Exception {
        remote();
        ui(() -> {
            snapshot(info(workspace(), true, true, new JSONArray()));
            assertNull(view("chatEmptyState")); assertNotNull(view("group:research")); assertNotNull(view("newWorkspace:research"));
            view("newStandalone").performClick();
            Dialog dialog = (Dialog) field("computerDialog"); dialog.getWindow().getDecorView().findViewWithTag("createEngine:codex").performClick();
            JSONObject pending = ((JSONObject) field("credentials")).getJSONObject("pendingCreate"); assertTrue(pending.isNull("workspaceId"));
            ((JSONObject) field("credentials")).remove("pendingCreate"); invoke("renderConversations");
            view("newWorkspace:research").performClick();
            dialog = (Dialog) field("computerDialog"); dialog.getWindow().getDecorView().findViewWithTag("createEngine:codex").performClick();
            pending = ((JSONObject) field("credentials")).getJSONObject("pendingCreate"); assertEquals("research", pending.getString("workspaceId"));
            ((JSONObject) field("credentials")).remove("pendingCreate"); invoke("renderConversations");
        }); screenshot("remote-empty-workspace");
    }

    public void testRemoteDiscussionsStayVisibleAndSearchCanBeCleared() throws Exception {
        remote();
        ui(() -> {
            snapshot(info(new JSONArray(), true, true, new JSONArray().put(new JSONObject().put("id", "team").put("title", "Team review"))));
            assertNull(view("chatEmptyState")); assertNotNull(view("discussion:team"));
            ((EditText) view("remoteSearchInput")).setText("missing-query");
            assertNotNull(view("chatEmptyState")); assertNull(view("group:")); assertNull(view("group:discussions"));
            view("emptyStateAction").performClick(); assertNull(view("chatEmptyState")); assertNotNull(view("discussion:team"));
        });
    }

    public void testRemoteRemovingLastConversationDependsOnRemainingWorkspaces() throws Exception {
        remote();
        ui(() -> {
            conversations().put("chat", new JSONObject().put("id", "chat").put("title", "Draft chat").put("workspaceId", JSONObject.NULL));
            snapshot(info(new JSONArray(), true, true, new JSONArray())); assertNull(view("chatEmptyState"));
            conversations().clear(); invoke("renderConversations"); assertNotNull(view("chatEmptyState")); assertNull(view("group:"));
            snapshot(info(workspace(), true, true, new JSONArray())); assertNull(view("chatEmptyState")); assertNotNull(view("group:research"));
            snapshot(info(workspace(), false, false, new JSONArray()));
            assertEquals(View.GONE, view("newWorkspace:research").getVisibility()); assertEquals(View.GONE, view("remoteNewWorkspace").getVisibility());
        });
    }

    public void testRemoteNewChatWelcomeHasNoDuplicateComposerAction() throws Exception {
        remote();
        ui(() -> {
            field("conversationId", "welcome-chat"); field("conversationTitle", "New chat"); invoke("detailScreen");
            field("displayedConversation", new JSONObject().put("id", "welcome-chat"));
            var render = MainActivity.class.getDeclaredMethod("renderMessages", JSONObject.class); render.setAccessible(true); render.invoke(activity, new Object[]{null});
            assertEquals(View.VISIBLE, view("chatEmptyState").getVisibility()); assertNull(view("emptyStateAction")); assertNotNull(view("remoteComposer"));
        }); screenshot("remote-new-chat");
    }

    public void testWelcomeActionsWrapAtLargeFontAndNarrowWidths() throws Exception {
        local();
        ui(() -> {
            var configuration = new android.content.res.Configuration(activity.getResources().getConfiguration()); configuration.fontScale = 1.8f;
            var context = activity.createConfigurationContext(configuration); ChatStyle style = new ChatStyle(context);
            ChatEmptyState welcome = new ChatEmptyState(context, style, "brand", "Start your first conversation", "Start a standalone chat, or create a workspace.");
            welcome.addAction("New standalone conversation", "first", () -> {}); welcome.addAction("New workspace", "second", () -> {});
            for (int dp : new int[]{230, 280, 360}) {
                int width = style.dp(dp); welcome.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)); welcome.layout(0, 0, width, welcome.getMeasuredHeight());
                int bottom = 0;
                for (int index = 0; index < welcome.getChildCount(); index++) {
                    View child = welcome.getChildAt(index); assertTrue(child.getLeft() >= 0); assertTrue(child.getRight() <= width);
                    assertTrue(child.getTop() >= bottom); bottom = child.getBottom(); assertTrue(bottom <= welcome.getHeight());
                }
                assertTrue(welcome.findViewWithTag("first").getHeight() >= style.dp(48));
            }
        });
    }

    public void testWelcomeActionsRemainReachableAboveFooterOnShortScreens() throws Exception {
        local();
        ui(() -> ((PageTransitions) field("pages")).finishTransition()); getInstrumentation().waitForIdleSync();
        ui(() -> {
            android.widget.ScrollView scroll = (android.widget.ScrollView) field("scroll"); scroll.setSmoothScrollingEnabled(false); scroll.fullScroll(View.FOCUS_DOWN);
        });
        getInstrumentation().waitForIdleSync();
        ui(() -> {
            android.graphics.Rect visible = new android.graphics.Rect(); View create = view("localNewWorkspace");
            assertTrue("Local creation button is outside the scroll viewport", create.getGlobalVisibleRect(visible));
            assertEquals("Local creation button is clipped", create.getHeight(), visible.height());
            assertEquals(View.GONE, view("localSearchBarDock").getVisibility());
        }); screenshot("local-actions-scrolled");
        finishActivity(); remote();
        ui(() -> {
            snapshot(info(new JSONArray(), true, true, new JSONArray()));
            ((android.widget.TextView) field("status")).setText("Showing cached conversations; syncing…");
        });
        ui(() -> ((PageTransitions) field("pages")).finishTransition());
        getInstrumentation().waitForIdleSync();
        ui(() -> {
            android.widget.ScrollView scroll = (android.widget.ScrollView) field("scroll"); scroll.setSmoothScrollingEnabled(false); scroll.fullScroll(View.FOCUS_DOWN);
        });
        getInstrumentation().waitForIdleSync();
        ui(() -> {
            android.graphics.Rect visible = new android.graphics.Rect(); View create = view("newDiscussion");
            assertTrue("Discussion creation button is outside the scroll viewport", create.getGlobalVisibleRect(visible));
            assertEquals("Discussion creation button is clipped", create.getHeight(), visible.height());
            View status = (View) field("status"); int[] position = new int[2]; status.getLocationOnScreen(position);
            assertEquals(View.VISIBLE, status.getVisibility()); assertTrue(visible.bottom <= position[1]);
        }); screenshot("remote-actions-scrolled");
    }
}
