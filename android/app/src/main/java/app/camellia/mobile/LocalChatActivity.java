package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.ImageView;
import android.widget.ImageButton;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class LocalChatActivity extends Activity {
    private AttachmentMaintenance.Lease composerAttachments;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Handler viewHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final HashSet<String> collapsed = new HashSet<>();
    private LocalChatStore store;
    private LocalChatClient client;
    private boolean chinese;
    private int background, surface, ink, muted, accent, generation;
    private int editingMessageIndex = -1;
    private String conversationId, runningId, query = "";
    private String latest = "";
    private final ExecutionProcessView.State processState = new ExecutionProcessView.State();
    private ExecutionProcessView liveProcess;
    private long lastCheckpoint;
    private JSONObject runningReply;
    private LinearLayout root, content, messageViews;
    private PageTransitions pages;
    private ScrollView scroll;
    private EditText composer;
    private ImageButton send, stop;
    private ImageButton toolsButton;
    private ImageButton attachButton;
    private final ArrayList<String> selectedImages = new ArrayList<>();
    private final ArrayList<JSONObject> selectedDocuments = new ArrayList<>();
    private LinearLayout imageTray;
    private android.widget.HorizontalScrollView imageStrip;
    private boolean loadingImages;
    private String imageConversation;
    private java.io.File cameraImageFile;
    private android.net.Uri cameraImageUri;
    private static final int PICK_IMAGE_REQUEST = 61, TAKE_PHOTO_REQUEST = 62, PICK_DOCUMENT_REQUEST = 63;
    private ChatStyle chatStyle;
    private ConversationMenu conversationPopup;
    private boolean selectingConversations;
    private final java.util.Set<String> selectedConversations = new java.util.LinkedHashSet<>();
    private TextView modelButton;
    private ChatComposer chatComposer;
    private ModelPickerPopup modelPicker;
    private TextView status;
    private StreamingMarkdownView liveMarkdown;
    private final java.util.IdentityHashMap<JSONObject, LocalMessage> messageBindings = new java.util.IdentityHashMap<>();
    private AlertDialog dialog;
    private boolean reloadSettings;
    private LocalChatStore.Reply replyHandle;
    private int storageRevision;
    private boolean foreground, sendPending, closeRequested, finishingAfterSave;
    private Button storageRetry;
    private String storageError = "";
    private final LocationConsent locationConsent = new LocationConsent(this);

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        locationConsent.permissionResult(requestCode);
    }

    @Override protected void attachBaseContext(android.content.Context context) { super.attachBaseContext(MobilePreferences.wrap(context)); }

    @Override protected void onResume() {
        super.onResume();
        if (reloadSettings) {
            reloadSettings = false;
            loadStore(false);
        }
    }

    @Override protected void onStart() { super.onStart(); foreground = true; AttachmentMaintenance.foreground(this); }

    private interface Stored<T> { void run(T value) throws Exception; }

    private <T> LocalChatStore.Callback<T> stored(Stored<T> action) {
        return new LocalChatStore.Callback<>() {
            public void done(T value) {
                if (isDestroyed()) return;
                try { action.run(value); }
                catch (Exception error) { storageFailure(error); }
            }
            public void failed(Exception error) { if (!isDestroyed()) storageFailure(error); }
        };
    }

    private void storageFailure(Exception error) {
        storageError = ErrorDetails.withSummary(tr("聊天数据尚未保存，请重试。", "Chat data has not been saved. Retry."), error);
        if (status != null) status.setText(storageError);
        if (storageRetry != null) storageRetry.setVisibility(View.VISIBLE);
    }

    private void retryStorage() {
        try {
            store.flush(stored(value -> {
                storageError = ""; if (storageRetry != null) storageRetry.setVisibility(View.GONE); updateControls();
            }));
        } catch (Exception error) { storageFailure(error); }
    }

    private void loadStore(boolean recover) {
        int revision = ++storageRevision;
        shell(tr("正在读取本机聊天…", "Loading local chats…"));
        LocalChatStore.open(this, recover ? tr("上次回复已中断，未自动重发。", "Previous reply interrupted; not automatically resent.") : null, new LocalChatStore.Callback<>() {
            public void done(LocalChatStore value) {
                if (isDestroyed() || revision != storageRevision) return;
                store = value;
                if (conversationId != null && store.conversation(conversationId) != null) detail(); else list();
                if (value.cleanupError != null && status != null) status.setText(ErrorDetails.withSummary(tr("旧数据副本清理失败，下次打开时会重试。", "Old data cleanup failed; it will retry next time."), value.cleanupError));
                if (value.pendingError != null) storageFailure(value.pendingError);
            }
            public void failed(Exception error) {
                if (isDestroyed() || revision != storageRevision) return;
                store = null; shell(tr("本机聊天不可用", "Local chat unavailable"));
                content.addView(text(ErrorDetails.withSummary(tr("无法读取或解密本机数据。原数据已保留。", "Could not read or decrypt local data. Stored data was preserved."), error), 15, ink));
                content.addView(button(tr("重新读取", "Read again"), "localStorageLoadRetry", () -> loadStore(recover)));
            }
        });
    }

    private void providerSettings() {
        if (runningId != null || sendPending) { status.setText(tr("请先停止回复，再更换 API 配置。", "Stop the reply before replacing API configuration.")); return; }
        persistDraft(); reloadSettings = true;
        startActivity(new android.content.Intent(this, SettingsActivity.class).putExtra("section", "providers")); PageTransitions.openActivity(this);
    }

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        composerAttachments = AttachmentMaintenance.protect(this);
        PageTransitions.configureActivity(this);
        chinese = getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        chatStyle = new ChatStyle(this);
        background = chatStyle.background; surface = chatStyle.surface; ink = chatStyle.ink; muted = chatStyle.muted; accent = chatStyle.accent;
        getWindow().setStatusBarColor(background); getWindow().setNavigationBarColor(background);
        if (!dark) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        if (saved != null) { conversationId = saved.getString("conversationId"); query = saved.getString("query", ""); }
        loadStore(true);
    }

    @Override protected void onSaveInstanceState(Bundle saved) {
        super.onSaveInstanceState(saved);
        saved.putString("conversationId", conversationId); saved.putString("query", query);
    }

    @Override protected void onStop() {
        foreground = false; generation++;
        if (conversationPopup != null) conversationPopup.dismiss();
        locationConsent.cancel();
        if (pages != null) pages.finishTransition();
        if (modelPicker != null) modelPicker.dismiss();
        if (client != null) finishRun(tr("已暂停：离开应用后不继续请求；不会自动重发。", "Paused on leaving the app; not automatically resent."), "interrupted");
        persistDraft();
        if (store != null) try { store.flush(stored(value -> {})); } catch (Exception error) { storageFailure(error); }
        super.onStop();
    }

    @Override protected void onDestroy() {
        if (pages != null) { pages.finishTransition(); pages = null; }
        releasePageViews();
        if (composerAttachments != null) composerAttachments.close();
        handler.removeCallbacksAndMessages(null); worker.shutdownNow();
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        if (store == null) { finish(); return; }
        if (selectingConversations) { selectingConversations = false; selectedConversations.clear(); list(); return; }
        if (conversationId != null) { persistDraft(); conversationId = null; list(); }
        else super.onBackPressed();
    }

    @Override public void finish() {
        if (store == null || finishingAfterSave) { super.finish(); PageTransitions.closeActivity(this); return; }
        persistDraft();
        if (sendPending) { closeRequested = true; generation++; return; }
        if (client != null) finishRun(tr("已暂停，部分回复已保留。", "Paused; partial reply kept."), "interrupted");
        try {
            store.flush(stored(value -> { finishingAfterSave = true; finish(); }));
        } catch (Exception error) { storageFailure(error); }
    }

    private String tr(String zh, String en) { return chinese ? zh : en; }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private LinearLayout column() { LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); return layout; }
    private GradientDrawable shape(int color) { return chatStyle.rounded(color); }
    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color);
        view.setPadding(0, dp(6), 0, dp(6)); view.setLineSpacing(dp(3), 1); return view;
    }
    private Button button(String label, String tag, Runnable action) {
        Button button = new Button(this); button.setText(label); button.setTag(tag); button.setAllCaps(false);
        button.setTextSize(14); button.setTextColor(new ColorStateList(new int[][] { {-android.R.attr.state_enabled}, {} }, new int[] {muted, ink}));
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(0x224176e6), chatStyle.capsule(surface), chatStyle.capsule(Color.WHITE)));
        button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        button.setPadding(dp(14), dp(8), dp(14), dp(8)); button.setMinHeight(dp(48)); button.setStateListAnimator(null);
        button.setOnClickListener(view -> action.run()); return button;
    }
    private TextView dialogAction(String label, String tag, boolean primary, Runnable action) {
        TextView view = text(label, 15, primary ? Color.WHITE : ink); view.setTag(tag); view.setGravity(Gravity.CENTER);
        view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); view.setMinHeight(dp(48));
        view.setBackground(new RippleDrawable(ColorStateList.valueOf(0x224176e6), chatStyle.capsule(primary ? accent : new SettingsStyle(this).card), chatStyle.capsule(Color.WHITE)));
        view.setOnClickListener(clicked -> action.run()); return view;
    }
    private void showStyledDialog(LinearLayout panel) {
        dialog = new CamelliaDialog.Builder(this).setView(panel).create(); dialog.show();
    }
    private EditText input(String hint, String tag) {
        EditText input = tag.equals("localComposer") ? new ComposerInput(this) : new EditText(this); input.setHint(hint); input.setTag(tag); input.setTextSize(15);
        input.setTextColor(ink); input.setHintTextColor(muted); input.setBackground(chatStyle.capsule(surface));
        input.setContentDescription(hint); input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        input.setPadding(dp(14), dp(12), dp(14), dp(12)); input.setMinHeight(dp(48)); return input;
    }
    private void shell(String title) {
        releasePageViews();
        if (conversationId == null) composerAttachments.replace();
        root = column(); root.setBackgroundColor(background); root.setPadding(dp(18), dp(12), dp(18), chatStyle.dockBottomPadding());
        root.setClipToPadding(false);
        if (conversationId != null) { root.setFocusableInTouchMode(true); root.requestFocus(); }
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(dp(18) + insets.getSystemWindowInsetLeft(), dp(12) + insets.getSystemWindowInsetTop(),
                dp(18) + insets.getSystemWindowInsetRight(), chatStyle.dockBottomPadding() + insets.getSystemWindowInsetBottom());
            return insets;
        });
        if (pages == null) pages = new PageTransitions(this);
        pages.show(root, conversationId == null ? "list" : "detail:" + conversationId, conversationId == null ? 0 : 1);
        root.requestApplyInsets();
        LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL); header.setPadding(0, 0, 0, dp(18));
        header.setClipChildren(false); header.setClipToPadding(false);
        ImageButton back = chatStyle.backButton(tr("返回上一级", "Back"), this::onBackPressed); back.setTag("localBack");
        header.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));
        LinearLayout titles = column(); titles.setPadding(dp(10), 0, 0, 0);
        TextView heading = text(title, 19, ink); heading.setSingleLine(true); heading.setEllipsize(android.text.TextUtils.TruncateAt.END);
        if (conversationId != null) heading.setTag("localChatTitle");
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); titles.addView(heading);
        LinearLayout device = new LinearLayout(this); device.setGravity(Gravity.CENTER_VERTICAL);
        ImageView phone = new ImageView(this); phone.setImageDrawable(new LineIcon("phone", muted));
        device.addView(phone, new LinearLayout.LayoutParams(dp(14), dp(14)));
        TextView subtitle = text(tr("本机 · 手机直连 API", "On this phone · Direct API"), 12, muted);
        subtitle.setPadding(dp(6), 0, 0, 0); subtitle.setSingleLine(true); subtitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        device.addView(subtitle); titles.addView(device);
        header.addView(titles, new LinearLayout.LayoutParams(0, -2, 1)); root.addView(header);
        scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setVerticalScrollBarEnabled(false);
        content = column(); content.setPadding(0, 0, 0, dp(16)); scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        status = text("", 11, muted); status.setTag("localStatus"); status.setGravity(Gravity.CENTER);
        status.setSingleLine(true); status.setMinLines(1); status.setEllipsize(android.text.TextUtils.TruncateAt.END);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); root.addView(status, new LinearLayout.LayoutParams(-1, -2));
        storageRetry = button(tr("重试保存", "Retry saving"), "localStorageRetry", this::retryStorage);
        storageRetry.setVisibility(storageError.isEmpty() ? View.GONE : View.VISIBLE); root.addView(storageRetry);
        status.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
            public void onTextChanged(CharSequence value, int start, int before, int count) {}
            public void afterTextChanged(Editable value) {
                boolean quiet = value.length() == 0 || value.toString().equals(tr("本机模式 · 聊天记录仅保存在此设备", "Local mode · Chat history stays on this device"));
                status.setVisibility(conversationId != null || !quiet ? View.VISIBLE : View.GONE);
            }
        });
        status.setVisibility(conversationId == null ? View.GONE : View.VISIBLE);
        ErrorDetails.bindStatus(this, status, chinese);
    }

    private LinearLayout bottomBar(String tag) {
        chatStyle.dockStatus(status);
        root.removeView(status);
        int scrollIndex = root.indexOfChild(scroll);
        LinearLayout.LayoutParams stageParams = (LinearLayout.LayoutParams) scroll.getLayoutParams();
        root.removeView(scroll);
        android.widget.FrameLayout stage = new android.widget.FrameLayout(this); stage.setTag(tag + "Stage");
        stage.setClipChildren(false); stage.setClipToPadding(false);
        android.widget.FrameLayout viewport = new android.widget.FrameLayout(this);
        viewport.setClipChildren(true); viewport.setClipToPadding(true);
        viewport.addView(scroll, new android.widget.FrameLayout.LayoutParams(-1, -1));
        stage.addView(viewport, new android.widget.FrameLayout.LayoutParams(-1, -1));
        LinearLayout dock = column(); dock.setTag(tag + "Dock"); dock.setBackground(chatStyle.dockBackdrop());
        dock.setClipChildren(false); dock.setClipToPadding(false);
        dock.addView(chatStyle.dockFade(tag), new LinearLayout.LayoutParams(-1, chatStyle.dockFadeHeight()));
        LinearLayout bar = new LinearLayout(this); bar.setGravity(Gravity.CENTER_VERTICAL); bar.setTag(tag);
        bar.setClipChildren(false); bar.setClipToPadding(false);
        if (!tag.equals("localSearchBar")) chatStyle.floatingBar(bar);
        bar.setPadding(dp(6), dp(6), dp(6), dp(6));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, 0, 0, dp(8));
        dock.addView(bar, params);
        status.setBackgroundColor(background); dock.addView(status, new LinearLayout.LayoutParams(-1, -2));
        android.widget.FrameLayout.LayoutParams dockParams = new android.widget.FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        chatStyle.reserveDockSpace(dock, content);
        stage.addView(dock, dockParams); root.addView(stage, scrollIndex, stageParams); return bar;
    }
    private void failure(Exception error) {
        String detail = ErrorDetails.describe(error);
        boolean userFacing = error instanceof IllegalArgumentException || error instanceof java.io.IOException || error instanceof IllegalStateException;
        status.setText(userFacing ? detail : ErrorDetails.withSummary(
            tr("操作失败，未自动重试。请检查配置或稍后重试。", "Operation failed; not automatically retried. Check configuration or try later."), error));
    }
    private String title(JSONObject conversation) { return conversation.optString("title").isEmpty() ? tr("新会话", "New conversation") : conversation.optString("title"); }

    private void list() {
        storageRevision++;
        store.releaseHistory();
        processState.clear();
        conversationId = null; shell(tr("本机聊天", "Local chat"));
        status.setText(tr("本机模式 · 聊天记录仅保存在此设备", "Local mode · Chat history stays on this device"));
        root.setClipChildren(false);
        LinearLayout groups = column(); groups.setTag("localGroups"); content.addView(groups);
        renderGroups(groups);
        LinearLayout bottom = bottomBar("localSearchBar"); bottom.setElevation(0); bottom.setPadding(0, dp(6), 0, dp(6));
        LinearLayout searchPill = new LinearLayout(this); searchPill.setGravity(Gravity.CENTER_VERTICAL); chatStyle.floatingBar(searchPill);
        LinearLayout.LayoutParams searchParams = new LinearLayout.LayoutParams(0, -2, 1); searchParams.setMargins(0, 0, dp(10), 0); bottom.addView(searchPill, searchParams);
        ImageView searchIcon = new ImageView(this); searchIcon.setImageDrawable(new LineIcon("search", ink)); searchIcon.setPadding(dp(10), dp(10), dp(10), dp(10));
        searchPill.addView(searchIcon, new LinearLayout.LayoutParams(dp(44), dp(44)));
        EditText search = input(tr("搜索本机会话", "Search local chats"), "localSearch"); search.setSingleLine(true); search.setText(query);
        search.setTextSize(16); search.setBackgroundColor(Color.TRANSPARENT); search.setPadding(dp(2), dp(12), dp(8), dp(12));
        searchPill.addView(search, new LinearLayout.LayoutParams(0, -2, 1));
        ImageButton create = chatStyle.lineButton("new", tr("新建独立会话", "New standalone chat"), () -> createConversation(""));
        create.setTag("localNewStandalone"); create.setElevation(dp(2)); bottom.addView(create, new LinearLayout.LayoutParams(dp(48), dp(48)));
        search.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
            public void onTextChanged(CharSequence value, int start, int before, int count) { query = value.toString(); renderGroups(groups); }
            public void afterTextChanged(Editable value) {}
        });
        updateListDock((content.getGravity() & Gravity.VERTICAL_GRAVITY_MASK) == Gravity.CENTER_VERTICAL);
    }

    private void renderGroups(LinearLayout groups) {
        if (conversationPopup != null) conversationPopup.dismiss();
        int position = scroll.getScrollY();
        groups.removeAllViews();
        JSONArray workspaces = store.workspaces();
        boolean hasConversations = false, matches = false;
        String term = query.toLowerCase(java.util.Locale.ROOT);
        JSONArray conversations = store.conversations();
        for (int index = 0; index < conversations.length(); index++) {
            JSONObject conversation = conversations.optJSONObject(index);
            if (conversation != null && !conversation.optBoolean("archived")) {
                hasConversations = true;
                if (!query.isEmpty() && title(conversation).toLowerCase(java.util.Locale.ROOT).contains(term)) matches = true;
            }
        }
        if (query.isEmpty() && workspaces.length() == 0 && !hasConversations) {
            ChatEmptyState welcome = new ChatEmptyState(this, chatStyle, "brand", tr("开始第一段对话", "Start your first conversation"),
                tr("新建独立会话直接开始，或创建工作区整理会话。", "Start a standalone chat, or create a workspace to organize your conversations."));
            welcome.addAction(tr("新建独立会话", "New standalone chat"), "localEmptyNewStandalone", () -> createConversation(""));
            welcome.addAction(tr("新建工作区", "New workspace"), "localNewWorkspace", () -> nameDialog(null));
            groups.addView(welcome); layoutGroups(true, position); return;
        }
        if (!query.isEmpty() && !matches) {
            groups.addView(new ChatEmptyState(this, chatStyle, "search", tr("没有找到会话", "No conversations found"),
                tr("试试更短的关键词，或清除搜索查看全部会话。", "Try a shorter keyword, or clear the search to see all conversations."),
                tr("清除搜索", "Clear search"), () -> ((EditText) root.findViewWithTag("localSearch")).setText("")));
            layoutGroups(true, position); return;
        }
        if (selectingConversations) {
            LinearLayout actions = new LinearLayout(this);
            Button cancel = button(tr("取消多选", "Cancel selection"), "selectionCancel",
                () -> { selectingConversations = false; selectedConversations.clear(); renderGroups(groups); });
            Button delete = button(tr("删除所选", "Delete selected") + " (" + selectedConversations.size() + ")",
                "selectionDelete", this::deleteSelectedConversations);
            delete.setEnabled(!selectedConversations.isEmpty());
            actions.addView(cancel, new LinearLayout.LayoutParams(0, -2, 1));
            actions.addView(delete, new LinearLayout.LayoutParams(0, -2, 1)); groups.addView(actions);
        }
        try { if (LocalChatConfig.routes(store.config()).isEmpty()) groups.addView(text(tr("先在「供应商与 Key」填写 API 配置，或粘贴导入。", "Add a provider and API key, or paste an export."), 14, muted)); }
        catch (Exception error) { failure(error); }
        groups.addView(chatStyle.workspaceHeader(workspaces.length() == 0 ? tr("新建工作区", "New workspace") : tr("工作区", "Workspaces"),
            tr("新建工作区", "New workspace"), "localNewWorkspace", () -> nameDialog(null)));
        for (int index = 0; index < workspaces.length(); index++) {
            JSONObject workspace = workspaces.optJSONObject(index);
            if (workspace != null) group(groups, workspace.optString("id"), workspace.optString("name"), workspace);
        }
        group(groups, "", tr("独立会话", "Standalone chats"), null);
        layoutGroups(false, position);
    }

    private void layoutGroups(boolean centered, int position) {
        boolean wasCentered = (content.getGravity() & Gravity.VERTICAL_GRAVITY_MASK) == Gravity.CENTER_VERTICAL;
        content.setGravity(centered ? Gravity.CENTER_VERTICAL : Gravity.TOP);
        updateListDock(centered);
        ScrollView target = scroll;
        target.post(() -> target.scrollTo(0, centered || wasCentered ? 0 : position));
    }

    private void updateListDock(boolean centered) {
        View dock = root.findViewWithTag("localSearchBarDock");
        if (dock == null) return; // The first group render precedes toolbar creation.
        boolean welcome = centered && query.isEmpty();
        dock.setVisibility(welcome ? View.GONE : View.VISIBLE);
        content.setPadding(content.getPaddingLeft(), content.getPaddingTop(), content.getPaddingRight(), dp(16) + (welcome ? 0 : dock.getHeight()));
    }

    private void group(LinearLayout parent, String id, String name, JSONObject workspace) {
        List<JSONObject> entries = new ArrayList<>();
        String term = query.toLowerCase(java.util.Locale.ROOT);
        for (JSONObject conversation : store.orderedConversations(id)) {
            if (conversation != null && !conversation.optBoolean("archived") && conversation.optString("workspaceId").equals(id)
                && title(conversation).toLowerCase(java.util.Locale.ROOT).contains(term)) entries.add(conversation);
        }
        if (!query.isEmpty() && entries.isEmpty()) return;
        LinearLayout group = column(); LinearLayout.LayoutParams groupParams = new LinearLayout.LayoutParams(-1, -2);
        groupParams.setMargins(0, dp(12), 0, dp(4)); parent.addView(group, groupParams);
        LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL);
        if (workspace != null) {
            ImageView folder = new ImageView(this); folder.setImageDrawable(new LineIcon("folder", ink)); folder.setPadding(dp(2), 0, dp(10), 0);
            header.addView(folder, new LinearLayout.LayoutParams(dp(32), dp(24)));
        }
        DisclosureHeader label = new DisclosureHeader(this, name, workspace == null ? muted : ink, muted, collapsed.contains(id));
        label.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); label.setPadding(0, dp(8), dp(4), dp(8));
        label.setBackground(new RippleDrawable(ColorStateList.valueOf(0x224176e6), shape(background), shape(Color.WHITE)));
        label.setTag("localGroup:" + id);
        label.setContentDescription(name + " · " + (collapsed.contains(id) ? tr("展开", "Expand") : tr("折叠", "Collapse")));
        label.setOnClickListener(view -> { if (!collapsed.add(id)) collapsed.remove(id); renderGroups(parent); });
        if (workspace != null) MobileHaptics.setOnLongClickListener(label, view -> { workspaceMenu(workspace); return true; });
        header.addView(label, new LinearLayout.LayoutParams(0, -2, 1));
        if (workspace != null) {
            ImageButton manage = chatStyle.lineButton("more", tr("管理工作区", "Manage workspace") + " · " + name, () -> workspaceMenu(workspace));
            manage.setTag("localWorkspaceMenu:" + id);
            header.addView(manage, new LinearLayout.LayoutParams(dp(48), dp(48)));
        }
        ImageButton add = chatStyle.lineButton("new", tr("新建会话：", "New chat: ") + name, () -> createConversation(id)); add.setTag("localAdd:" + id);
        header.addView(add, new LinearLayout.LayoutParams(dp(48), dp(48))); group.addView(header);
        if (collapsed.contains(id) && query.isEmpty()) return;
        for (JSONObject conversation : entries) {
            String selectedId = conversation.optString("id");
            ConversationRow row = new ConversationRow(this, chatStyle, !id.isEmpty(), title(conversation),
                selectedId.equals(runningId) ? tr("正在回复", "Replying") : conversation.optBoolean("pinned") ? tr("已置顶", "Pinned") : "", "localConversation:" + selectedId,
                "localConversationStatus:" + selectedId,
                () -> {
                    if (selectingConversations) {
                        if (!selectedConversations.add(selectedId)) selectedConversations.remove(selectedId);
                        renderGroups(parent);
                    } else { conversationId = selectedId; detail(); }
                }, () -> conversationMenu(conversation));
            row.selection(selectingConversations, selectedConversations.contains(selectedId)); group.addView(row);
        }
        if (entries.isEmpty()) {
            TextView empty = text(tr("暂无会话", "No conversations yet"), 13, muted);
            empty.setPadding(dp(id.isEmpty() ? 2 : 32), dp(8), dp(8), dp(8)); group.addView(empty);
        }
    }

    private void nameDialog(JSONObject workspace) {
        EditText name = input(tr("工作区名称", "Workspace name"), "localWorkspaceName"); name.setSingleLine(true);
        if (workspace != null) name.setText(workspace.optString("name"));
        SettingsField field = new SettingsField(name);
        AlertDialog editor = new CamelliaDialog.Builder(this).setTitle(tr("本机工作区", "Local workspace")).setView(field)
            .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("保存", "Save"), null).create();
        dialog = editor;
        editor.setOnShowListener(event -> editor.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            String value = name.getText().toString().trim();
            if (value.isEmpty() || value.length() > 80) { field.showError(tr("请输入 1–80 字名称", "Enter a name of 1–80 characters")); return; }
            try {
                Stored<JSONObject> saved = result -> { if (dialog == editor) { editor.dismiss(); list(); } };
                if (workspace == null) store.createWorkspace(value, stored(saved));
                else store.renameWorkspace(workspace.getString("id"), value, stored(saved));
            } catch (Exception error) { failure(error); }
        })); editor.show();
    }

    private void workspaceMenu(JSONObject workspace) {
        dialog = new CamelliaDialog.Builder(this).setTitle(workspace.optString("name"))
            .setItems(new String[] { tr("重命名", "Rename"), tr("移除工作区（保留会话）", "Remove workspace (keep chats)") }, (selected, which) -> {
                if (which == 0) nameDialog(workspace);
                else store.deleteWorkspace(workspace.optString("id"), stored(result -> list()));
            }).show();
    }

    private void conversationMenu(JSONObject conversation) {
        if (conversation.optString("id").equals(runningId)) { status.setText(tr("请先停止此会话的回复。", "Stop this reply first.")); return; }
        if (conversationPopup != null) conversationPopup.dismiss();
        View anchor = root.findViewWithTag("localConversation:" + conversation.optString("id"));
        if (anchor == null) return;
        conversationPopup = new ConversationMenu(anchor, chatStyle, chinese, conversation.optBoolean("pinned"),
            () -> renameConversation(conversation), () -> {
                selectingConversations = true; selectedConversations.add(conversation.optString("id")); list();
            }, () -> {
                try { store.pinConversation(conversation.optString("id"), !conversation.optBoolean("pinned"), stored(result -> list())); }
                catch (Exception error) { failure(error); }
            }, () -> archiveConversation(conversation), () -> deleteConversationDialog(conversation));
    }

    private void renameConversation(JSONObject conversation) {
        EditText name = input(tr("会话标题", "Chat title"), "localRename"); name.setText(title(conversation)); name.setSingleLine(true);
        SettingsField field = new SettingsField(name);
        AlertDialog editor = new CamelliaDialog.Builder(this).setTitle(tr("重命名", "Rename")).setView(field).setNegativeButton(tr("取消", "Cancel"), null)
            .setPositiveButton(tr("保存", "Save"), null).create();
        dialog = editor;
        editor.setOnShowListener(event -> editor.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            String value = name.getText().toString().trim();
            if (value.isEmpty() || value.length() > 100) { field.showError(tr("请输入 1–100 字标题", "Enter a title of 1–100 characters")); return; }
            try { store.patchConversation(conversation.getString("id"), new JSONObject().put("title", value), stored(result -> { if (dialog == editor) { editor.dismiss(); if (conversationId == null) list(); else detail(); } })); }
            catch (Exception error) { failure(error); }
        })); editor.show();
    }

    private void deleteSelectedConversations() {
        java.util.Set<String> targets = new java.util.LinkedHashSet<>(selectedConversations);
        if (targets.contains(runningId)) { status.setText(tr("请先停止所选会话的回复。", "Stop the selected reply first.")); return; }
        // Same rule as the remote list: no stray "(1)" when a single chat is selected.
        String message = targets.size() == 1
            ? tr("将永久删除此会话的聊天记录，无法撤销。", "Permanently deletes this chat. This cannot be undone.")
            : tr("将永久删除所选的 " + targets.size() + " 个会话，无法撤销。", "Permanently deletes the " + targets.size() + " selected chats. This cannot be undone.");
        dialog = new CamelliaDialog.Builder(this).setTitle(tr("删除所选会话？", "Delete selected chats?"))
            .setMessage(message)
            .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("删除", "Delete"), (selected, which) -> {
                try {
                    if (targets.contains(runningId)) return;
                    store.deleteConversations(targets, stored(result -> { selectingConversations = false; selectedConversations.clear(); list(); }));
                } catch (Exception error) { failure(error); }
            }).show();
    }

    // Archiving lives in the conversation long-press menu, so the chat is never
    // open here: hide it from the list and stay in the list.
    private void archiveConversation(JSONObject conversation) {
        try {
            store.archiveConversation(conversation.optString("id"), true, stored(result -> list()));
        } catch (Exception error) { failure(error); }
    }

    private void deleteConversationDialog(JSONObject conversation) {
        // The sheet already paints the dialog surface; a second background here
        // would draw a card inside the panel and read as a box in a box.
        LinearLayout panel = column();
        TextView heading = text(tr("删除本机会话？", "Delete this local chat?"), 21, ink);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setPadding(dp(8), dp(2), dp(8), 0); panel.addView(heading);
        TextView message = text(tr("聊天记录将永久删除，此操作无法撤销。", "The chat history will be permanently deleted. This cannot be undone."), 14, muted);
        message.setPadding(dp(8), dp(8), dp(8), dp(18)); panel.addView(message);
        LinearLayout actions = new LinearLayout(this);
        TextView cancel = dialogAction(tr("取消", "Cancel"), "localDeleteCancel", false, () -> dialog.dismiss());
        TextView delete = dialogAction(tr("删除", "Delete"), "localDeleteConfirm", true, () -> {
            dialog.dismiss();
            store.deleteConversations(java.util.Set.of(conversation.optString("id")), stored(result -> list()));
        });
        LinearLayout.LayoutParams left = new LinearLayout.LayoutParams(0, dp(48), 1); left.setMargins(0, 0, dp(6), 0);
        LinearLayout.LayoutParams right = new LinearLayout.LayoutParams(0, dp(48), 1); right.setMargins(dp(6), 0, 0, 0);
        actions.addView(cancel, left); actions.addView(delete, right); panel.addView(actions);
        showStyledDialog(panel);
    }

    private void createConversation(String workspaceId) {
        try {
            List<LocalChatConfig.Route> routes = LocalChatConfig.routes(store.config());
            if (routes.isEmpty()) { providerSettings(); return; }
            store.createConversation(workspaceId, routes.get(0).id, stored(result -> { conversationId = result.getString("id"); store.useConversation(result); detail(); }));
        } catch (Exception error) { failure(error); }
    }

    private void detail() {
        if (!store.hasHistory(conversationId)) {
            String target = conversationId; int revision = ++storageRevision;
            shell(tr("正在读取会话…", "Loading conversation…"));
            store.readConversation(target, new LocalChatStore.Callback<>() {
                public void done(JSONObject value) {
                    if (isDestroyed() || revision != storageRevision || !target.equals(conversationId)) return;
                    if (value == null) { list(); return; }
                    store.useConversation(value); detail();
                }
                public void failed(Exception error) {
                    if (isDestroyed() || revision != storageRevision || !target.equals(conversationId)) return;
                    content.addView(text(ErrorDetails.withSummary(tr("无法读取会话，原数据已保留。", "Could not read this chat. Stored data was preserved."), error), 14, ink));
                    content.addView(button(tr("重新读取", "Read again"), "localConversationLoadRetry", () -> detail()));
                }
            });
            return;
        }
        JSONObject conversation = store.conversation(conversationId);
        if (conversation == null) { list(); return; }
        editingMessageIndex = LocalChatDraft.editIndex(conversation);
        selectedImages.clear();
        selectedDocuments.clear();
        try {
            JSONArray draftImages = LocalChatDraft.images(conversation);
            for (int index = 0; index < draftImages.length(); index++) selectedImages.add(draftImages.getString(index));
            JSONArray documents = LocalChatDraft.documents(conversation);
            for (int index = 0; index < documents.length(); index++) selectedDocuments.add(documents.getJSONObject(index));
        } catch (Exception error) { failure(error); }
        imageConversation = conversationId;
        shell(title(conversation));
        scroll.setVerticalScrollBarEnabled(false);
        messageViews = column(); content.addView(messageViews); renderMessages();
        LinearLayout bar = bottomBar("localComposerBar");
        chatComposer = new ChatComposer(bar, chatStyle, chinese, tr("输入消息", "Message"), 100000,
            this::chooseModel, this::sendMessage,
            () -> finishRun(tr("已停止，部分回复已保留。", "Stopped; partial reply kept."), "stopped"), this::cancelEdit);
        composer = chatComposer.input; composer.setTag("localComposer");
        composer.setText(conversation.optString("draft")); composer.setSelection(composer.length());
        modelButton = chatComposer.model; modelButton.setTag("localModel");
        toolsButton = chatStyle.lineButton("search", tr("联网工具", "Web tools"), this::configureTools);
        toolsButton.setTag("localTools"); chatComposer.addTool(toolsButton);
        attachButton = chatStyle.lineButton("plus", tr("添加附件", "Add attachments"), this::pickImage);
        attachButton.setTag("localAttach"); chatComposer.addTool(attachButton);
        imageStrip = new android.widget.HorizontalScrollView(this);
        imageStrip.setHorizontalScrollBarEnabled(false); imageStrip.setTag("localImageStrip");
        imageTray = column(); imageTray.setOrientation(LinearLayout.HORIZONTAL); imageTray.setTag("localImageTray");
        imageStrip.addView(imageTray); bar.addView(imageStrip, 0, new LinearLayout.LayoutParams(-1, -2));
        renderImages();
        send = chatComposer.send; send.setTag("localSend");
        stop = chatComposer.stop; stop.setTag("localStop");
        composer.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
            public void onTextChanged(CharSequence value, int start, int before, int count) {
                updateControls();
            }
            public void afterTextChanged(Editable value) { persistDraft(); }
        });
        updateControls(); viewHandler.post(() -> scroll.scrollTo(0, content.getBottom()));
    }

    private LocalChatConfig.Route selectedRoute() throws Exception {
        JSONObject conversation = store.conversation(conversationId);
        if (conversation == null) return null;
        for (LocalChatConfig.Route route : LocalChatConfig.routes(store.config())) if (route.id.equals(conversation.optString("routeId"))) return route;
        return null;
    }

    private void updateControls() {
        if (conversationId == null || send == null || composer == null || !store.hasHistory(conversationId)) return;
        try {
            composer.setEnabled(!sendPending);
            LocalChatConfig.Route route = selectedRoute();
            boolean webTools = store.conversation(conversationId).optBoolean("webTools");
            boolean idle = runningId == null && !sendPending;
            toolsButton.setEnabled(idle); toolsButton.setAlpha(idle ? 1 : .45f);
            toolsButton.setContentDescription(tr("联网工具：", "Web tools: ") + (webTools ? tr("已开启", "On") : tr("已关闭", "Off")));
            toolsButton.setImageDrawable(new LineIcon("search", webTools ? accent : ink));
            boolean attachable = idle && !loadingImages;
            attachButton.setEnabled(attachable); attachButton.setAlpha(attachable ? 1f : .45f);
            String thinking = LocalChatThinking.effective(route, store.conversation(conversationId).optString("thinking", "auto"));
            chatComposer.model(route == null ? tr("选择模型", "Select model") : route.displayName(), LocalChatThinking.label(thinking, chinese), idle);
            chatComposer.editing(editingMessageIndex >= 0, idle);
            send.setEnabled(runningId == null && !sendPending && !store.busy() && route != null && !loadingImages
                && (!composer.getText().toString().trim().isEmpty() || !selectedImages.isEmpty() || !selectedDocuments.isEmpty()));
            stop.setVisibility(conversationId.equals(runningId) ? View.VISIBLE : View.GONE);
            send.setVisibility(conversationId.equals(runningId) ? View.GONE : View.VISIBLE);
            if (runningId != null) status.setText(tr("正在回复 · 离开应用将停止请求", "Replying · Leaving the app stops the request"));
            else if (sendPending) status.setText(tr("正在发送…", "Sending…"));
            else if (loadingImages) status.setText(tr("正在读取附件…", "Reading attachments…"));
            else if (editingMessageIndex >= 0) status.setText(tr("正在编辑上一条消息 · 发送后将重新生成后续回复", "Editing previous message · sending regenerates later replies"));
            else status.setText(route == null ? tr("请导入配置或重新选择模型。", "Import configuration or select a model.")
                : storageError.isEmpty() ? tr("就绪", "Ready") : storageError);
        } catch (Exception error) { send.setEnabled(false); failure(error); }
    }

    // Both phone chat modes share the same file, count and image policy.
    private void pickImage() {
        if (conversationId == null) return;
        // The sheet stays reachable while a reply is running so the capability
        // rows remain visible; only the picture tiles are disabled.
        boolean images = runningId == null && !loadingImages && selectedImages.size() + selectedDocuments.size() < ChatAttachments.MAX_COUNT;
        imageConversation = conversationId;
        AttachSheet sheet = new AttachSheet(this);
        LinearLayout panel = sheet.panel();
        sheet.header(panel, "plus", tr("添加内容", "Add"), tr("关闭", "Close"), () -> { if (dialog != null) dialog.dismiss(); });
        sheet.note(panel, ChatAttachments.limits(chinese, false));
        sheet.tiles(panel, java.util.Arrays.asList(
            new AttachSheet.Tile("camera", tr("拍照", "Camera"), "localImageCamera", images, () -> { dialog.dismiss(); openCamera(); }),
            new AttachSheet.Tile("image", tr("照片", "Photos"), "localImageGallery", images, () -> { dialog.dismiss(); openGallery(); }),
            new AttachSheet.Tile("file", tr("文件", "Files"), "localDocumentPicker", images, () -> { dialog.dismiss(); openDocuments(); })));
        boolean webTools = store.conversation(conversationId).optBoolean("webTools");
        boolean configurable = runningId == null;
        LinearLayout group = sheet.group(panel, "");
        sheet.row(group, "search", tr("联网搜索", "Web search"),
            tr("使用 Bing 和百度搜索，并读取公开网页", "Search with Bing and Baidu, and read public pages"),
            webTools ? tr("已开启", "On") : tr("已关闭", "Off"), "localAttachTools", configurable, () -> { dialog.dismiss(); configureTools(); });
        if (!images) sheet.note(panel, selectedImages.size() + selectedDocuments.size() >= ChatAttachments.MAX_COUNT
            ? tr("最多添加 20 个附件。", "Add up to 20 attachments.")
            : tr("回复结束后可继续添加图片。", "Add more images once the reply finishes."));
        showStyledDialog(panel);
    }

    private void openGallery() {
        android.content.Intent picker = new android.content.Intent(android.content.Intent.ACTION_GET_CONTENT);
        picker.setType("image/*"); picker.addCategory(android.content.Intent.CATEGORY_OPENABLE);
        picker.putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE, true);
        try { startActivityForResult(picker, PICK_IMAGE_REQUEST); } catch (Exception error) { failure(error); }
    }

    private void openDocuments() {
        android.content.Intent picker = new android.content.Intent(android.content.Intent.ACTION_GET_CONTENT);
        picker.setType("*/*"); picker.addCategory(android.content.Intent.CATEGORY_OPENABLE);
        picker.putExtra(android.content.Intent.EXTRA_ALLOW_MULTIPLE, true);
        try { startActivityForResult(picker, PICK_DOCUMENT_REQUEST); } catch (Exception error) { failure(error); }
    }

    private void openCamera() {
        try {
            java.io.File directory = new java.io.File(getCacheDir(), "camera");
            if (!directory.exists() && !directory.mkdirs()) throw new java.io.IOException();
            cameraImageFile = java.io.File.createTempFile("photo-", ".jpg", directory);
            cameraImageUri = CameraFileProvider.uri(this, cameraImageFile);
            android.content.Intent camera = new android.content.Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE)
                .putExtra(android.provider.MediaStore.EXTRA_OUTPUT, cameraImageUri)
                .addFlags(android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION | android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(camera, TAKE_PHOTO_REQUEST);
        } catch (Exception error) { clearCameraImage(); failure(error); }
    }

    @Override protected void onActivityResult(int request, int result, android.content.Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_IMAGE_REQUEST && request != TAKE_PHOTO_REQUEST && request != PICK_DOCUMENT_REQUEST) return;
        ArrayList<android.net.Uri> uris = new ArrayList<>();
        if (result == RESULT_OK) {
            if (request == TAKE_PHOTO_REQUEST && cameraImageUri != null) uris.add(cameraImageUri);
            else if (data != null && data.getClipData() != null) {
                for (int index = 0; index < data.getClipData().getItemCount(); index++) uris.add(data.getClipData().getItemAt(index).getUri());
            } else if (data != null && data.getData() != null) uris.add(data.getData());
        }
        if (uris.isEmpty()) { if (request == TAKE_PHOTO_REQUEST) clearCameraImage(); return; }
        if (loadingImages || selectedImages.size() + selectedDocuments.size() + uris.size() > ChatAttachments.MAX_COUNT) {
            status.setText(tr("最多添加 20 个附件。", "Add up to 20 attachments."));
            if (request == TAKE_PHOTO_REQUEST) clearCameraImage(); return;
        }
        String target = imageConversation;
        ArrayList<String> existingImages = new ArrayList<>(selectedImages);
        ArrayList<JSONObject> existingDocuments = new ArrayList<>(selectedDocuments);
        loadingImages = true; updateControls();
        worker.submit(() -> {
            ArrayList<String> encoded = new ArrayList<>();
            ArrayList<JSONObject> documents = new ArrayList<>();
            AttachmentMaintenance.Lease imported = AttachmentMaintenance.protect(this);
            String problem = null;
            try (AttachmentMaintenance.Import scope = imported.captureImports()) {
                for (android.net.Uri uri : uris) {
                    if (request == PICK_DOCUMENT_REQUEST && !String.valueOf(getContentResolver().getType(uri)).startsWith("image/")) documents.add(ChatDocument.read(this, uri, true));
                    else encoded.add(ChatImage.encode(this, uri, ChatImage.PHONE_MAX_SIDE, ChatImage.PHONE_MAX_BYTES));
                }
                existingImages.addAll(encoded); existingDocuments.addAll(documents);
                ChatAttachments.validate(this, existingImages, existingDocuments, false);
                runOnUiThread(() -> { try {
                    if (isFinishing() || isDestroyed() || !java.util.Objects.equals(target, conversationId)) { ChatAttachments.discard(this, encoded, documents); return; }
                    selectedImages.addAll(encoded); selectedDocuments.addAll(documents); imageConversation = target; renderImages(); persistDraft(); updateControls();
                } finally { imported.close(); } });
            } catch (Exception error) {
                ChatAttachments.discard(this, encoded, documents);
                imported.close();
                problem = ErrorDetails.withSummary(tr("无法添加附件。", "Cannot add attachment."), error);
            } finally {
                String failure = problem;
                runOnUiThread(() -> { loadingImages = false; if (request == TAKE_PHOTO_REQUEST) clearCameraImage(); if (!isFinishing() && !isDestroyed()) {
                    updateControls(); if (failure != null && java.util.Objects.equals(target, conversationId)) status.setText(failure);
                } });
            }
        });
    }

    private void clearCameraImage() {
        if (cameraImageFile != null) cameraImageFile.delete();
        cameraImageFile = null; cameraImageUri = null;
    }

    private void renderImages() {
        if (!java.util.Objects.equals(imageConversation, conversationId)) { selectedImages.clear(); selectedDocuments.clear(); }
        composerAttachments.replace(selectedImages, selectedDocuments);
        if (imageTray == null) return;
        imageStrip.setVisibility(selectedImages.isEmpty() && selectedDocuments.isEmpty() ? View.GONE : View.VISIBLE);
        ChatImageTray.fill(this, imageTray, selectedImages, surface, chinese,
            index -> { selectedImages.remove(index); renderImages(); persistDraft(); updateControls(); });
        ChatDocumentTray.append(this, imageTray, selectedDocuments, chinese,
            index -> { selectedDocuments.remove(index); renderImages(); persistDraft(); updateControls(); });
    }

    private void configureTools() {
        if (runningId != null || conversationId == null) return;
        JSONObject conversation = store.conversation(conversationId);
        LinearLayout panel = column(); panel.setPadding(dp(20), dp(18), dp(20), dp(10)); panel.setBackgroundColor(background);
        TextView heading = text(tr("联网功能", "Web access"), 20, ink); heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); panel.addView(heading);
        TextView note = text(tr("使用 Bing 和百度搜索，并读取公开网页", "Search with Bing and Baidu, and read public pages"), 14, muted);
        note.setPadding(0, dp(8), 0, dp(14)); panel.addView(note);
        LinearLayout card = column(); card.setPadding(dp(18), dp(4), dp(18), dp(4)); card.setBackground(chatStyle.rounded(surface));
        SettingsStyle settings = new SettingsStyle(this);
        android.widget.Switch enabled = settings.toggle(card, tr("联网功能", "Web access"), tr("仅当前会话", "This conversation only"),
            "localToolsEnabled", conversation.optBoolean("webTools"), (button, checked) -> {});
        panel.addView(card, new LinearLayout.LayoutParams(-1, -2));
        AlertDialog editor = new CamelliaDialog.Builder(this).setView(panel)
            .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("保存", "Save"), null).create();
        dialog = editor;
        editor.setOnShowListener(ignored -> editor.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                store.configureTools(conversationId, enabled.isChecked(), stored(result -> { if (dialog == editor) { editor.dismiss(); updateControls(); } }));
                updateControls();
            } catch (Exception error) { failure(error); }
        }));
        editor.show();
    }

    private void chooseModel() {
        if (runningId != null || conversationId == null) return;
        try {
            List<LocalChatConfig.Route> routes = LocalChatConfig.routes(store.config());
            if (modelPicker != null) modelPicker.dismiss();
            modelPicker = new ModelPickerPopup(this, chinese, background, surface, ink, muted, accent, routes, selectedRoute(),
                store.conversation(conversationId).optString("thinking", "auto"), new ModelPickerPopup.Listener() {
                    public void onModel(LocalChatConfig.Route route) {
                        JSONObject conversation = store.conversation(conversationId);
                        saveModelPreference(route.id, route.id.equals(conversation.optString("routeId")) ? conversation.optString("thinking", "auto") : "auto");
                    }
                    public void onThinking(String level) { saveModelPreference(store.conversation(conversationId).optString("routeId"), level); }
                    public void onImport() { providerSettings(); }
                });
            modelPicker.show(modelButton);
        } catch (Exception error) { failure(error); }
    }

    private void saveModelPreference(String routeId, String thinking) {
        if (runningId != null || conversationId == null) return;
        JSONObject conversation = store.conversation(conversationId);
        try {
            store.patchConversation(conversationId, new JSONObject().put("routeId", routeId).put("thinking", LocalChatThinking.normalize(thinking)), stored(result -> updateControls()));
            updateControls();
        } catch (Exception error) { failure(error); }
    }

    private void renderMessages() {
        liveMarkdown = null; liveProcess = null;
        ArrayList<View> desired = new ArrayList<>();
        java.util.Set<JSONObject> retained = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
        JSONArray messages = store.conversation(conversationId).optJSONArray("messages");
        content.setGravity(messages.length() == 0 ? Gravity.CENTER_VERTICAL : Gravity.TOP);
        if (messages.length() == 0) {
            desired.add(new ChatEmptyState(this, chatStyle, "brand", tr("今天想做些什么？", "What would you like to do?"),
                tr("写下问题或添加内容，开始这次对话。", "Write a question or add something to start this conversation.")));
        }
        MarkdownView markdown = new MarkdownView(this, ink, muted, surface, accent);
        int latestUser = -1;
        for (int index = messages.length() - 1; index >= 0; index--) {
            JSONObject message = messages.optJSONObject(index);
            if (message != null && message.optString("role").equals("user")) { latestUser = index; break; }
        }
        for (int index = 0; index < messages.length(); index++) {
            JSONObject message = messages.optJSONObject(index); if (message == null) continue;
            boolean user = message.optString("role").equals("user");
            retained.add(message);
            LocalMessage cached = messageBindings.get(message);
            if (cached != null && (!user || cached.editable == (index == latestUser))) {
                if (!user) updateMessage(cached, message);
                desired.add(cached.wrapper); continue;
            }
            if (cached != null && cached.body != null) cached.body.dispose();
            LocalMessage binding = new LocalMessage(); binding.editable = index == latestUser;
            LinearLayout block = chatStyle.messageBlock(user);
            binding.block = block;
            block.setTag("localMessage:" + index);
            if (!user) {
                ExecutionProcessView process = new ExecutionProcessView(this, chatStyle, processState, conversationId + ":" + index);
                process.update(message.optJSONArray("process"), message == runningReply); block.addView(process);
                binding.process = process;
                if (message == runningReply) liveProcess = process;
            }
            if (!user) {
                ScrollView target = scroll;
                binding.waiting = text(tr("等待输出…", "Waiting for output…"), 15, ink); block.addView(binding.waiting);
                binding.body = new StreamingMarkdownView(this, markdown, new MarkdownScrollAnchor(target, () -> scroll == target && conversationId != null));
                block.addView(binding.body);
                if (message == runningReply) binding.body.update(latest, false); else binding.body.history(message.optString("content"));
                binding.notice = text("", 12, muted); block.addView(binding.notice);
                updateMessage(binding, message);
            } else {
                JSONArray images = message.optJSONArray("images");
                if (images != null && images.length() > 0) {
                    LinearLayout pictures = column(); pictures.setTag("localMessageImages:" + index);
                    pictures.setPadding(0, 0, 0, dp(4));
                    ArrayList<String> attached = new ArrayList<>();
                    for (int image = 0; image < images.length(); image++) attached.add(images.optString(image));
                    ChatImageTray.fill(this, pictures, attached, surface, chinese, null);
                    block.addView(pictures);
                }
                JSONArray documents = message.optJSONArray("documents");
                if (documents != null && documents.length() > 0) {
                    LinearLayout files = column(); files.setTag("localMessageDocuments:" + index);
                    ArrayList<JSONObject> attached = new ArrayList<>();
                    for (int file = 0; file < documents.length(); file++) attached.add(documents.optJSONObject(file));
                    ChatDocumentTray.append(this, files, attached, chinese, null); block.addView(files);
                }
                if (!message.optString("content").isEmpty()) {
                    TextView body = text(message.optString("content"), 15, ink); body.setTextIsSelectable(true); chatStyle.messageTypography(body); block.addView(body);
                }
                if (index == latestUser) {
                    int messageIndex = index;
                    View.OnClickListener edit = view -> beginEdit(messageIndex);
                    block.setOnClickListener(edit);
                    for (int child = 0; child < block.getChildCount(); child++) block.getChildAt(child).setOnClickListener(edit);
                    block.setContentDescription(tr("点击编辑上一条消息", "Tap to edit previous message"));
                }
            }
            if (user && !message.optString("notice").isEmpty()) block.addView(text(message.optString("notice"), 12, muted));
            binding.wrapper = chatStyle.messageWithFooter(block, user,
                () -> message == runningReply ? latest : message.optString("content"), message.optLong("at"), chinese);
            messageBindings.put(message, binding); desired.add(binding.wrapper);
        }
        java.util.Iterator<java.util.Map.Entry<JSONObject, LocalMessage>> iterator = messageBindings.entrySet().iterator();
        while (iterator.hasNext()) {
            java.util.Map.Entry<JSONObject, LocalMessage> entry = iterator.next();
            if (retained.contains(entry.getKey())) continue;
            if (entry.getValue().body != null) entry.getValue().body.dispose(); iterator.remove();
        }
        MessageViews.reconcile(messageViews, desired);
    }

    private static final class LocalMessage {
        LinearLayout block, wrapper;
        StreamingMarkdownView body;
        ExecutionProcessView process;
        TextView waiting, notice;
        boolean editable;
    }
    private void updateMessage(LocalMessage binding, JSONObject message) {
        boolean live = message == runningReply;
        String value = live ? latest : message.optString("content");
        binding.process.update(message.optJSONArray("process"), live);
        binding.waiting.setVisibility(live && value.isEmpty() ? View.VISIBLE : View.GONE);
        binding.notice.setText(message.optString("notice")); binding.notice.setVisibility(message.optString("notice").isEmpty() ? View.GONE : View.VISIBLE);
        binding.body.update(value, !live);
        if (live) { liveMarkdown = binding.body; liveProcess = binding.process; }
    }
    private void disposeMessages() {
        for (LocalMessage binding : messageBindings.values()) if (binding.body != null) binding.body.dispose();
        messageBindings.clear(); liveMarkdown = null; liveProcess = null;
    }

    private void releasePageViews() {
        // PageTransitions captures the outgoing hierarchy before detaching it.
        viewHandler.removeCallbacksAndMessages(null); disposeMessages(); locationConsent.cancel();
        if (conversationPopup != null) { conversationPopup.dismiss(); conversationPopup = null; }
        if (modelPicker != null) { modelPicker.dismiss(); modelPicker = null; }
        if (dialog != null) { dialog.dismiss(); dialog = null; }
        messageViews = null; composer = null; chatComposer = null;
        send = null; stop = null; toolsButton = null; attachButton = null; modelButton = null;
        imageTray = null; imageStrip = null;
        root = null; content = null; scroll = null; status = null; storageRetry = null;
    }

    private void beginEdit(int index) {
        if (runningId != null || sendPending || composer == null || conversationId == null) return;
        JSONArray messages = store.conversation(conversationId).optJSONArray("messages");
        JSONObject message = messages == null ? null : messages.optJSONObject(index);
        if (message == null || !message.optString("role").equals("user")) return;
        selectedImages.clear();
        JSONArray images = message.optJSONArray("images");
        if (images != null) for (int image = 0; image < images.length(); image++) selectedImages.add(images.optString(image));
        selectedDocuments.clear();
        JSONArray documents = message.optJSONArray("documents");
        if (documents != null) for (int file = 0; file < documents.length(); file++) selectedDocuments.add(documents.optJSONObject(file));
        imageConversation = conversationId; renderImages();
        editingMessageIndex = index;
        composer.setText(message.optString("content")); composer.setSelection(composer.length()); composer.requestFocus();
        ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).showSoftInput(composer, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
        updateControls();
    }

    private void renderLiveBody() {
        if (liveMarkdown == null || runningId == null || !runningId.equals(conversationId)) return;
        LocalMessage binding = messageBindings.get(runningReply);
        if (binding != null) binding.waiting.setVisibility(latest.isEmpty() ? View.VISIBLE : View.GONE);
        liveMarkdown.update(latest, false);
    }

    private void persistDraft() {
        if (store == null || conversationId == null || composer == null || !store.hasHistory(conversationId)) return;
        try { LocalChatDraft.save(store.conversation(conversationId), composer.getText().toString(), editingMessageIndex, selectedImages, selectedDocuments); store.saveDraft(conversationId, store.conversation(conversationId), false, stored(value -> {})); }
        catch (Exception error) { failure(error); }
    }

    private void cancelEdit() {
        if (runningId != null || sendPending || composer == null) return;
        locationConsent.cancel();
        editingMessageIndex = -1; composer.setText(""); selectedImages.clear(); selectedDocuments.clear(); renderImages(); persistDraft(); updateControls();
    }

    private void sendMessage() {
        if (runningId != null || sendPending || store.busy() || composer == null || loadingImages) return;
        String prompt = composer.getText().toString();
        if (prompt.trim().isEmpty() && selectedImages.isEmpty() && selectedDocuments.isEmpty()) return;
        try {
            LocalChatConfig.Route route = selectedRoute(); if (route == null) { chooseModel(); return; }
            String target = conversationId;
            EditText input = composer;
            locationConsent.request(prompt, route.providerName() + " · " + java.net.URI.create(route.baseUrl).getHost(), context -> {
                try {
                    if (input == composer && prompt.equals(input.getText().toString()) && target.equals(conversationId)
                            && selectedRoute() != null && route.id.equals(selectedRoute().id)) sendMessage(context);
                } catch (Exception error) { failure(error); }
            });
        } catch (Exception error) { failure(error); }
    }

    private void sendMessage(String locationContext) {
        if (runningId != null || sendPending || store.busy() || loadingImages) return;
        String value = composer.getText().toString().trim();
        if (value.isEmpty() && selectedImages.isEmpty() && selectedDocuments.isEmpty()) return;
        try {
            ChatAttachments.validate(this, selectedImages, selectedDocuments, false);
            LocalChatConfig.Route route = selectedRoute(); if (route == null) { chooseModel(); return; }
            JSONObject conversation = store.conversation(conversationId);
            JSONArray messages = conversation.getJSONArray("messages");
            int replaceFrom = editingMessageIndex >= 0 && editingMessageIndex < messages.length() ? editingMessageIndex : messages.length();
            long sentAt = System.currentTimeMillis();
            JSONObject user = new JSONObject().put("role", "user").put("content", value).put("at", sentAt);
            if (!selectedImages.isEmpty()) user.put("images", new JSONArray(selectedImages));
            if (!selectedDocuments.isEmpty()) user.put("documents", new JSONArray(selectedDocuments));
            String target = conversationId;
            boolean useTools = conversation.optBoolean("webTools");
            String newTitle = value.isEmpty() ? tr("附件", "Attachments") : value.substring(0, Math.min(value.length(), 60)).replace('\n', ' ');
            sendPending = true; int ticket = ++generation; updateControls();
            store.startTurn(target, replaceFrom, messages.length(), user, route, conversation.optString("thinking", "auto"), locationContext, newTitle, new LocalChatStore.Callback<>() {
                public void done(LocalChatStore.Turn turn) {
                    sendPending = false;
                    try {
                        if (isDestroyed() || !foreground || ticket != generation || !target.equals(conversationId)) {
                            JSONObject interrupted = new JSONObject().put("role", "assistant").put("content", "").put("at", sentAt)
                                .put("state", "interrupted").put("notice", tr("请求尚未开始，离页后已取消。", "Request cancelled before it started because the page was left."));
                            store.checkpoint(turn.reply, interrupted, true, stored(saved -> {}));
                            JSONObject draft = new JSONObject();
                            java.util.List<String> images = new ArrayList<>();
                            JSONArray attached = user.optJSONArray("images");
                            for (int index = 0; attached != null && index < attached.length(); index++) images.add(attached.getString(index));
                            java.util.List<JSONObject> documents = new ArrayList<>();
                            JSONArray files = user.optJSONArray("documents");
                            for (int index = 0; files != null && index < files.length(); index++) documents.add(files.getJSONObject(index));
                            LocalChatDraft.save(draft, value, replaceFrom, images, documents);
                            store.saveDraft(target, draft, true, stored(saved -> {}));
                            store.flush(stored(saved -> {}));
                            if (!isDestroyed() && target.equals(conversationId) && store.hasHistory(target)) {
                                JSONObject restored = store.conversation(target);
                                restored.getJSONArray("messages").put(turn.reply.position, interrupted);
                                LocalChatDraft.save(restored, value, replaceFrom, images, documents);
                                editingMessageIndex = replaceFrom; renderMessages(); updateControls();
                            }
                            if (closeRequested && !isDestroyed()) { closeRequested = false; finish(); }
                            return;
                        }
                        editingMessageIndex = -1; composer.setText(""); selectedImages.clear(); selectedDocuments.clear(); renderImages();
                        runningId = target; replyHandle = turn.reply;
                        runningReply = store.conversation(target).getJSONArray("messages").getJSONObject(turn.reply.position);
                        latest = ""; lastCheckpoint = System.currentTimeMillis();
                        LocalChatClient active = new LocalChatClient(LocalChatActivity.this); client = active;
                        JSONObject request = turn.request;
                        renderMessages(); updateControls(); viewHandler.post(() -> scroll.scrollTo(0, content.getBottom()));
            worker.submit(() -> {
                String problem = null;
                try {
                    LocalChatClient.Listener listener = new LocalChatClient.Listener() {
                        @Override public void onThinking(String thinking) {
                            handler.post(() -> {
                                if (generation != ticket) return;
                                try {
                                    JSONArray process = new JSONArray();
                                    JSONArray previous = runningReply.optJSONArray("process");
                                    if (previous != null) for (int index = 0; index < previous.length(); index++) {
                                        JSONObject entry = previous.getJSONObject(index);
                                        if (!entry.optString("type").equals("thinking")) process.put(entry);
                                    }
                                    if (!thinking.isEmpty()) process.put(new JSONObject().put("type", "thinking").put("text", thinking));
                                    runningReply.put("process", process);
                                    if (liveProcess != null && runningId.equals(conversationId)) liveProcess.update(process, true);
                                } catch (Exception error) { failure(error); }
                            });
                        }
                        @Override public void onTool(JSONObject entry) {
                            handler.post(() -> {
                                if (generation != ticket) return;
                                try {
                                    JSONArray process = runningReply.optJSONArray("process");
                                    if (process == null) process = new JSONArray();
                                    int position = process.length();
                                    for (int index = 0; index < process.length(); index++) if (process.getJSONObject(index).optString("id").equals(entry.optString("id"))) position = index;
                                    process.put(position, entry); runningReply.put("process", process);
                                    store.checkpoint(replyHandle, runningReply, !entry.optString("status").equals("running"), new LocalChatStore.Callback<>() {
                                        public void done(Void value) {}
                                        public void failed(Exception error) { if (generation == ticket) finishRun(ErrorDetails.withSummary(tr("无法保存工具记录，已停止。", "Could not save tool trace; stopped."), error), "interrupted"); }
                                    });
                                    if (liveProcess != null && runningId.equals(conversationId)) liveProcess.update(process, true);
                                } catch (Exception error) { finishRun(ErrorDetails.withSummary(tr("无法保存工具记录，已停止。", "Could not save tool trace; stopped."), error), "interrupted"); }
                            });
                        }
                        @Override public void onText(String text) {
                        handler.post(() -> {
                            if (generation != ticket) return;
                            latest = text;
                            if (System.currentTimeMillis() - lastCheckpoint > 3000) {
                                try {
                                    runningReply.put("content", latest); lastCheckpoint = System.currentTimeMillis();
                                    store.checkpoint(replyHandle, runningReply, true, new LocalChatStore.Callback<>() {
                                        public void done(Void value) {}
                                        public void failed(Exception error) { if (generation == ticket) finishRun(ErrorDetails.withSummary(tr("无法保存回复，已停止请求。", "Could not save reply; request stopped."), error), "interrupted"); }
                                    });
                                }
                                catch (Exception error) { finishRun(ErrorDetails.withSummary(tr("无法保存回复，已停止请求。", "Could not save reply; request stopped."), error), "interrupted"); return; }
                            }
                            if (liveMarkdown != null && conversationId != null && conversationId.equals(runningId)) renderLiveBody();
                        });
                        }
                    };
                    if (useTools) active.chatWithTools(route, request, listener, new LocalWebTools());
                    else active.chat(route, request, listener);
                } catch (Exception error) {
                    problem = error instanceof java.io.IOException ? ErrorDetails.describe(error)
                        : ErrorDetails.withSummary(tr("API 回复格式不受支持。", "Unsupported API response format."), error);
                }
                String result = problem;
                handler.post(() -> { if (generation == ticket) finishRun(result, result == null ? "complete" : "interrupted"); });
            });
                    } catch (Exception error) { storageFailure(error); }
                }
                public void failed(Exception error) { sendPending = false; closeRequested = false; if (!isDestroyed()) { updateControls(); storageFailure(error); } }
            });
        } catch (Exception error) { sendPending = false; updateControls(); failure(error); }
    }

    private void finishRun(String notice, String state) {
        if (client == null) return;
        LocalChatClient previous = client; client = null; generation++;
        previous.requestCancel();
        new Thread(previous::cancel, "local-chat-cancel").start();
        try {
            JSONArray process = runningReply.optJSONArray("process");
            if (process != null) for (int index = 0; index < process.length(); index++) {
                JSONObject entry = process.getJSONObject(index);
                if (entry.optString("status").equals("running")) entry.put("status", "cancelled");
            }
            runningReply.put("content", latest).put("state", state).put("notice", notice == null ? "" : notice);
            store.checkpoint(replyHandle, runningReply, true, stored(value -> {}));
        } catch (Exception error) { storageFailure(error); }
        String finishedId = runningId; runningId = null; runningReply = null;
        replyHandle = null;
        if (conversationId == null) list();
        else { if (conversationId.equals(finishedId)) renderMessages(); updateControls(); }
        int ticket = generation;
        if (status != null) status.setText(tr("正在保存回复…", "Saving reply…"));
        try {
            store.flush(stored(value -> {
                if (ticket != generation || !finishedId.equals(conversationId)) return;
                storageError = ""; if (storageRetry != null) storageRetry.setVisibility(View.GONE);
                updateControls(); if (notice != null) status.setText(notice);
            }));
        } catch (Exception error) { storageFailure(error); }
    }
}
