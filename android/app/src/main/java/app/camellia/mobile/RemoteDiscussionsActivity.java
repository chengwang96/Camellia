package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputFilter;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** A controller for discussions owned by the selected computer. */
public final class RemoteDiscussionsActivity extends Activity {
    @Override protected void attachBaseContext(android.content.Context context) { super.attachBaseContext(MobilePreferences.wrap(context)); }
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService reads = Executors.newFixedThreadPool(2);
    private final ExecutorService events = Executors.newSingleThreadExecutor();
    private final LinkedHashSet<String> selected = new LinkedHashSet<>();
    private final TreeMap<Long, JSONObject> messages = new TreeMap<>();
    private final LinkedHashMap<String, JSONObject> deliveries = new LinkedHashMap<>();
    private final LinkedHashMap<String, JSONObject> requests = new LinkedHashMap<>();
    private final LinkedHashMap<String, JSONObject> groups = new LinkedHashMap<>();
    private final java.util.Set<String> polling = new java.util.HashSet<>();
    private final java.util.Set<String> uncertain = new java.util.HashSet<>();
    private ChatStyle style;
    private SettingsStyle settingsStyle;
    private MarkdownView markdown;
    private CredentialStore stateStore;
    private JSONObject state = new JSONObject(), profile = new JSONObject(), credentials = new JSONObject(), group;
    private JSONObject pending = new JSONObject(), drafts = new JSONObject();
    private String address, profileKey, groupId, instance = "", mode = "parallel", lastError = "";
    private long cursor = -1, nextBefore = -1;
    private int generation, nextOffset = -1;
    private boolean chinese, foreground, connected, restoring;
    private RemoteApi api;
    private LinearLayout root, content, roster, toolbar, pendingBar;
    private ScrollView scroll;
    private TextView title, status, membersButton;
    private TextView headerConnection;
    private ChatStatusLine workStatus;
    private boolean reconnecting, connectionBlocked;
    private ChatComposer composer;
    private AlertDialog dialog;
    private LinearLayout memberPanel;
    private final List<String> images = new ArrayList<>();
    private final List<JSONObject> documents = new ArrayList<>();
    private LinearLayout attachmentTray;
    private android.widget.HorizontalScrollView attachmentStrip;
    private boolean loadingAttachments, rich;
    private String pickerGroup, approvalKey = "";
    private java.io.File cameraFile;
    private ArtifactDownloads downloads;
    private AlertDialog approvalDialog;

    private String tr(String zh, String en) { return chinese ? zh : en; }
    private int dp(int value) { return style.dp(value); }
    private static JSONObject object(Object... values) {
        JSONObject result = new JSONObject();
        try { for (int i = 0; i < values.length; i += 2) result.put((String) values[i], values[i + 1]); }
        catch (org.json.JSONException error) { throw new IllegalArgumentException(error); }
        return result;
    }
    private static List<JSONObject> rows(JSONArray array) {
        List<JSONObject> result = new ArrayList<>();
        if (array != null) for (int i = 0; i < array.length(); i++) if (array.optJSONObject(i) != null) result.add(array.optJSONObject(i));
        return result;
    }
    private LinearLayout column() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.VERTICAL); return view; }
    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color); return view;
    }
    private TextView button(String label, String tag, Runnable action) {
        TextView button = text(label, 14, style.ink); button.setGravity(Gravity.CENTER); button.setTag(tag);
        button.setPadding(dp(14), dp(8), dp(14), dp(8)); button.setMinHeight(dp(48)); button.setFocusable(true);
        button.setBackground(new android.graphics.drawable.RippleDrawable(ColorStateList.valueOf(0x224176e6), style.capsule(style.surface), style.capsule(-1)));
        button.setOnClickListener(view -> action.run()); return button;
    }
    private EditText field(String hint, String value, int limit, boolean multiline, String tag) {
        EditText input = new EditText(this); input.setTag(tag); input.setText(value); input.setHint(hint);
        input.setTextColor(style.ink); input.setHintTextColor(style.muted); input.setTextSize(16); input.setSingleLine(!multiline);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | (multiline ? android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE : 0));
        input.setFilters(new InputFilter[] { new InputFilter.LengthFilter(limit) }); input.setMinHeight(dp(multiline ? 100 : 52));
        input.setMaxLines(multiline ? 6 : 1); input.setGravity(Gravity.TOP | Gravity.START);
        input.setPadding(dp(14), dp(12), dp(14), dp(12)); input.setBackground(settingsStyle.fieldBackground(settingsStyle.fieldBorder));
        input.setContentDescription(hint); return input;
    }

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved); EmbeddedNetwork.initialize(getApplicationContext());
        chinese = getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        style = new ChatStyle(this); settingsStyle = new SettingsStyle(this);
        markdown = new MarkdownView(this, style.ink, style.muted, style.surface, style.accent);
        stateStore = new CredentialStore(this, "remote-discussions-private");
        downloads = new ArtifactDownloads(this, saved);
        if (saved != null) { pickerGroup = saved.getString("pickerGroup"); if (saved.containsKey("cameraFile")) cameraFile = new java.io.File(saved.getString("cameraFile")); }
        address = getIntent().getStringExtra("address");
        try {
            for (JSONObject computer : new ComputerStore(new CredentialStore(this)).all())
                if (computer.optString("address").equals(address)) credentials = computer;
            if (!credentials.has("token")) throw new IllegalStateException(tr("请先配对电脑。", "Pair with the computer first."));
            new Endpoint(address);
            profileKey = address + "#" + credentials.optString("deviceId");
            state = stateStore.load(); profile = state.optJSONObject(profileKey); if (profile == null) profile = new JSONObject();
            drafts = profile.optJSONObject("drafts"); if (drafts == null) drafts = new JSONObject();
            pending = profile.optJSONObject("pending"); if (pending == null) pending = new JSONObject();
            uncertain.addAll(keys(pending));
            groupId = saved != null ? saved.getString("groupId") : getIntent().getStringExtra("groupId");
            restoreDraft();
        } catch (Exception error) { lastError = error.getMessage(); }
        shell();
    }
    @Override protected void onStart() {
        super.onStart(); foreground = true; EmbeddedNetwork.foreground();
        EmbeddedNetwork.setNetworkListener(() -> handler.post(() -> { if (foreground) connect(); })); connect();
    }
    @Override protected void onStop() {
        saveDraft(); foreground = false; disconnect();
        EmbeddedNetwork.setNetworkListener(null); EmbeddedNetwork.background();
        if (dialog != null) dialog.dismiss(); super.onStop();
    }
    @Override protected void onDestroy() { disconnect(); if (workStatus != null) workStatus.close(); downloads.close(); if (approvalDialog != null) approvalDialog.dismiss(); reads.shutdownNow(); events.shutdownNow(); super.onDestroy(); }
    @Override protected void onSaveInstanceState(Bundle saved) {
        saveDraft(); saved.putString("groupId", groupId); saved.putString("pickerGroup", pickerGroup);
        if (cameraFile != null) saved.putString("cameraFile", cameraFile.getAbsolutePath()); downloads.save(saved); super.onSaveInstanceState(saved);
    }
    @Override public void onBackPressed() { if (groupId == null || getIntent().getBooleanExtra("fromNavigation", false)) finish(); else openGroup(null); }

    private boolean persist() {
        if (profileKey == null) return false;
        try { profile.put("drafts", drafts).put("pending", pending); state.put(profileKey, profile); stateStore.save(state); return true; }
        catch (Exception error) { showError(error.getMessage()); return false; }
    }
    private void saveDraft() {
        if (groupId == null || composer == null) return;
        try { drafts.put(groupId, object("text", composer.input.getText().toString(), "selected", new JSONArray(selected), "mode", mode, "attachments", ChatAttachments.remote(images, documents))); persist(); }
        catch (Exception error) { showError(error.getMessage()); }
    }
    private void restoreDraft() {
        selected.clear(); images.clear(); documents.clear(); mode = "parallel";
        JSONObject draft = groupId == null ? null : drafts.optJSONObject(groupId);
        if (draft == null) return;
        try { ChatAttachments.restore(draft, images, documents); } catch (Exception error) { showError(error.getMessage()); }
        mode = draft.optString("mode", "parallel");
        JSONArray ids = draft.optJSONArray("selected"); if (ids != null) for (int i = 0; i < ids.length(); i++) selected.add(ids.optString(i));
    }
    private void openGroup(String id) {
        if (approvalDialog != null) { approvalDialog.dismiss(); approvalDialog = null; } downloads.stop();
        saveDraft(); disconnect(); groupId = id; group = null; cursor = -1; nextBefore = -1; lastError = ""; reconnecting = false;
        messages.clear(); deliveries.clear(); requests.clear(); restoreDraft(); shell(); connect();
    }

    private void shell() {
        if (workStatus != null) { workStatus.close(); workStatus = null; }
        composer = null; memberPanel = null;
        root = column(); root.setPadding(dp(18), dp(10), dp(18), dp(8)); root.setBackgroundColor(style.background); root.setClipToPadding(false);
        getWindow().setStatusBarColor(style.background); getWindow().setNavigationBarColor(style.background);
        if (android.os.Build.VERSION.SDK_INT >= 27) getWindow().getDecorView().setSystemUiVisibility(android.graphics.Color.red(style.background) < 128 ? 0
            : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(dp(18) + insets.getSystemWindowInsetLeft(), dp(10) + insets.getSystemWindowInsetTop(),
                dp(18) + insets.getSystemWindowInsetRight(), dp(8) + insets.getSystemWindowInsetBottom()); return insets;
        });
        LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(style.backButton(tr("返回", "Back"), this::onBackPressed), new LinearLayout.LayoutParams(dp(48), dp(48)));
        LinearLayout labels = column(); labels.setPadding(dp(10), 0, dp(6), 0);
        title = text(tr("Agent 讨论 (beta)", "Agent discussions (beta)"), 19, style.ink); title.setTag("discussionTitle");
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); title.setMaxLines(1); title.setEllipsize(TextUtils.TruncateAt.END);
        labels.addView(title);
        LinearLayout computer = new LinearLayout(this); computer.setGravity(Gravity.CENTER_VERTICAL);
        ImageView computerIcon = new ImageView(this); computerIcon.setImageDrawable(new LineIcon("computer", style.muted));
        computer.addView(computerIcon, new LinearLayout.LayoutParams(dp(14), dp(14)));
        TextView computerName = text(credentials.optString("computerName", "Camellia"), 12, style.muted);
        computerName.setPadding(dp(6), 0, 0, 0); computerName.setSingleLine(true); computerName.setEllipsize(TextUtils.TruncateAt.END);
        computer.addView(computerName, new LinearLayout.LayoutParams(0, -2, 1));
        headerConnection = text("", 12, style.muted); headerConnection.setTag("headerConnectionState");
        headerConnection.setSingleLine(true); headerConnection.setMaxWidth(dp(112)); headerConnection.setEllipsize(TextUtils.TruncateAt.END);
        headerConnection.setPadding(dp(6), 0, dp(6), 0); computer.addView(headerConnection); labels.addView(computer);
        header.addView(labels, new LinearLayout.LayoutParams(0, -2, 1));
        header.addView(style.lineButton("more", tr("切换和管理", "Switch and manage"), this::pageMenu), new LinearLayout.LayoutParams(dp(48), dp(48)));
        root.addView(header);
        toolbar = new LinearLayout(this); toolbar.setPadding(0, dp(8), 0, dp(8)); toolbar.setGravity(Gravity.CENTER_VERTICAL); root.addView(toolbar);
        if (groupId == null) toolbar.addView(button(tr("新建讨论群", "New discussion"), "discussionCreate", this::createGroup));
        else {
            membersButton = button(tr("成员", "Members"), "discussionMembers", this::showMembers);
            toolbar.addView(membersButton); TextView beta = text(tr("Agent 讨论 (beta)", "Agent discussions (beta)"), 12, style.muted);
            beta.setPadding(dp(12), 0, 0, 0); beta.setMaxLines(2); toolbar.addView(beta, new LinearLayout.LayoutParams(0, -2, 1));
        }
        scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setClipToPadding(false);
        content = column(); content.setPadding(0, dp(6), 0, dp(12)); scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        pendingBar = column(); pendingBar.setTag("discussionPendingCommands"); root.addView(pendingBar);
        if (groupId != null) {
            LinearLayout dock = column(); dock.setPadding(0, dp(8), 0, 0);
            LinearLayout bar = column(); bar.setTag("discussionComposerBar");
            composer = new ChatComposer(bar, style, chinese, tr("提出问题，或粘贴讨论材料…", "Ask a question or paste discussion material…"), 16000,
                this::chooseMode, this::send, () -> submit("stop", groupId, new JSONObject()), () -> {});
            composer.input.setTag("discussionComposer"); composer.send.setTag("discussionSend"); composer.stop.setTag("discussionStop");
            ImageButton attach = style.lineButton("plus", tr("添加内容", "Add"), this::attachmentMenu); attach.setTag("discussionAttach"); composer.addTool(attach);
            attachmentStrip = new android.widget.HorizontalScrollView(this); attachmentStrip.setHorizontalScrollBarEnabled(false);
            attachmentTray = new LinearLayout(this); attachmentStrip.addView(attachmentTray); bar.addView(attachmentStrip, 0); renderAttachments();
            android.widget.HorizontalScrollView horizontal = new android.widget.HorizontalScrollView(this); horizontal.setHorizontalScrollBarEnabled(false);
            roster = new LinearLayout(this); roster.setGravity(Gravity.CENTER_VERTICAL); horizontal.addView(roster); bar.addView(horizontal, 0);
            restoring = true;
            JSONObject draft = drafts.optJSONObject(groupId); composer.input.setText(draft == null ? "" : draft.optString("text"));
            restoring = false;
            composer.input.addTextChangedListener(new android.text.TextWatcher() {
                public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
                public void onTextChanged(CharSequence s, int start, int before, int count) {
                    controls(); handler.removeCallbacks(saveDraftLater); if (!restoring) handler.postDelayed(saveDraftLater, 400);
                }
                public void afterTextChanged(android.text.Editable s) {}
            });
            dock.addView(bar); root.addView(dock);
        }
        status = text("", 11, style.muted); status.setTag("discussionStatus");
        workStatus = new ChatStatusLine(status, style, chinese);
        if (!lastError.isEmpty()) workStatus.error(lastError, false);
        LinearLayout.LayoutParams statusLayout = new LinearLayout.LayoutParams(-1, -2); statusLayout.topMargin = dp(8); root.addView(status, statusLayout);
        setContentView(root); root.requestApplyInsets(); controls();
    }
    private final Runnable saveDraftLater = this::saveDraft;
    private void showError(String error) {
        lastError = error == null ? tr("操作失败，请刷新重试。", "Operation failed. Refresh and retry.") : error;
        if (workStatus != null) workStatus.error(lastError, false);
    }
    private void disconnect() {
        generation++; connected = false; if (api != null) api.cancel(); api = null;
        handler.removeCallbacksAndMessages(null); polling.clear(); controls();
    }
    private void connect() {
        if (!foreground || !credentials.has("token")) return;
        connectionBlocked = false; disconnect(); int ticket = generation; String target = groupId;
        RemoteApi client = new RemoteApi(this, address); api = client;
        reads.execute(() -> {
            try {
                JSONObject info = client.json("/v1/status", credentials.optString("token"), null);
                if (!String.valueOf(info.optJSONArray("capabilities")).contains("\"discussions\""))
                    throw new IllegalStateException(tr("这台主机尚未开放远程讨论，请更新主机并检查设备授权。", "Remote discussions are unavailable. Update the host and check device access."));
                JSONObject snapshot = client.json("/v1/discussions" + (target == null ? "" : "/" + target), credentials.optString("token"), null);
                deliver(ticket, () -> {
                    rich = String.valueOf(info.optJSONArray("capabilities")).contains("\"discussion-rich\"");
                    connected = true; reconnecting = false; workStatus.reconnected(); apply(snapshot, false); controls();
                    if (getIntent().getBooleanExtra("createGroup", false)) { getIntent().removeExtra("createGroup"); createGroup(); }
                    if (group != null && getIntent().getBooleanExtra("showActions", false)) { getIntent().removeExtra("showActions"); groupMenu(group); }
                    for (String id : keys(pending)) poll(id, false);
                    events.execute(() -> {
                        try {
                            client.discussionEvents(target, credentials.optString("token"), next -> deliver(ticket, () -> apply(next, false)));
                            throw new java.io.IOException("Discussion event stream disconnected");
                        }
                        catch (Exception error) { deliver(ticket, () -> connectionError(error)); }
                    });
                });
            } catch (Exception error) { deliver(ticket, () -> connectionError(error)); }
        });
    }
    private void connectionError(Exception error) {
        boolean retry = !(error instanceof RemoteApi.Failure) || ((RemoteApi.Failure) error).status >= 500;
        connectionBlocked = !retry;
        connected = false; reconnecting = true; controls(); workStatus.error(RemoteApi.failureMessage(error, chinese), true);
        if (retry) handler.postDelayed(this::connect, 3000);
    }
    private void deliver(int ticket, Runnable action) { handler.post(() -> { if (foreground && ticket == generation && !isFinishing()) action.run(); }); }
    private static List<String> keys(JSONObject value) { List<String> result = new ArrayList<>(); value.keys().forEachRemaining(result::add); return result; }

    private void apply(JSONObject snapshot, boolean older) {
        if (groupId != null && !(snapshot.optBoolean("deleted") && groupId.equals(snapshot.optString("id")))) {
            JSONObject target = snapshot.optJSONObject("group");
            if (target == null || !groupId.equals(target.optString("id"))) return;
        }
        String nextInstance = snapshot.optString("instanceId"); long nextCursor = snapshot.optLong("cursor", -1);
        if (older && !nextInstance.equals(instance)) return;
        if (!older && nextInstance.equals(instance) && nextCursor < cursor) return;
        if (!older) { if (!instance.equals(nextInstance)) { messages.clear(); deliveries.clear(); requests.clear(); } instance = nextInstance; cursor = nextCursor; }
        if (snapshot.optBoolean("deleted") && groupId != null && groupId.equals(snapshot.optString("id"))) { openGroup(null); return; }
        if (groupId == null) {
            if (!older) groups.clear();
            for (JSONObject row : rows(snapshot.optJSONArray("groups"))) groups.put(row.optString("id"), row);
            nextOffset = snapshot.optInt("nextOffset", -1); renderGroups();
        } else {
            JSONObject next = snapshot.optJSONObject("group"); if (next == null || !groupId.equals(next.optString("id"))) return;
            if (!older) group = next;
            boolean approvalPending = false;
            for (JSONObject request : rows(next.optJSONArray("pendingApprovals")))
                if (approvalToken(request).equals(approvalKey)) approvalPending = true;
            if (approvalDialog != null && !approvalPending) { approvalDialog.dismiss(); approvalDialog = null; }
            for (JSONObject message : rows(next.optJSONArray("messages"))) messages.put(message.optLong("seq"), message);
            for (JSONObject delivery : rows(next.optJSONArray("deliveries"))) deliveries.put(delivery.optString("id"), delivery);
            for (JSONObject request : rows(next.optJSONArray("requests"))) requests.put(request.optString("id"), request);
            if (older || messages.size() <= rows(next.optJSONArray("messages")).size()) nextBefore = snapshot.optLong("nextBefore", -1);
            int height = content.getHeight(), y = scroll.getScrollY();
            renderGroup();
            if (older) scroll.post(() -> scroll.scrollTo(0, y + Math.max(0, content.getHeight() - height)));
        }
        controls();
    }
    private void renderGroups() {
        content.removeAllViews(); content.setGravity(groups.isEmpty() ? Gravity.CENTER : Gravity.TOP);
        if (groups.isEmpty()) {
            TextView welcome = text(tr("Agent 讨论 (beta)", "Agent discussions (beta)"), 23, style.ink); welcome.setGravity(Gravity.CENTER); content.addView(welcome);
            TextView hint = text(tr("创建讨论群，添加成员，选择由谁回答。", "Create a discussion, add members and choose who replies."), 14, style.muted);
            hint.setGravity(Gravity.CENTER); hint.setPadding(0, dp(14), 0, dp(20)); content.addView(hint);
            content.addView(button(tr("创建讨论群", "Create discussion"), "discussionEmptyCreate", this::createGroup));
        }
        for (JSONObject row : groups.values()) {
            String id = row.optString("id"), name = row.optString("title");
            LinearLayout line = new LinearLayout(this); line.setGravity(Gravity.CENTER_VERTICAL);
            String detail = (row.optBoolean("pinned") ? tr("置顶 · ", "Pinned · ") : "") + (row.optBoolean("active") ? tr("正在回复", "Replying") : row.optInt("members") + tr(" 位成员", " members"));
            ConversationRow item = new ConversationRow(this, style, false, name, detail, "discussionRow:" + id, "discussionState:" + id,
                () -> openGroup(id), () -> groupMenu(row)); line.addView(item, new LinearLayout.LayoutParams(0, -2, 1));
            ImageButton menu = style.lineButton("more", name + tr("：更多操作", ": more actions"), () -> groupMenu(row)); menu.setTag("discussionActions:" + id);
            line.addView(menu, new LinearLayout.LayoutParams(dp(48), dp(48))); content.addView(line);
        }
        if (nextOffset >= 0) content.addView(button(tr("加载更多", "Load more"), "discussionMoreGroups", () -> readPage("/v1/discussions?offset=" + nextOffset)));
    }
    private void readPage(String path) {
        if (!connected || api == null) return;
        int ticket = generation; RemoteApi client = api;
        reads.execute(() -> { try { JSONObject page = client.json(path, credentials.optString("token"), null); deliver(ticket, () -> apply(page, true)); }
            catch (Exception error) { deliver(ticket, () -> showError(RemoteApi.failureMessage(error, chinese))); } });
    }
    private JSONObject member(String id) {
        if (group != null) for (JSONObject p : rows(group.optJSONArray("participants"))) if (id.equals(p.optString("id"))) return p;
        return null;
    }
    private void renderGroup() {
        title.setText(group.optString("title")); membersButton.setText(String.format(java.util.Locale.getDefault(), tr("成员 %d / 4", "Members %d / 4"), liveMembers().size()));
        roster.removeAllViews(); java.util.Set<String> live = new java.util.HashSet<>();
        TextView choose = text(tr("选择回答者", "Respondents"), 12, style.muted); choose.setPadding(dp(8), 0, dp(8), 0); roster.addView(choose);
        for (JSONObject p : liveMembers()) {
            String id = p.optString("id"); live.add(id);
            TextView chip = button("@" + p.optString("name"), "discussionSelect:" + id, () -> {
                if (!selected.remove(id)) selected.add(id); saveDraft(); renderGroup();
            });
            chip.setTextColor(selected.contains(id) ? style.accent : style.muted); chip.setSelected(selected.contains(id));
            chip.setContentDescription((selected.contains(id) ? tr("已选择：", "Selected: ") : tr("选择回答者：", "Select respondent: ")) + p.optString("name"));
            LinearLayout.LayoutParams spacing = new LinearLayout.LayoutParams(-2, dp(40)); spacing.setMargins(dp(4), 0, dp(4), dp(4)); roster.addView(chip, spacing);
        }
        selected.retainAll(live);
        boolean bottom = content.getHeight() - scroll.getHeight() - scroll.getScrollY() < dp(100);
        int oldY = scroll.getScrollY();
        content.removeAllViews(); content.setGravity(messages.isEmpty() ? Gravity.CENTER : Gravity.TOP);
        if (messages.isEmpty()) {
            TextView hint = text(tr("选择回答者，开始讨论", "Choose respondents to begin"), 20, style.ink); hint.setGravity(Gravity.CENTER); content.addView(hint);
            if (liveMembers().isEmpty()) content.addView(button(tr("添加成员", "Add member"), "discussionEmptyAdd", this::loadCatalog));
        }
        if (nextBefore > 0) content.addView(button(tr("加载更早消息", "Load earlier messages"), "discussionOlder", () -> readPage("/v1/discussions/" + groupId + "?before=" + nextBefore)));
        java.util.Set<String> completed = new java.util.HashSet<>();
        for (JSONObject message : messages.values()) if (message.has("deliveryId")) completed.add(message.optString("deliveryId"));
        for (JSONObject message : messages.values()) {
            boolean user = message.optString("role").equals("user");
            addMessage(message.optString("speakerId"), message.optString("speakerName", tr("你", "You")), message.optString("text"), user);
            for (JSONObject attachment : rows(message.optJSONArray("attachments"))) content.addView(button(attachment.optString("name"), "discussionFile:" + attachment.optString("id"), this::showFiles));
            if (!user) { JSONObject delivery = deliveries.get(message.optString("deliveryId")); if (delivery != null) renderTools(content, delivery); }
            if (user) for (JSONObject d : deliveries.values()) if (d.optString("requestId").equals(message.optString("requestId")) && !completed.contains(d.optString("id")) && d.optString("serialResolution").isEmpty()) addDelivery(d);
        }
        scroll.post(() -> { if (bottom) scroll.fullScroll(View.FOCUS_DOWN); else scroll.scrollTo(0, oldY); });
        if (memberPanel != null) renderMembers(); controls();
    }
    private void addMessage(String speaker, String name, String value, boolean user) {
        LinearLayout block = style.messageBlock(user);
        if (!user) block.addView(speaker(speaker, name));
        if (!value.isEmpty()) {
            if (user) { TextView body = text(value, 16, style.ink); body.setTextIsSelectable(true); style.messageTypography(body); block.addView(body); }
            else block.addView(markdown.render(value));
        }
        content.addView(style.messageWithFooter(block, user, () -> value, 0, chinese));
    }
    private View speaker(String id, String name) {
        JSONObject member = member(id); TextView label = button("●  " + name, "discussionSpeaker:" + id, () -> { if (member != null && !member.optBoolean("removed")) editIdentity(member); });
        label.setGravity(Gravity.START | Gravity.CENTER_VERTICAL); label.setTextColor(style.muted); label.setBackgroundColor(android.graphics.Color.TRANSPARENT);
        label.setPadding(0, 0, 0, dp(6)); return label;
    }
    private void addDelivery(JSONObject delivery) {
        JSONObject participant = member(delivery.optString("participantId"));
        LinearLayout block = style.messageBlock(false); block.addView(speaker(delivery.optString("participantId"), participant == null ? "Agent" : participant.optString("name")));
        String state = delivery.optString("status"), phase = delivery.optString("phase"), value = delivery.optString("partialText");
        if (!value.isEmpty()) block.addView(markdown.render(value));
        String label = switch (state) {
            case "queued" -> tr("等待回复", "Queued"); case "preparing" -> tr("正在准备…", "Preparing…");
            case "stopping" -> tr("正在停止…", "Stopping…"); case "failed" -> tr("回复失败", "Reply failed");
            case "cancelled" -> tr("已停止", "Stopped"); case "interrupted" -> tr("回复中断", "Interrupted");
            case "running" -> phase.equals("approval") ? tr("等待审批或回答问题", "Waiting for approval or answers") : tr("正在回复…", "Replying…");
            default -> state;
        };
        TextView note = text(label, 13, style.muted); note.setTag("discussionDelivery:" + delivery.optString("id")); block.addView(note);
        renderTools(block, delivery);
        String reason = delivery.optString("reason"); if (!reason.isEmpty()) { TextView detail = text(reason, 13, settingsStyle.error); detail.setTextIsSelectable(true); block.addView(detail); }
        if (List.of("failed", "cancelled", "interrupted").contains(state)) {
            block.addView(button(tr("重试", "Retry"), "discussionRetry:" + delivery.optString("id"), () -> submit("retry", groupId, object("deliveryId", delivery.optString("id")))));
            JSONObject request = requests.get(delivery.optString("requestId"));
            if (request != null && request.optString("mode").equals("serial")) block.addView(button(tr("跳过", "Skip"), "discussionSkip:" + delivery.optString("id"),
                () -> submit("resolve-serial", groupId, object("deliveryId", delivery.optString("id"), "resolution", "skip"))));
        } else if (List.of("queued", "preparing", "running").contains(state)) block.addView(button(tr("停止", "Stop"), "discussionStop:" + delivery.optString("id"),
            () -> submit("stop", groupId, object("deliveryId", delivery.optString("id")))));
        content.addView(block);
    }
    private List<JSONObject> liveMembers() {
        List<JSONObject> result = new ArrayList<>(); if (group != null) for (JSONObject p : rows(group.optJSONArray("participants"))) if (!p.optBoolean("removed")) result.add(p); return result;
    }
    private boolean memberBusy(String id) {
        for (JSONObject d : deliveries.values()) if (id.equals(d.optString("participantId")) && List.of("queued", "preparing", "running", "stopping").contains(d.optString("status"))) return true;
        JSONObject p = member(id); return p != null && (p.optBoolean("verifying") || p.optBoolean("removalPending"));
    }
    private void controls() {
        if (headerConnection != null) headerConnection.setText(connected ? tr("已连接", "Connected")
            : connectionBlocked || !EmbeddedNetwork.online() ? tr("离线", "Offline") : reconnecting ? tr("正在重连", "Reconnecting") : tr("正在连接", "Connecting"));
        if (workStatus != null) {
            if (connected) workStatus.reconnected();
            String value = !connected ? tr("等待同步会话…", "Waiting for conversation sync…")
                : pending.length() > 0 ? tr("操作待确认…", "Awaiting action confirmation…") : RemoteWorkStatus.discussion(group, chinese);
            if (value.isEmpty()) value = loadingAttachments ? tr("正在读取附件…", "Loading attachments…")
                : composer != null && selected.isEmpty() ? tr("未选择回答者：仅保存记录", "No respondents selected: saves a note") : tr("就绪", "Ready");
            workStatus.work(value);
        }
        if (toolbar != null) for (int i = 0; i < toolbar.getChildCount(); i++) toolbar.getChildAt(i).setEnabled(connected);
        if (composer != null) {
            boolean active = group != null && (group.optBoolean("active") || group.optBoolean("verifying"));
            composer.send.setEnabled(connected && !loadingAttachments && pending.length() == 0 && (composer.input.length() > 0 || !images.isEmpty() || !documents.isEmpty()));
            composer.stop.setVisibility(active ? View.VISIBLE : View.GONE); composer.stop.setEnabled(connected && active);
            composer.send.setVisibility(View.VISIBLE);
            composer.model.setText(mode.equals("serial") ? tr("依次回答", "Sequential replies") : tr("并行回答", "Parallel replies"));
            composer.model.setContentDescription(tr("回答方式", "Reply mode")); composer.model.setEnabled(connected);
        }
        if (pendingBar != null) {
            pendingBar.removeAllViews();
            for (String id : keys(pending)) {
                if (!uncertain.contains(id)) continue;
                TextView check = button(tr("操作待确认 · 查询 / 重试", "Unconfirmed action · check / retry"), "discussionPending:" + id, () -> poll(id, true));
                check.setEnabled(connected && !polling.contains(id)); pendingBar.addView(check);
            }
        }
    }
    private void chooseMode() {
        dialog = new SettingsChoiceDialog(this, tr("回答方式", "Reply mode"), new String[] { tr("并行回答", "Parallel replies"), tr("依次回答", "Sequential replies") },
            mode.equals("serial") ? 1 : 0, tr("取消", "Cancel"), index -> { mode = index == 0 ? "parallel" : "serial"; saveDraft(); controls(); });
        dialog.show();
    }
    private void send() {
        if (composer == null || loadingAttachments || composer.input.getText().toString().trim().isEmpty() && images.isEmpty() && documents.isEmpty()) return;
        try {
            ChatAttachments.validate(this, images, documents, true);
            if (images.size() + documents.size() > 16) throw new IllegalArgumentException(tr("讨论最多 16 个附件。", "Up to 16 discussion attachments."));
            JSONObject parameters = object("text", composer.input.getText().toString(), "participantIds", new JSONArray(selected), "mode", mode);
            if (!images.isEmpty() || !documents.isEmpty()) {
                if (!rich) throw new IllegalStateException(tr("请更新并重启主机以使用讨论附件。", "Update and restart the host for discussion attachments."));
                parameters.put("attachments", ChatAttachments.remote(images, documents));
            }
            saveDraft(); submit("send", groupId, parameters);
        } catch (Exception error) { showError(error.getMessage()); }
    }
    private void renderTools(LinearLayout block, JSONObject delivery) {
        for (JSONObject tool : rows(delivery.optJSONArray("tools"))) {
            String state = switch (tool.optString("status")) {
                case "completed" -> tr("已完成", "Completed"); case "failed" -> tr("失败", "Failed");
                case "running" -> tr("执行中", "Running"); default -> tool.optString("status");
            };
            TextView label = button(tool.optString("name") + " · " + state, "discussionTool:" + tool.optString("id"), () -> {
                String note = tool.optBoolean("detailsTruncated") ? tr("内容较长，仅显示部分详情；完整记录可在电脑查看。\n\n", "Showing part of a long result. Full details are available on the computer.\n\n") : "";
                TextView details = text(note + tool.optString("inputText") + "\n\n" + tool.optString("output"), 13, style.ink); details.setTypeface(Typeface.MONOSPACE); details.setTextIsSelectable(true);
                ScrollView scroll = new ScrollView(this); scroll.addView(details);
                dialog = new CamelliaDialog.Builder(this).setTitle(tool.optString("name")).setView(scroll).setPositiveButton(tr("关闭", "Close"), null).show();
            }); label.setGravity(Gravity.START | Gravity.CENTER_VERTICAL); block.addView(label);
        }
        if (delivery.optBoolean("toolsTruncated")) block.addView(text(tr("仅显示最近的工具记录。", "Showing the latest tool entries."), 12, style.muted));
        for (JSONObject request : rows(group.optJSONArray("pendingApprovals"))) if (request.optString("deliveryId").equals(delivery.optString("id"))) {
            block.addView(button(tr("处理审批 / 问题", "Review request"), "discussionApproval:" + request.optString("requestId"), () -> review(request)));
        }
        if (delivery.optString("status").equals("completed") && rows(delivery.optJSONArray("tools")).size() > 0)
            block.addView(button(tr("查看产物", "Files"), "discussionArtifacts:" + delivery.optString("id"), this::showFiles));
    }
    private String approvalToken(JSONObject request) {
        return groupId + ":" + instance + ":" + request.optString("deliveryId") + ":" + request.optString("runId") + ":" + request.optString("fingerprint");
    }
    private void review(JSONObject request) {
        if (!rich || !request.optBoolean("responseSupported")) { showError(tr("请更新主机，或在电脑查看此请求。", "Update the host or review this request on the computer.")); return; }
        String target = groupId, server = instance; JSONObject p = member(request.optString("participantId")); approvalKey = approvalToken(request);
        if (approvalDialog != null) approvalDialog.dismiss();
        approvalDialog = RemoteApprovalDialog.show(this, request, p == null ? "Agent" : p.optString("name"), (allow, input, optionId) -> {
            if (!connected || pending.length() > 0 || !target.equals(groupId) || !server.equals(instance)) return false;
            JSONObject parameters = object("deliveryId", request.optString("deliveryId"), "runId", request.opt("runId"), "approvalId", request.optString("requestId"), "fingerprint", request.optString("fingerprint"), "allow", allow);
            if (input != null) parameters.put("input", input); if (optionId != null) parameters.put("optionId", optionId);
            submit("permission-response", target, parameters); return pending.length() > 0;
        });
    }
    private void showFiles() { if (rich && groupId != null) downloads.showDiscussion(address, credentials.optString("token"), groupId); }
    private void renderAttachments() {
        if (attachmentTray == null) return;
        attachmentStrip.setVisibility(images.isEmpty() && documents.isEmpty() ? View.GONE : View.VISIBLE);
        ChatImageTray.fill(this, attachmentTray, images, style.surface, chinese, index -> { if (pending.length() == 0) { AttachmentStore.remove(this, images.remove(index)); renderAttachments(); saveDraft(); controls(); } });
        ChatDocumentTray.append(this, attachmentTray, documents, chinese, index -> { if (pending.length() == 0) { ChatAttachments.discard(this, List.of(), List.of(documents.remove(index))); renderAttachments(); saveDraft(); controls(); } });
    }
    private void attachmentMenu() {
        if (groupId == null) return;
        AttachSheet sheet = new AttachSheet(this); LinearLayout panel = sheet.panel();
        boolean ready = rich && connected && !loadingAttachments && pending.length() == 0 && images.size() + documents.size() < 16;
        sheet.note(panel, tr("最多 16 个附件 · 图片 4 MiB/张 · 文档 10 MiB/个 · 合计 32 MiB", "16 attachments · 4 MiB/image · 10 MiB/document · 32 MiB total"));
        sheet.tiles(panel, List.of(new AttachSheet.Tile("camera", tr("拍照", "Camera"), "discussionCamera", ready, () -> pickAttachment(3)),
            new AttachSheet.Tile("image", tr("照片", "Photos"), "discussionPhotos", ready, () -> pickAttachment(1)),
            new AttachSheet.Tile("file", tr("文件", "Files"), "discussionDocuments", ready, () -> pickAttachment(2))));
        LinearLayout options = sheet.group(panel, "");
        sheet.row(options, "folder", tr("查看产物", "Files"), "", "", "discussionFiles", rich && connected, () -> { dialog.dismiss(); showFiles(); });
        sheet.row(options, "shield", tr("安全级别", "Safety level"), "", group == null ? "" : RemoteSettingsPopup.permissionLabel(group.optString("permissionMode"), chinese),
            "discussionPermission", rich && connected && group != null && !group.optBoolean("active"), () -> {
                dialog.dismiss(); String[] levels = {"ask", "auto", "full"};
                dialog = new CamelliaDialog.Builder(this).setTitle(tr("安全级别", "Safety level"))
                    .setItems(new String[]{RemoteSettingsPopup.permissionLabel("ask", chinese), RemoteSettingsPopup.permissionLabel("auto", chinese), RemoteSettingsPopup.permissionLabel("full", chinese)},
                        (d, index) -> submit("set-permission", groupId, object("permissionMode", levels[index]))).show();
            });
        if (!rich) sheet.note(panel, tr("请更新并重启电脑端以启用附件和审批。", "Update and restart the host for attachments and approvals."));
        dialog = new CamelliaDialog.Builder(this).setTitle(tr("添加内容", "Add")).setView(panel).setNegativeButton(tr("关闭", "Close"), null).show();
    }
    private void pickAttachment(int kind) {
        dialog.dismiss(); pickerGroup = groupId;
        try {
            android.content.Intent intent;
            if (kind == 3) {
                java.io.File directory = new java.io.File(getCacheDir(), "camera"); if (!directory.exists() && !directory.mkdirs()) throw new java.io.IOException("Camera directory unavailable");
                cameraFile = java.io.File.createTempFile("discussion-", ".jpg", directory);
                intent = new android.content.Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE).putExtra(android.provider.MediaStore.EXTRA_OUTPUT, CameraFileProvider.uri(this, cameraFile))
                    .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION | android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } else intent = new android.content.Intent(android.content.Intent.ACTION_GET_CONTENT).setType(kind == 1 ? "image/*" : "*/*")
                .addCategory(android.content.Intent.CATEGORY_OPENABLE).putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE, true);
            startActivityForResult(intent, 810 + kind);
        } catch (Exception error) { showError(error.getMessage()); }
    }
    @Override protected void onActivityResult(int request, int result, android.content.Intent data) {
        super.onActivityResult(request, result, data);
        if (request == ArtifactDownloads.SAVE_REQUEST) { downloads.result(result, data, address, credentials.optString("token")); return; }
        if (request < 811 || request > 813) return;
        List<android.net.Uri> uris = new ArrayList<>(); final java.io.File photo = cameraFile;
        if (result == RESULT_OK) {
            if (request == 813 && photo != null) uris.add(CameraFileProvider.uri(this, photo));
            else if (data != null && data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
            else if (data != null && data.getData() != null) uris.add(data.getData());
        }
        if (uris.isEmpty()) { if (request == 813 && photo != null) photo.delete(); return; }
        String target = pickerGroup; loadingAttachments = true; controls();
        reads.execute(() -> {
            List<String> nextImages = new ArrayList<>(); List<JSONObject> nextDocuments = new ArrayList<>();
            try {
                if (uris.size() > 16) throw new IllegalArgumentException(tr("最多 16 个附件", "Up to 16 attachments"));
                for (android.net.Uri uri : uris) {
                    String type = getContentResolver().getType(uri);
                    if (request != 812 || type != null && type.startsWith("image/")) nextImages.add(ChatImage.encode(this, uri, ChatAttachments.IMAGE_MAX_SIDE, ChatAttachments.IMAGE_MAX_BYTES));
                    else nextDocuments.add(ChatDocument.read(this, uri, false));
                }
                runOnUiThread(() -> {
                    try {
                        if (isDestroyed() || !java.util.Objects.equals(target, groupId)) { ChatAttachments.discard(this, nextImages, nextDocuments); return; }
                        List<String> allImages = new ArrayList<>(images); allImages.addAll(nextImages); List<JSONObject> allDocuments = new ArrayList<>(documents); allDocuments.addAll(nextDocuments);
                        if (allImages.size() + allDocuments.size() > 16) throw new IllegalArgumentException(tr("最多 16 个附件", "Up to 16 attachments"));
                        ChatAttachments.validate(this, allImages, allDocuments, true); images.addAll(nextImages); documents.addAll(nextDocuments); renderAttachments(); saveDraft();
                    } catch (Exception error) { ChatAttachments.discard(this, nextImages, nextDocuments); showError(error.getMessage()); }
                    finally { loadingAttachments = false; controls(); }
                });
            } catch (Exception error) { ChatAttachments.discard(this, nextImages, nextDocuments); runOnUiThread(() -> { loadingAttachments = false; if (!isDestroyed()) { showError(error.getMessage()); controls(); } }); }
            finally { if (request == 813 && photo != null) photo.delete(); }
        });
    }
    private void pageMenu() {
        dialog = new CamelliaDialog.Builder(this).setTitle(tr("Agent 讨论 (beta)", "Agent discussions (beta)"))
            .setItems(new String[] { tr("普通会话", "Regular conversations"), tr("讨论群列表", "Discussions"), tr("刷新", "Refresh"), tr("管理当前群", "Manage discussion") }, (d, index) -> {
                if (index == 0) finish(); else if (index == 1) openGroup(null); else if (index == 2) connect(); else if (group != null) groupMenu(group);
            }).show();
    }
    private void createGroup() { editTitle(null); }
    private void editTitle(JSONObject target) {
        EditText input = field(tr("讨论群名称", "Discussion name"), target == null ? "" : target.optString("title"), 120, false, "discussionNameInput");
        dialog = new CamelliaDialog.Builder(this).setTitle(target == null ? tr("新建讨论群", "New discussion") : tr("重命名", "Rename")).setView(input)
            .setPositiveButton(tr("保存", "Save"), (d, w) -> submit(target == null ? "create" : "rename", target == null ? null : target.optString("id"), object("title", input.getText().toString())))
            .setNegativeButton(tr("取消", "Cancel"), (d, w) -> { if (target == null && groupId == null && getIntent().getBooleanExtra("fromNavigation", false)) finish(); }).show();
    }
    private void groupMenu(JSONObject target) {
        dialog = new CamelliaDialog.Builder(this).setTitle(target.optString("title")).setItems(new String[] {
            tr("重命名", "Rename"), target.optBoolean("pinned") ? tr("取消置顶", "Unpin") : tr("置顶", "Pin"), tr("删除讨论群", "Delete discussion") }, (d, which) -> {
                if (which == 0) editTitle(target);
                else if (which == 1) submit("pin", target.optString("id"), object("pinned", !target.optBoolean("pinned")));
                else dialog = new CamelliaDialog.Builder(this).setTitle(tr("删除讨论群？", "Delete discussion?"))
                    .setMessage(tr("将删除这个群的记录和附件。请先停止正在进行的回复。", "This deletes the group's history and attachments. Stop active replies first."))
                    .setPositiveButton(tr("删除", "Delete"), (x, y) -> submit("delete", target.optString("id"), new JSONObject())).setNegativeButton(tr("取消", "Cancel"), null).show();
            }).show();
    }
    private void showMembers() {
        if (group == null) return;
        memberPanel = column(); renderMembers();
        dialog = new CamelliaDialog.Builder(this).setTitle(tr("群成员", "Members")).setView(memberPanel).setNegativeButton(tr("关闭", "Close"), null).show();
        dialog.setOnDismissListener(d -> memberPanel = null);
    }
    private void renderMembers() {
        if (memberPanel == null) return;
        memberPanel.removeAllViews(); memberPanel.addView(text(tr("一个主题，最多四位成员。", "One topic, up to four members."), 13, style.muted));
        for (JSONObject p : liveMembers()) {
            String id = p.optString("id"); memberPanel.addView(speaker(id, p.optString("name")));
            memberPanel.addView(text(RemoteEngines.label(p.optString("engine")) + " · " + p.optString("connection") + " · " + p.optString("model"), 13, style.muted));
            JSONObject capability = p.optJSONObject("capability"); boolean available = capability != null && capability.optBoolean("available");
            String state = p.optBoolean("verifying") ? tr("正在验证连接…", "Verifying connection…") : available ? tr("连接可用", "Connection ready")
                : p.optString("verificationError", capability == null ? tr("连接待验证", "Connection unverified") : capability.optString("detail", tr("连接待验证", "Connection unverified")));
            TextView status = text(state, 13, available ? style.muted : style.accent); status.setTag("discussionMemberStatus:" + id); memberPanel.addView(status);
            if (!p.optString("identityPrompt").isEmpty()) memberPanel.addView(text(p.optString("identityPrompt"), 13, style.muted));
            LinearLayout actions = new LinearLayout(this);
            actions.addView(button(p.optBoolean("verifying") ? tr("取消验证", "Cancel check") : tr("验证连接", "Verify connection"), "discussionVerify:" + id,
                () -> submit(p.optBoolean("verifying") ? "cancel-member-verification" : "verify-member", groupId, object("participantId", id))));
            actions.addView(button(tr("移除", "Remove"), "discussionRemove:" + id, () -> submit("remove-member", groupId, object("participantId", id))));
            memberPanel.addView(actions);
        }
        if (liveMembers().size() < 4) memberPanel.addView(button(tr("添加成员", "Add member"), "discussionAddMember", () -> { if (dialog != null) dialog.dismiss(); loadCatalog(); }));
    }
    private void editIdentity(JSONObject participant) {
        if (memberBusy(participant.optString("id"))) { showError(tr("请等待该成员回复或验证完成，也可以先停止。", "Wait for this member to finish replying or verifying, or stop it first.")); return; }
        if (dialog != null) dialog.dismiss();
        EditText identity = field(tr("身份 prompt（可选）", "Identity prompt (optional)"), participant.optString("identityPrompt"), 4096, true, "discussionIdentityInput");
        dialog = new CamelliaDialog.Builder(this).setTitle(participant.optString("name")).setMessage(tr("例如：你是一位科学家。留空使用默认身份，从下一次回复生效。", "For example: You are a scientist. Leave blank for the default identity. Applies to the next reply."))
            .setView(identity).setPositiveButton(tr("保存", "Save"), (d, w) -> submit("set-identity", groupId, object("participantId", participant.optString("id"), "identityPrompt", identity.getText().toString())))
            .setNegativeButton(tr("取消", "Cancel"), null).show();
    }
    private void loadCatalog() {
        if (!connected || api == null) return;
        int ticket = generation; RemoteApi client = api;
        workStatus.notice(tr("正在读取主机模型…", "Loading host models…"));
        reads.execute(() -> { try { JSONObject result = client.json("/v1/discussions/catalog", credentials.optString("token"), null); deliver(ticket, () -> chooseHarness(rows(result.optJSONArray("bindings")))); }
            catch (Exception error) { deliver(ticket, () -> showError(RemoteApi.failureMessage(error, chinese))); } });
    }
    private void chooseHarness(List<JSONObject> bindings) {
        String[] engines = { "claude", "codex", "dsh", "kimi", "antigravity", "pi" };
        String[] labels = { "Claude Code", "Codex CLI", "DeepSeek Harness", "Kimi Code", "Antigravity", "Pi" };
        dialog = new CamelliaDialog.Builder(this).setTitle(tr("选择 Harness", "Choose harness")).setItems(labels, (d, index) -> {
            List<JSONObject> filtered = new ArrayList<>(); for (JSONObject row : bindings) if (row.optJSONObject("binding").optString("engine").equals(engines[index])) filtered.add(row);
            if (filtered.isEmpty()) { showError(tr("这个 Harness 尚无已配置的模型，请先在主机上配置。", "This harness has no configured models. Configure them on the host first.")); return; }
            chooseConnection(filtered);
        }).show();
    }
    private void chooseConnection(List<JSONObject> bindings) {
        LinkedHashSet<String> connections = new LinkedHashSet<>(); for (JSONObject row : bindings) connections.add(row.optJSONObject("binding").optString("connection"));
        List<String> modes = new ArrayList<>(connections);
        if (modes.size() == 1) { chooseBinding(bindings); return; }
        String[] labels = modes.stream().map(value -> value.equals("subscription") ? tr("订阅", "Subscription") : "API").toArray(String[]::new);
        dialog = new CamelliaDialog.Builder(this).setTitle(tr("连接方式", "Connection")).setItems(labels, (d, index) -> {
            List<JSONObject> filtered = new ArrayList<>(); for (JSONObject row : bindings) if (row.optJSONObject("binding").optString("connection").equals(modes.get(index))) filtered.add(row); chooseBinding(filtered);
        }).show();
    }
    private void chooseBinding(List<JSONObject> bindings) {
        String[] labels = bindings.stream().map(row -> row.optString("label") + (row.optString("providerLabel").isEmpty() ? "" : " · " + row.optString("providerLabel"))
            + (row.optJSONObject("binding").optString("connection").equals("subscription") && !row.optString("accountLabel").isEmpty() ? " · " + row.optString("accountLabel") : "")).toArray(String[]::new);
        dialog = new CamelliaDialog.Builder(this).setTitle(tr("选择模型", "Choose model")).setItems(labels, (d, index) -> addMember(bindings.get(index))).show();
    }
    private void addMember(JSONObject binding) {
        JSONObject capability = binding.optJSONObject("capability");
        if (capability != null && capability.has("supported") && !capability.optBoolean("supported")) { showError(capability.optString("detail")); return; }
        LinearLayout form = column();
        EditText name = field(tr("成员昵称", "Member name"), binding.optString("label"), 80, false, "discussionMemberName");
        EditText identity = field(tr("身份 prompt（可选）", "Identity prompt (optional)"), "", 4096, true, "discussionIdentityInput");
        form.addView(name); TextView note = text(tr("例如：你是一位科学家。也可以留空。", "For example: You are a scientist. You can leave this blank."), 13, style.muted);
        note.setPadding(0, dp(14), 0, dp(8)); form.addView(note); form.addView(identity);
        form.addView(text(tr("添加后自动验证连接，会消耗少量模型用量。", "The connection is checked automatically after adding and uses a small amount of model usage."), 12, style.muted));
        dialog = new CamelliaDialog.Builder(this).setTitle(tr("添加成员", "Add member")).setView(form)
            .setPositiveButton(tr("添加", "Add"), (d, w) -> submit("add-member", groupId, object("bindingId", binding.optString("id"), "name", name.getText().toString(), "identityPrompt", identity.getText().toString())))
            .setNegativeButton(tr("取消", "Cancel"), null).show();
    }

    private void submit(String action, String id, JSONObject parameters) {
        if (!connected || api == null || (!action.equals("stop") && !action.equals("cancel-member-verification") && pending.length() > 0)) return;
        String requestId = UUID.randomUUID().toString();
        JSONObject command = object("requestId", requestId, "instanceId", instance, "action", action, "parameters", parameters);
        try {
            if (id != null) command.put("id", id); pending.put(requestId, command);
            if (!persist()) { pending.remove(requestId); controls(); return; }
        }
        catch (Exception error) { showError(error.getMessage()); return; }
        sendCommand(requestId);
    }
    private void sendCommand(String requestId) {
        JSONObject command = pending.optJSONObject(requestId); if (command == null || api == null) return;
        lastError = ""; workStatus.clear();
        int ticket = generation; RemoteApi client = api; polling.add(requestId); controls();
        reads.execute(() -> {
            try { JSONObject result = client.json("/v1/discussions/commands", credentials.optString("token"), command); deliver(ticket, () -> receipt(command, result)); }
            catch (Exception error) { deliver(ticket, () -> {
                polling.remove(requestId); uncertain.add(requestId);
                if (error instanceof RemoteApi.Failure && List.of(400, 403, 409, 413).contains(((RemoteApi.Failure) error).status)) { pending.remove(requestId); persist(); }
                showError(RemoteApi.failureMessage(error, chinese)); controls();
            }); }
        });
    }
    private void poll(String requestId, boolean offerRetry) {
        JSONObject command = pending.optJSONObject(requestId); if (command == null || api == null || polling.contains(requestId)) return;
        int ticket = generation; RemoteApi client = api; polling.add(requestId); controls();
        reads.execute(() -> {
            try { JSONObject result = client.json("/v1/discussions/commands/" + requestId, credentials.optString("token"), null); deliver(ticket, () -> receipt(command, result)); }
            catch (Exception error) { deliver(ticket, () -> {
                polling.remove(requestId);
                if (error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 404) {
                    uncertain.add(requestId);
                    showError(tr("主机未找到这次操作的回执。可以重试原操作，不会创建新的请求。", "No receipt was found. You can retry the original operation with the same request ID."));
                    if (offerRetry) dialog = new CamelliaDialog.Builder(this).setTitle(tr("重试未确认的操作？", "Retry the unconfirmed operation?"))
                        .setMessage(lastError).setPositiveButton(tr("重试", "Retry"), (d, w) -> sendCommand(requestId))
                        .setNegativeButton(tr("暂不处理", "Later"), null).setNeutralButton(tr("取消此操作", "Discard operation"), (d, w) -> { pending.remove(requestId); persist(); controls(); }).show();
                } else showError(RemoteApi.failureMessage(error, chinese));
                controls();
            }); }
        });
    }
    private void receipt(JSONObject command, JSONObject result) {
        String requestId = command.optString("requestId"); polling.remove(requestId);
        uncertain.remove(requestId);
        if (!pending.has(requestId)) return;
        if (result.optString("state").equals("pending")) {
            int ticket = generation; handler.postDelayed(() -> { if (foreground && ticket == generation) poll(requestId, false); }, 1000); controls(); return;
        }
        pending.remove(requestId);
        if (result.optString("state").equals("completed")) {
            lastError = ""; workStatus.clear();
            String action = command.optString("action"), target = command.optString("id");
            if (action.equals("send")) {
                String sent = command.optJSONObject("parameters").optString("text"); JSONObject draft = drafts.optJSONObject(target);
                JSONArray sentFiles = command.optJSONObject("parameters").optJSONArray("attachments");
                if (sentFiles != null && draft != null && sentFiles.toString().equals(String.valueOf(draft.optJSONArray("attachments")))) {
                    draft.remove("attachments");
                    if (target.equals(groupId)) { ChatAttachments.discard(this, images, documents); images.clear(); documents.clear(); renderAttachments(); }
                }
                if (draft != null && draft.optString("text").equals(sent)) { try { draft.put("text", ""); } catch (Exception ignored) {} }
                if (target.equals(groupId) && composer != null && composer.input.getText().toString().equals(sent)) composer.input.setText("");
            }
            persist();
            if (action.equals("create")) { openGroup(result.optString("groupId")); return; }
            if (action.equals("delete") && target.equals(groupId)) { if (getIntent().getBooleanExtra("fromNavigation", false)) finish(); else openGroup(null); return; }
            workStatus.notice(tr("操作已完成", "Action completed"));
        } else { persist(); showError(result.optString("error", tr("操作失败", "Action failed"))); }
        controls();
    }
}
