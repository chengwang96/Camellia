package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.test.InstrumentationTestRunner;
import android.view.View;
import android.widget.EditText;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

public class RemoteDiscussionsTest extends InstrumentationTestCase {
    private RemoteDiscussionsActivity activity;
    private JSONObject oldCredentials, oldState;
    private boolean oldEmbedded;
    private String oldTheme, oldLanguage;
    private CredentialStore credentials, state;
    private final String groupId = "00000000-0000-0000-0000-000000000001";
    private final String memberId = "00000000-0000-0000-0000-000000000002";
    interface Checked { void run() throws Exception; }
    interface Check { boolean ready() throws Exception; }
    private void ui(Checked action) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private static Object field(Object target, String name) throws Exception { var f = target.getClass().getDeclaredField(name); f.setAccessible(true); return f.get(target); }
    private static void field(Object target, String name, Object value) throws Exception { var f = target.getClass().getDeclaredField(name); f.setAccessible(true); f.set(target, value); }
    private void invoke(String name, Class<?>[] types, Object... args) throws Exception { var method = RemoteDiscussionsActivity.class.getDeclaredMethod(name, types); method.setAccessible(true); method.invoke(activity, args); }
    private View view(String tag) { return activity.getWindow().getDecorView().findViewWithTag(tag); }
    private View dialogView(String tag) throws Exception { return ((AlertDialog) field(activity, "dialog")).getWindow().getDecorView().findViewWithTag(tag); }
    private void waitFor(Check check) throws Exception {
        long end = android.os.SystemClock.uptimeMillis() + 20000;
        while (android.os.SystemClock.uptimeMillis() < end) {
            AtomicReference<Boolean> ready = new AtomicReference<>(false); ui(() -> ready.set(check.ready()));
            if (ready.get()) return; Thread.sleep(100);
        }
        fail("Timed out: " + (view("discussionStatus") instanceof TextView ? ((TextView) view("discussionStatus")).getText() : "no status"));
    }
    @Override protected void setUp() throws Exception {
        super.setUp(); var context = getInstrumentation().getTargetContext(); EmbeddedNetwork.initialize(context);
        oldTheme = MobilePreferences.get(context, "theme"); oldLanguage = MobilePreferences.get(context, "language");
        android.os.Bundle args = ((InstrumentationTestRunner) getInstrumentation()).getArguments();
        if (args.containsKey("discussionTheme")) MobilePreferences.set(context, "theme", args.getString("discussionTheme"));
        if (args.containsKey("discussionLanguage")) MobilePreferences.set(context, "language", args.getString("discussionLanguage"));
        oldEmbedded = EmbeddedNetwork.enabled(); EmbeddedNetwork.setEnabled(false);
        credentials = new CredentialStore(context); state = new CredentialStore(context, "remote-discussions-private");
        oldCredentials = credentials.load(); oldState = state.load(); state.save(new JSONObject());
    }
    @Override protected void tearDown() throws Exception {
        if (activity != null) { ui(() -> activity.finish()); getInstrumentation().waitForIdleSync(); }
        credentials.save(oldCredentials); state.save(oldState); EmbeddedNetwork.setEnabled(oldEmbedded);
        MobilePreferences.set(getInstrumentation().getTargetContext(), "theme", oldTheme); MobilePreferences.set(getInstrumentation().getTargetContext(), "language", oldLanguage); super.tearDown();
    }
    private void start(JSONObject profile) throws Exception {
        new ComputerStore(credentials).save(profile);
        activity = (RemoteDiscussionsActivity) getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), RemoteDiscussionsActivity.class)
            .putExtra("address", profile.getString("address")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        getInstrumentation().waitForIdleSync();
    }
    private JSONObject snapshot(long cursor, String title, String answer) throws Exception {
        JSONObject participant = new JSONObject().put("id", memberId).put("name", "Scientist").put("engine", "codex").put("connection", "subscription")
            .put("model", "fixture").put("identityPrompt", "").put("capability", new JSONObject().put("available", true));
        JSONObject group = new JSONObject().put("id", groupId).put("title", title).put("participants", new JSONArray().put(participant))
            .put("messages", new JSONArray().put(new JSONObject().put("id", "reply").put("seq", 1).put("role", "assistant").put("speakerId", memberId).put("speakerName", "Scientist").put("text", answer)))
            .put("deliveries", new JSONArray()).put("requests", new JSONArray());
        return new JSONObject().put("instanceId", "fixture-instance").put("cursor", cursor).put("group", group).put("nextBefore", JSONObject.NULL);
    }
    private void offlineFixture() throws Exception {
        start(new JSONObject().put("address", "http://100.64.0.1:43129").put("token", "a".repeat(43)).put("deviceId", "fixture-device").put("computerName", "Test computer"));
        ui(() -> {
            invoke("disconnect", new Class<?>[0]); field(activity, "foreground", false); field(activity, "lastError", ""); field(activity, "groupId", groupId);
            invoke("shell", new Class<?>[0]); invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, snapshot(10, "Initial title", "Initial reply"), false);
        });
    }
    public void testStreamRefreshPreservesDraftSelectionAndComposerAndRejectsStaleSnapshot() throws Exception {
        offlineFixture();
        ui(() -> {
            field(activity, "connected", true); invoke("controls", new Class<?>[0]);
            String note = ((TextView) view("discussionStatus")).getText().toString();
            assertTrue(note, note.contains("note") || note.contains("仅保存"));
            EditText composer = (EditText) view("discussionComposer"); composer.setText("Unsent draft"); composer.setSelection(4);
            view("discussionSelect:" + memberId).performClick();
            invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, snapshot(12, "Renamed on desktop", "Updated reply"), false);
            assertSame(composer, view("discussionComposer")); assertEquals("Unsent draft", composer.getText().toString()); assertEquals(4, composer.getSelectionStart());
            assertTrue(view("discussionSelect:" + memberId).isSelected());
            invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, snapshot(11, "Stale title", "Old reply"), false);
            assertEquals("Renamed on desktop", ((TextView) view("discussionTitle")).getText().toString());
            invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, snapshot(13, "Wrong group", "Wrong").put("group", snapshot(13, "Wrong group", "Wrong").getJSONObject("group").put("id", UUID.randomUUID().toString())), false);
            assertEquals("Renamed on desktop", ((TextView) view("discussionTitle")).getText().toString());
        });
    }
    public void testIdentityEditorOptionalAndDraftSurvivesSwitchingGroups() throws Exception {
        offlineFixture();
        ui(() -> {
            view("discussionSpeaker:" + memberId).performClick();
            EditText prompt = (EditText) dialogView("discussionIdentityInput"); assertEquals("", prompt.getText().toString());
            assertTrue(prompt.getMaxLines() > 1); ((AlertDialog) field(activity, "dialog")).dismiss();
            ((EditText) view("discussionComposer")).setText("Saved group draft"); view("discussionSelect:" + memberId).performClick();
            invoke("openGroup", new Class<?>[] {String.class}, UUID.randomUUID().toString());
            assertEquals("", ((EditText) view("discussionComposer")).getText().toString());
            invoke("openGroup", new Class<?>[] {String.class}, groupId);
            invoke("apply", new Class<?>[] {JSONObject.class, boolean.class}, snapshot(20, "Returned", "Reply"), false);
            assertEquals("Saved group draft", ((EditText) view("discussionComposer")).getText().toString());
            assertTrue(view("discussionSelect:" + memberId).isSelected());
            assertEquals(android.view.View.GONE, view("discussionStop").getVisibility());
        });
    }

    public void testDiscussionUsesConnectionHeaderAndFixedWorkStatus() throws Exception {
        offlineFixture();
        ui(() -> {
            field(activity, "connected", true); field(activity, "chinese", true);
            JSONObject next = snapshot(20, "Working", "Reply");
            next.getJSONObject("group").put("active", true).put("deliveries", new JSONArray().put(new JSONObject()
                .put("id", "delivery").put("participantId", memberId).put("status", "running").put("tools", new JSONArray()
                    .put(new JSONObject().put("id", "tool").put("name", "read").put("status", "running")))));
            invoke("apply", new Class<?>[]{JSONObject.class, boolean.class}, next, false);
            TextView status = (TextView) view("discussionStatus"), header = (TextView) view("headerConnectionState");
            assertEquals("已连接", header.getText().toString()); assertEquals("正在执行工具…", status.getText().toString());
            status.measure(View.MeasureSpec.makeMeasureSpec(280, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
            int height = status.getMeasuredHeight();
            invoke("showError", new Class<?>[]{String.class}, "操作未确认，请检查回执");
            invoke("apply", new Class<?>[]{JSONObject.class, boolean.class}, snapshot(21, "Idle", "Reply"), false);
            assertEquals("操作未确认，请检查回执", status.getText().toString()); assertTrue(status.isClickable());
            status.measure(View.MeasureSpec.makeMeasureSpec(280, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
            assertEquals(height, status.getMeasuredHeight()); assertEquals(View.VISIBLE, status.getVisibility()); assertEquals(1, status.getMaxLines());
            assertEquals("已连接", header.getText().toString());
        });
    }
    public void testAndroidDiscussionGatewayWorkflow() throws Exception {
        if (!"true".equals(((InstrumentationTestRunner) getInstrumentation()).getArguments().getString("discussionIntegration"))) return;
        String address = "http://100.64.0.1:43129";
        RemoteApi client = new RemoteApi(address);
        JSONObject request = client.json("/v1/pair/request", null, new JSONObject().put("code", "discussion-fixture-only").put("name", "Discussion test phone"));
        JSONObject profile = client.json("/v1/pair/claim", null, new JSONObject().put("id", request.getString("id")).put("claim", request.getString("claim")));
        profile.put("address", address).put("computerName", "Discussion test host"); String token = profile.getString("token");
        start(profile); waitFor(() -> (boolean) field(activity, "connected"));
        ui(() -> {
            view("discussionCreate").performClick(); ((EditText) dialogView("discussionNameInput")).setText("Android discussion");
            ((AlertDialog) field(activity, "dialog")).getButton(AlertDialog.BUTTON_POSITIVE).performClick();
        });
        waitFor(() -> !((java.util.Set<?>) field(activity, "uncertain")).isEmpty());
        ui(() -> {
            String pendingId = ((JSONObject) field(activity, "pending")).keys().next();
            assertNotNull(view("discussionPending:" + pendingId)); view("discussionPending:" + pendingId).performClick();
        });
        waitFor(() -> field(activity, "groupId") != null && field(activity, "group") != null);
        String id = (String) field(activity, "groupId");
        ui(() -> { view("discussionMembers").performClick(); dialogView("discussionAddMember").performClick(); });
        waitFor(() -> field(activity, "dialog") != null && ((AlertDialog) field(activity, "dialog")).isShowing() && dialogView("camelliaDialogItem:5") != null);
        ui(() -> {
            dialogView("camelliaDialogItem:1").performClick(); // Codex
            dialogView("camelliaDialogItem:0").performClick(); // model
            ((EditText) dialogView("discussionMemberName")).setText("Scientist");
            ((EditText) dialogView("discussionIdentityInput")).setText("You are a scientist.");
            ((AlertDialog) field(activity, "dialog")).getButton(AlertDialog.BUTTON_POSITIVE).performClick();
        });
        waitFor(() -> ((JSONObject) field(activity, "group")).getJSONArray("participants").length() == 1);
        JSONObject catalog = client.json("/v1/discussions/catalog", token, null);
        operation(client, token, "add-member", id, new JSONObject().put("bindingId", catalog.getJSONArray("bindings").getJSONObject(0).getString("id")).put("name", "Developer"));
        waitFor(() -> ((JSONObject) field(activity, "group")).getJSONArray("participants").length() == 2 && ((JSONObject) field(activity, "pending")).length() == 0);
        JSONObject group = client.json("/v1/discussions/" + id, token, null).getJSONObject("group");
        String first = group.getJSONArray("participants").getJSONObject(0).getString("id"), second = group.getJSONArray("participants").getJSONObject(1).getString("id");
        ui(() -> {
            view("discussionSelect:" + first).performClick(); view("discussionSelect:" + second).performClick();
            ((ChatComposer) field(activity, "composer")).model.performClick(); dialogView("settingsChoice:1").performClick();
            ((EditText) view("discussionComposer")).setText("Discuss the design"); view("discussionSend").performClick();
        });
        waitFor(() -> ((JSONObject) field(activity, "group")).getJSONArray("messages").length() == 3 && ((EditText) view("discussionComposer")).length() == 0);
        AtomicReference<View> composer = new AtomicReference<>();
        ui(() -> { composer.set(view("discussionComposer")); ((EditText) composer.get()).setText("Keep this draft"); ((EditText) composer.get()).setSelection(4); });
        operation(client, token, "rename", id, new JSONObject().put("title", "Synced from desktop"));
        operation(client, token, "pin", id, new JSONObject().put("pinned", true));
        waitFor(() -> ((TextView) view("discussionTitle")).getText().toString().equals("Synced from desktop"));
        ui(() -> {
            assertSame(composer.get(), view("discussionComposer")); assertEquals("Keep this draft", ((EditText) composer.get()).getText().toString());
            assertEquals(4, ((EditText) composer.get()).getSelectionStart()); view("discussionSpeaker:" + first).performClick();
            ((EditText) dialogView("discussionIdentityInput")).setText("");
            ((AlertDialog) field(activity, "dialog")).getButton(AlertDialog.BUTTON_POSITIVE).performClick();
        });
        waitFor(() -> ((JSONObject) field(activity, "group")).getJSONArray("participants").getJSONObject(0).optString("identityPrompt").isEmpty() && ((JSONObject) field(activity, "pending")).length() == 0);
        ui(() -> { var manager = (android.view.inputmethod.InputMethodManager) activity.getSystemService(Activity.INPUT_METHOD_SERVICE); manager.hideSoftInputFromWindow(view("discussionComposer").getWindowToken(), 0); });
        getInstrumentation().waitForIdleSync(); Thread.sleep(300);
        android.graphics.Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot();
        if (image != null) try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), "discussion-integration.png"))) { image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output); image.recycle(); }
        // Return a real image URI through the activity's picker callback. The
        // document follows the shared document reader used by ordinary chat.
        java.io.File camera = new java.io.File(activity.getCacheDir(), "camera"); camera.mkdirs();
        java.io.File photo = new java.io.File(camera, "rich-photo.jpg"), notes = new java.io.File(camera, "rich-notes.txt");
        android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(24, 24, android.graphics.Bitmap.Config.ARGB_8888); bitmap.eraseColor(android.graphics.Color.BLUE);
        try (var output = new java.io.FileOutputStream(photo)) { bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 90, output); } bitmap.recycle();
        try (var output = new java.io.FileOutputStream(notes)) { output.write("Mobile document bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
        ui(() -> {
            field(activity, "pickerGroup", id);
            invoke("onActivityResult", new Class<?>[]{int.class, int.class, Intent.class}, 811, Activity.RESULT_OK, new Intent().setData(CameraFileProvider.uri(activity, photo)));
        });
        waitFor(() -> ((java.util.List<?>) field(activity, "images")).size() == 1 && !(boolean) field(activity, "loadingAttachments"));
        JSONObject document = ChatDocument.read(activity, CameraFileProvider.uri(activity, notes), false);
        ui(() -> {
            ((java.util.List<JSONObject>) field(activity, "documents")).add(document); invoke("renderAttachments", new Class<?>[0]);
            view("discussionSelect:" + second).performClick(); ((EditText) view("discussionComposer")).setText("RICH_REQUEST"); view("discussionSend").performClick();
        });
        waitFor(() -> view("discussionApproval:rich-question") != null && ((JSONObject) field(activity, "pending")).length() == 0);
        ui(() -> {
            view("discussionApproval:rich-question").performClick(); AlertDialog approval = (AlertDialog) field(activity, "approvalDialog");
            android.view.View root = approval.getWindow().getDecorView();
            // Use the actual choice widgets, including both multi-select boxes.
            clickChoice(root, "Scientist"); clickChoice(root, "Text"); clickChoice(root, "Image");
            ((EditText) root.findViewWithTag("approvalAnswer:notes")).setText("Mobile answer");
        });
        screenshot("discussion-questions.png");
        ui(() -> ((AlertDialog) field(activity, "approvalDialog")).getButton(AlertDialog.BUTTON_POSITIVE).performClick());
        waitFor(() -> ((JSONObject) field(activity, "group")).getJSONArray("messages").length() == 5 && ((JSONObject) field(activity, "pending")).length() == 0);
        ui(() -> { assertTrue(((java.util.List<?>) field(activity, "images")).isEmpty()); assertTrue(((java.util.List<?>) field(activity, "documents")).isEmpty()); });
        JSONArray artifacts = client.json("/v1/discussions/" + id + "/artifacts", token, null).getJSONArray("artifacts");
        JSONObject artifact = null; for (int i = 0; i < artifacts.length(); i++) if (artifacts.getJSONObject(i).optString("name").equals("mobile-result.txt")) artifact = artifacts.getJSONObject(i);
        assertNotNull(artifact); java.io.ByteArrayOutputStream downloaded = new java.io.ByteArrayOutputStream();
        client.download("/v1/discussions/" + id + "/artifacts/" + artifact.getString("id"), token, downloaded, artifact.getLong("size"), (received, total) -> {});
        assertEquals("Confirmed from phone", downloaded.toString("UTF-8")); photo.delete(); notes.delete();
        JSONObject photoArtifact = null;
        for (int i = 0; i < artifacts.length(); i++) if (artifacts.getJSONObject(i).optString("extension").matches("(?i)\\.?jpe?g")) photoArtifact = artifacts.getJSONObject(i);
        assertNotNull(photoArtifact); String previewTag = "artifactPreview:" + photoArtifact.getString("id");
        ui(() -> invoke("showFiles", new Class<?>[0]));
        Object downloads = field(activity, "downloads");
        waitFor(() -> ((android.app.Dialog) field(downloads, "dialog")).getWindow().getDecorView().findViewWithTag(previewTag) != null);
        ui(() -> ((android.app.Dialog) field(downloads, "dialog")).getWindow().getDecorView().findViewWithTag(previewTag).performClick());
        waitFor(() -> field(downloads, "imagePreview") != null);
        ui(() -> {
            AlertDialog preview = (AlertDialog) field(downloads, "imagePreview");
            android.widget.ImageView picture = preview.getWindow().getDecorView().findViewWithTag("artifactImage");
            assertEquals(24, ((android.graphics.drawable.BitmapDrawable) picture.getDrawable()).getBitmap().getWidth()); preview.dismiss();
            ((android.app.Dialog) field(downloads, "dialog")).dismiss();
        });
        screenshot("discussion-rich-result.png");
        operation(client, token, "delete", id, new JSONObject()); waitFor(() -> field(activity, "groupId") == null);
        client.cancel();
    }
    private void screenshot(String name) throws Exception {
        getInstrumentation().waitForIdleSync();
        Thread.sleep(350); // Let the platform's dialog enter/exit animation finish.
        android.graphics.Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot();
        if (image != null) try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalFilesDir(null), name))) {
            image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output); image.recycle();
        }
    }
    private void clickChoice(View root, String text) {
        View view = root.findViewWithTag(text); assertNotNull(view); view.performClick();
    }
    private JSONObject operation(RemoteApi api, String token, String action, String id, JSONObject parameters) throws Exception {
        String instance = api.json("/v1/status", token, null).getString("instanceId"), requestId = UUID.randomUUID().toString();
        JSONObject command = new JSONObject().put("requestId", requestId).put("instanceId", instance).put("action", action).put("parameters", parameters);
        if (id != null) command.put("id", id);
        JSONObject receipt = api.json("/v1/discussions/commands", token, command);
        for (int i = 0; i < 80 && receipt.optString("state").equals("pending"); i++) {
            Thread.sleep(100); receipt = api.json("/v1/discussions/commands/" + requestId, token, null);
        }
        assertEquals(receipt.toString(), "completed", receipt.optString("state")); return receipt;
    }
}
