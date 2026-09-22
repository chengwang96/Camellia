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
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class LocalChatActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final HashSet<String> collapsed = new HashSet<>();
    private LocalChatStore store;
    private LocalChatClient client;
    private boolean chinese;
    private int background, surface, ink, muted, accent, generation;
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
    private ChatStyle chatStyle;
    private LinearLayout modelButton;
    private TextView modelName, thinkingName;
    private ModelPickerPopup modelPicker;
    private TextView status, liveText;
    private AlertDialog dialog;
    private boolean reloadSettings;
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
            try { store = new LocalChatStore(this); if (conversationId == null) list(); else detail(); }
            catch (Exception error) { failure(error); }
        }
    }

    private void providerSettings() {
        if (runningId != null) { status.setText(tr("请先停止回复，再更换 API 配置。", "Stop the reply before replacing API configuration.")); return; }
        persistDraft(); reloadSettings = true;
        startActivity(new android.content.Intent(this, SettingsActivity.class).putExtra("section", "providers")); PageTransitions.openActivity(this);
    }

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        PageTransitions.configureActivity(this);
        chinese = getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        chatStyle = new ChatStyle(this);
        background = chatStyle.background; surface = chatStyle.surface; ink = chatStyle.ink; muted = chatStyle.muted; accent = chatStyle.accent;
        getWindow().setStatusBarColor(background); getWindow().setNavigationBarColor(background);
        if (!dark) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        try {
            store = new LocalChatStore(this);
            boolean recovered = false;
            for (int index = 0; index < store.conversations().length(); index++) {
                JSONArray messages = store.conversations().getJSONObject(index).getJSONArray("messages");
                for (int row = 0; row < messages.length(); row++) {
                    JSONObject message = messages.getJSONObject(row);
                    if (message.optString("state").equals("running")) {
                        message.put("state", "interrupted").put("notice", tr("上次回复已中断，未自动重发。", "Previous reply interrupted; not automatically resent."));
                        recovered = true;
                    }
                }
            }
            if (recovered) store.save();
            if (saved != null) { conversationId = saved.getString("conversationId"); query = saved.getString("query", ""); }
            if (conversationId != null && store.conversation(conversationId) != null) detail(); else list();
        } catch (Exception error) {
            shell(tr("本机聊天不可用", "Local chat unavailable"));
            content.addView(text(tr("无法读取或解密本机数据。数据未被覆盖，请重启应用后重试。", "Could not read or decrypt local data. Nothing was overwritten; restart the app and retry."), 15, ink));
        }
    }

    @Override protected void onSaveInstanceState(Bundle saved) {
        super.onSaveInstanceState(saved);
        saved.putString("conversationId", conversationId); saved.putString("query", query);
    }

    @Override protected void onStop() {
        locationConsent.cancel();
        if (pages != null) pages.finishTransition();
        if (modelPicker != null) modelPicker.dismiss();
        if (client != null) finishRun(tr("已暂停：离开应用后不继续请求；不会自动重发。", "Paused on leaving the app; not automatically resent."), "interrupted");
        persistDraft();
        super.onStop();
    }

    @Override protected void onDestroy() {
        if (modelPicker != null) modelPicker.dismiss();
        if (dialog != null) dialog.dismiss();
        handler.removeCallbacksAndMessages(null); worker.shutdownNow();
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        if (conversationId != null) { persistDraft(); conversationId = null; list(); }
        else super.onBackPressed();
    }

    @Override public void finish() {
        super.finish();
        PageTransitions.closeActivity(this);
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
    private EditText input(String hint, String tag) {
        EditText input = tag.equals("localComposer") ? new ComposerInput(this) : new EditText(this); input.setHint(hint); input.setTag(tag); input.setTextSize(15);
        input.setTextColor(ink); input.setHintTextColor(muted); input.setBackground(chatStyle.capsule(surface));
        input.setContentDescription(hint); input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        input.setPadding(dp(14), dp(12), dp(14), dp(12)); input.setMinHeight(dp(48)); return input;
    }
    private void shell(String title) {
        locationConsent.cancel();
        if (modelPicker != null) modelPicker.dismiss();
        composer = null; liveText = null;
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
        if (conversationId != null && store != null && store.conversation(conversationId) != null) {
            modelButton = new LinearLayout(this); modelButton.setGravity(Gravity.CENTER_VERTICAL); modelButton.setTag("localModel");
            modelButton.setPadding(dp(12), 0, dp(10), 0); modelButton.setMinimumHeight(dp(48));
            GradientDrawable pill = chatStyle.capsule(Color.red(background) < 128 ? surface : background);
            modelButton.setBackground(new RippleDrawable(ColorStateList.valueOf(0x184176e6), pill, chatStyle.capsule(Color.WHITE)));
            modelButton.setElevation(dp(2));
            if (android.os.Build.VERSION.SDK_INT >= 28) {
                modelButton.setOutlineAmbientShadowColor(0x18000000); modelButton.setOutlineSpotShadowColor(0x20000000);
            }
            modelButton.setFocusable(true); modelButton.setOnClickListener(view -> chooseModel());
            modelName = text("", 16, ink); modelName.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
            modelName.setSingleLine(true); modelName.setEllipsize(android.text.TextUtils.TruncateAt.END);
            modelButton.addView(modelName, new LinearLayout.LayoutParams(-2, -2, 1));
            thinkingName = text("", 12, muted); thinkingName.setSingleLine(true); thinkingName.setEllipsize(android.text.TextUtils.TruncateAt.END);
            thinkingName.setPadding(dp(6), 0, dp(4), 0); modelButton.addView(thinkingName);
            ImageView chevron = new ImageView(this); chevron.setImageDrawable(new LineIcon("down", muted));
            modelButton.addView(chevron, new LinearLayout.LayoutParams(dp(14), dp(14)));
            android.widget.FrameLayout modelSlot = new android.widget.FrameLayout(this);
            modelSlot.setClipChildren(false); modelSlot.setClipToPadding(false);
            modelSlot.addView(modelButton, new android.widget.FrameLayout.LayoutParams(-2, dp(48), Gravity.START | Gravity.CENTER_VERTICAL));
            LinearLayout.LayoutParams modelParams = new LinearLayout.LayoutParams(0, dp(48), 1); modelParams.setMargins(dp(8), 0, dp(8), 0);
            header.addView(modelSlot, modelParams);
            ImageButton menu = chatStyle.lineButton("more", tr("管理会话", "Manage chat"), () -> conversationMenu(store.conversation(conversationId)));
            menu.setTag("localChatMenu");
            header.addView(menu, new LinearLayout.LayoutParams(dp(48), dp(48))); root.addView(header);
        } else {
        LinearLayout titles = column(); titles.setPadding(dp(10), 0, 0, 0);
        TextView heading = text(title, 19, ink); heading.setSingleLine(true); heading.setEllipsize(android.text.TextUtils.TruncateAt.END);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); titles.addView(heading);
        LinearLayout device = new LinearLayout(this); device.setGravity(Gravity.CENTER_VERTICAL);
        ImageView phone = new ImageView(this); phone.setImageDrawable(new LineIcon("phone", muted));
        device.addView(phone, new LinearLayout.LayoutParams(dp(14), dp(14)));
        TextView subtitle = text(tr("本机 · 手机直连 API", "On this phone · Direct API"), 12, muted);
        subtitle.setPadding(dp(6), 0, 0, 0); subtitle.setSingleLine(true); subtitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        device.addView(subtitle); titles.addView(device);
        header.addView(titles, new LinearLayout.LayoutParams(0, -2, 1)); root.addView(header);
        }
        scroll = new ScrollView(this); scroll.setFillViewport(true);
        content = column(); content.setPadding(0, 0, 0, dp(16)); scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        status = text("", 11, muted); status.setTag("localStatus"); status.setGravity(Gravity.CENTER);
        status.setMaxLines(1); status.setMinLines(1); status.setEllipsize(android.text.TextUtils.TruncateAt.END);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); root.addView(status, new LinearLayout.LayoutParams(-1, -2));
    }

    private LinearLayout bottomBar(String tag) {
        chatStyle.dockStatus(status);
        LinearLayout bar = new LinearLayout(this); bar.setGravity(Gravity.CENTER_VERTICAL); bar.setTag(tag);
        bar.setClipChildren(false); bar.setClipToPadding(false);
        chatStyle.floatingBar(bar);
        bar.setPadding(dp(6), dp(6), dp(6), dp(6));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, dp(10), 0, dp(12));
        root.addView(bar, root.indexOfChild(status), params); return bar;
    }
    private void failure(Exception error) {
        status.setText(error instanceof IllegalArgumentException || error instanceof java.io.IOException || error instanceof IllegalStateException
            ? error.getMessage() : tr("操作失败，未自动重试。请检查配置或稍后重试。", "Operation failed; not automatically retried. Check configuration or try later."));
    }
    private String title(JSONObject conversation) { return conversation.optString("title").isEmpty() ? tr("新会话", "New conversation") : conversation.optString("title"); }

    private void list() {
        processState.clear();
        conversationId = null; shell(tr("本机聊天", "Local chat"));
        status.setText(tr("本机模式 · 聊天记录仅保存在此设备", "Local mode · Chat history stays on this device"));
        root.setClipChildren(false);
        try { if (LocalChatConfig.routes(store.config()).isEmpty()) content.addView(text(tr("先在「供应商与 Key」填写 API 配置，或粘贴导入。无需配对电脑，聊天记录仅存于本机。", "Add a provider and API key, or paste an export. No computer pairing required; chats stay on this phone."), 14, muted)); }
        catch (Exception error) { failure(error); }
        LinearLayout groups = column(); groups.setTag("localGroups"); content.addView(groups);
        renderGroups(groups);
        LinearLayout bottom = bottomBar("localSearchBar"); bottom.setBackgroundColor(Color.TRANSPARENT); bottom.setElevation(0); bottom.setPadding(0, dp(6), 0, dp(6));
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
    }

    private void renderGroups(LinearLayout groups) {
        groups.removeAllViews();
        groups.addView(chatStyle.workspaceHeader(tr("工作区", "Workspaces"), tr("新建工作区", "New workspace"), "localNewWorkspace", () -> nameDialog(null)));
        JSONArray workspaces = store.workspaces();
        for (int index = 0; index < workspaces.length(); index++) {
            JSONObject workspace = workspaces.optJSONObject(index);
            if (workspace != null) group(groups, workspace.optString("id"), workspace.optString("name"), workspace);
        }
        group(groups, "", tr("独立会话", "Standalone chats"), null);
    }

    private void group(LinearLayout parent, String id, String name, JSONObject workspace) {
        List<JSONObject> entries = new ArrayList<>();
        String term = query.toLowerCase(java.util.Locale.ROOT);
        for (int index = 0; index < store.conversations().length(); index++) {
            JSONObject conversation = store.conversations().optJSONObject(index);
            if (conversation != null && !conversation.optBoolean("archived") && conversation.optString("workspaceId").equals(id)
                && title(conversation).toLowerCase(java.util.Locale.ROOT).contains(term)) entries.add(conversation);
        }
        if (!query.isEmpty() && entries.isEmpty()) return;
        entries.sort(Comparator.comparingLong((JSONObject value) -> value.optLong("updatedAt")).reversed());
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
        if (workspace != null) label.setOnLongClickListener(view -> { workspaceMenu(workspace); return true; });
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
            LinearLayout row = column(); row.setPadding(dp(id.isEmpty() ? 2 : 32), dp(8), dp(8), dp(8));
            TextView nameView = text(title(conversation), 15, selectedId.equals(runningId) ? accent : ink);
            nameView.setMaxLines(2); nameView.setMinHeight(dp(36)); nameView.setGravity(Gravity.CENTER_VERTICAL);
            nameView.setEllipsize(android.text.TextUtils.TruncateAt.END); row.addView(nameView);
            row.setBackground(new RippleDrawable(ColorStateList.valueOf(0x224176e6), shape(background), shape(Color.WHITE)));
            row.setTag("localConversation:" + selectedId); row.setFocusable(true); row.setContentDescription(title(conversation));
            row.setOnClickListener(view -> { conversationId = selectedId; detail(); });
            row.setOnLongClickListener(view -> { conversationMenu(conversation); return true; }); group.addView(row);
        }
        if (entries.isEmpty()) {
            TextView empty = text(tr("暂无会话", "No conversations yet"), 13, muted);
            empty.setPadding(dp(id.isEmpty() ? 2 : 32), dp(8), dp(8), dp(8)); group.addView(empty);
        }
    }

    private void nameDialog(JSONObject workspace) {
        EditText name = input(tr("工作区名称", "Workspace name"), "localWorkspaceName"); name.setSingleLine(true);
        if (workspace != null) name.setText(workspace.optString("name"));
        dialog = new AlertDialog.Builder(this).setTitle(tr("本机工作区", "Local workspace")).setView(name)
            .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("保存", "Save"), null).create();
        dialog.setOnShowListener(event -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            String value = name.getText().toString().trim();
            if (value.isEmpty() || value.length() > 80) { name.setError(tr("请输入 1–80 字名称", "Enter a name of 1–80 characters")); return; }
            try {
                if (workspace == null) store.createWorkspace(value); else { workspace.put("name", value); store.save(); }
                dialog.dismiss(); list();
            } catch (Exception error) { failure(error); }
        })); dialog.show();
    }

    private void workspaceMenu(JSONObject workspace) {
        dialog = new AlertDialog.Builder(this).setTitle(workspace.optString("name"))
            .setItems(new String[] { tr("重命名", "Rename"), tr("移除工作区（保留会话）", "Remove workspace (keep chats)") }, (selected, which) -> {
                if (which == 0) nameDialog(workspace);
                else try { store.deleteWorkspace(workspace.optString("id")); list(); } catch (Exception error) { failure(error); }
            }).show();
    }

    private void conversationMenu(JSONObject conversation) {
        if (conversation.optString("id").equals(runningId)) { status.setText(tr("请先停止此会话的回复。", "Stop this reply first.")); return; }
        dialog = new AlertDialog.Builder(this).setTitle(title(conversation)).setItems(new String[] {tr("重命名", "Rename"), tr("删除会话", "Delete chat"), tr("归档会话", "Archive chat")}, (selected, which) -> {
            if (which == 2) {
                try { store.archiveConversation(conversation.getString("id"), true); list(); } catch (Exception error) { failure(error); }
                return;
            }
            if (which == 0) {
                EditText name = input(tr("会话标题", "Chat title"), "localRename"); name.setText(title(conversation)); name.setSingleLine(true);
                dialog = new AlertDialog.Builder(this).setTitle(tr("重命名", "Rename")).setView(name).setNegativeButton(tr("取消", "Cancel"), null)
                    .setPositiveButton(tr("保存", "Save"), null).create();
                dialog.setOnShowListener(event -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
                    String value = name.getText().toString().trim();
                    if (value.isEmpty() || value.length() > 100) { name.setError(tr("请输入 1–100 字标题", "Enter a title of 1–100 characters")); return; }
                    try { conversation.put("title", value); store.save(); dialog.dismiss(); if (conversationId == null) list(); else detail(); }
                    catch (Exception error) { failure(error); }
                })); dialog.show();
            } else {
                dialog = new AlertDialog.Builder(this).setTitle(tr("删除本机会话？", "Delete this local chat?"))
                    .setMessage(tr("聊天记录将永久删除。", "The chat history will be permanently deleted."))
                    .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("删除", "Delete"), (confirm, action) -> {
                        try { store.deleteConversation(conversation.optString("id")); list(); } catch (Exception error) { failure(error); }
                    }).show();
            }
        }).show();
    }

    private void createConversation(String workspaceId) {
        try {
            List<LocalChatConfig.Route> routes = LocalChatConfig.routes(store.config());
            if (routes.isEmpty()) { providerSettings(); return; }
            conversationId = store.createConversation(workspaceId, routes.get(0).id).getString("id"); detail();
        } catch (Exception error) { failure(error); }
    }

    private void detail() {
        JSONObject conversation = store.conversation(conversationId);
        if (conversation == null) { list(); return; }
        shell(title(conversation));
        scroll.setVerticalScrollBarEnabled(false);
        TextView chatTitle = text(title(conversation), 12, muted); chatTitle.setTag("localChatTitle");
        chatTitle.setSingleLine(true); chatTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        chatTitle.setGravity(Gravity.CENTER); chatTitle.setPadding(0, dp(8), 0, dp(16)); content.addView(chatTitle);
        messageViews = column(); content.addView(messageViews); renderMessages();
        LinearLayout bar = bottomBar("localComposerBar"); bar.setGravity(Gravity.BOTTOM); bar.setPadding(dp(8), dp(6), dp(8), dp(6));
        composer = input(tr("输入消息", "Message"), "localComposer"); composer.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        composer.setVerticalScrollBarEnabled(false);
        composer.setTextSize(16); composer.setMaxLines(4); composer.setText(conversation.optString("draft")); composer.setGravity(Gravity.TOP | Gravity.START);
        composer.setBackgroundColor(Color.TRANSPARENT); composer.setPadding(dp(12), dp(12), dp(8), dp(12));
        composer.setFilters(new android.text.InputFilter[] { new android.text.InputFilter.LengthFilter(100000) });
        bar.addView(composer, new LinearLayout.LayoutParams(0, -2, 1));
        send = chatStyle.composerAction(tr("发送", "Send"), R.drawable.ic_send, this::sendMessage); send.setTag("localSend");
        ((ComposerInput) composer).setSendAction(() -> { if (send.isEnabled() && send.getVisibility() == View.VISIBLE) send.performClick(); });
        bar.addView(send, new LinearLayout.LayoutParams(dp(48), dp(48)));
        stop = chatStyle.composerAction(tr("停止", "Stop"), R.drawable.ic_stop, () -> finishRun(tr("已停止，部分回复已保留。", "Stopped; partial reply kept."), "stopped"));
        stop.setTag("localStop"); bar.addView(stop, new LinearLayout.LayoutParams(dp(48), dp(48)));
        composer.setOnFocusChangeListener((view, focused) -> ((GradientDrawable) bar.getBackground()).setStroke(dp(1), focused ? accent : Color.TRANSPARENT));
        composer.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
            public void onTextChanged(CharSequence value, int start, int before, int count) { updateControls(); }
            public void afterTextChanged(Editable value) {}
        });
        updateControls(); scroll.post(() -> scroll.scrollTo(0, content.getBottom()));
    }

    private LocalChatConfig.Route selectedRoute() throws Exception {
        JSONObject conversation = store.conversation(conversationId);
        if (conversation == null) return null;
        for (LocalChatConfig.Route route : LocalChatConfig.routes(store.config())) if (route.id.equals(conversation.optString("routeId"))) return route;
        return null;
    }

    private void updateControls() {
        if (conversationId == null || send == null) return;
        try {
            LocalChatConfig.Route route = selectedRoute();
            modelName.setText(route == null ? tr("选择模型", "Select model") : ModelLabel.compact(route.displayName()));
            String thinking = LocalChatThinking.effective(route, store.conversation(conversationId).optString("thinking", "auto"));
            thinkingName.setText(LocalChatThinking.label(thinking, chinese));
            modelButton.setContentDescription(tr("切换模型和思考等级：", "Change model and thinking level: ") + (route == null ? modelName.getText() : route.displayName()) + " · " + thinkingName.getText());
            modelButton.setAlpha(runningId == null ? 1f : .5f);
            modelButton.setEnabled(runningId == null); send.setEnabled(runningId == null && route != null && !composer.getText().toString().trim().isEmpty());
            stop.setVisibility(conversationId.equals(runningId) ? View.VISIBLE : View.GONE);
            send.setVisibility(conversationId.equals(runningId) ? View.GONE : View.VISIBLE);
            if (runningId != null) status.setText(tr("正在回复 · 离开应用将停止请求", "Replying · Leaving the app stops the request"));
            else status.setText(route == null ? tr("请导入配置或重新选择模型。", "Import configuration or select a model.") : route.baseUrl + " · " + route.model);
        } catch (Exception error) { send.setEnabled(false); failure(error); }
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
        String previousRoute = conversation.optString("routeId"), previousThinking = conversation.optString("thinking", "auto");
        try {
            conversation.put("routeId", routeId).put("thinking", LocalChatThinking.normalize(thinking)); store.save(); updateControls();
        } catch (Exception error) {
            try { conversation.put("routeId", previousRoute).put("thinking", previousThinking); } catch (Exception ignored) {}
            failure(error);
        }
    }

    private void renderMessages() {
        messageViews.removeAllViews(); liveText = null; liveProcess = null;
        JSONArray messages = store.conversation(conversationId).optJSONArray("messages");
        MarkdownView markdown = new MarkdownView(this, ink, muted, surface, accent);
        for (int index = 0; index < messages.length(); index++) {
            JSONObject message = messages.optJSONObject(index); if (message == null) continue;
            boolean user = message.optString("role").equals("user");
            LinearLayout block = chatStyle.messageBlock(user);
            block.setTag("localMessage:" + index);
            if (!user) {
                ExecutionProcessView process = new ExecutionProcessView(this, chatStyle, processState, conversationId + ":" + index);
                process.update(message.optJSONArray("process"), message == runningReply); block.addView(process);
                if (message == runningReply) liveProcess = process;
            }
            if (message == runningReply) {
                liveText = text(latest.isEmpty() ? tr("等待输出…", "Waiting for output…") : latest, 15, ink); liveText.setTextIsSelectable(true); chatStyle.messageTypography(liveText); block.addView(liveText);
            } else if (user) { TextView body = text(message.optString("content"), 15, ink); body.setTextIsSelectable(true); chatStyle.messageTypography(body); block.addView(body); }
            else block.addView(markdown.render(message.optString("content")));
            if (!message.optString("notice").isEmpty()) block.addView(text(message.optString("notice"), 12, muted));
            messageViews.addView(chatStyle.messageWithFooter(block, user,
                () -> message == runningReply ? latest : message.optString("content"), message.optLong("at"), chinese));
        }
    }

    private void persistDraft() {
        if (store == null || conversationId == null || composer == null) return;
        try { store.conversation(conversationId).put("draft", composer.getText().toString()); store.save(); }
        catch (Exception error) { failure(error); }
    }

    private void sendMessage() {
        if (runningId != null || composer == null) return;
        String prompt = composer.getText().toString();
        if (prompt.trim().isEmpty()) return;
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
        if (runningId != null) return;
        String value = composer.getText().toString().trim(); if (value.isEmpty()) return;
        try {
            LocalChatConfig.Route route = selectedRoute(); if (route == null) { chooseModel(); return; }
            JSONObject conversation = store.conversation(conversationId);
            JSONArray messages = conversation.getJSONArray("messages");
            long sentAt = System.currentTimeMillis();
            JSONObject user = new JSONObject().put("role", "user").put("content", value).put("at", sentAt);
            JSONArray prospective = new JSONArray(messages.toString()); prospective.put(user);
            if (!locationContext.isEmpty()) prospective.put(prospective.length() - 1,
                new JSONObject(user.toString()).put("content", value + locationContext));
            JSONObject request = LocalChatClient.request(route, prospective, conversation.optString("thinking", "auto"));
            String previousTitle = conversation.optString("title");
            JSONObject reply = new JSONObject().put("role", "assistant").put("content", "").put("state", "running").put("at", sentAt);
            messages.put(user).put(reply);
            conversation.put("draft", "").put("updatedAt", System.currentTimeMillis());
            if (previousTitle.isEmpty()) conversation.put("title", value.substring(0, Math.min(value.length(), 60)).replace('\n', ' '));
            try { store.save(); }
            catch (Exception error) {
                messages.remove(messages.length() - 1); messages.remove(messages.length() - 1);
                conversation.put("title", previousTitle).put("draft", value); throw error;
            }
            composer.setText(""); runningId = conversationId; runningReply = reply; latest = ""; lastCheckpoint = System.currentTimeMillis();
            LocalChatClient active = new LocalChatClient(); client = active; int ticket = ++generation;
            renderMessages(); updateControls(); scroll.post(() -> scroll.scrollTo(0, content.getBottom()));
            worker.submit(() -> {
                String problem = null;
                try {
                    active.chat(route, request, new LocalChatClient.Listener() {
                        @Override public void onThinking(String thinking) {
                            handler.post(() -> {
                                if (generation != ticket) return;
                                try {
                                    JSONArray process = new JSONArray();
                                    if (!thinking.isEmpty()) process.put(new JSONObject().put("type", "thinking").put("text", thinking));
                                    runningReply.put("process", process);
                                    if (liveProcess != null && runningId.equals(conversationId)) liveProcess.update(process, true);
                                } catch (Exception error) { failure(error); }
                            });
                        }
                        @Override public void onText(String text) {
                        handler.post(() -> {
                            if (generation != ticket) return;
                            latest = text;
                            if (System.currentTimeMillis() - lastCheckpoint > 3000) {
                                try { runningReply.put("content", latest); store.save(); lastCheckpoint = System.currentTimeMillis(); }
                                catch (Exception error) { finishRun(tr("无法保存回复，已停止请求。", "Could not save reply; request stopped."), "interrupted"); return; }
                            }
                            if (liveText != null && conversationId != null && conversationId.equals(runningId)) {
                                boolean atBottom = scroll.getChildAt(0).getHeight() - scroll.getScrollY() - scroll.getHeight() < dp(100);
                                liveText.setText(text); if (atBottom) scroll.post(() -> scroll.scrollTo(0, content.getBottom()));
                            }
                        });
                        }
                    });
                } catch (Exception error) {
                    problem = error instanceof java.io.IOException ? error.getMessage() : tr("API 回复格式不受支持。", "Unsupported API response format.");
                }
                String result = problem;
                handler.post(() -> { if (generation == ticket) finishRun(result, result == null ? "complete" : "interrupted"); });
            });
        } catch (Exception error) { failure(error); }
    }

    private void finishRun(String notice, String state) {
        if (client == null) return;
        LocalChatClient previous = client; client = null; generation++;
        new Thread(previous::cancel, "local-chat-cancel").start();
        Exception saveError = null;
        try {
            runningReply.put("content", latest).put("state", state).put("notice", notice == null ? "" : notice);
            store.save();
        } catch (Exception error) { saveError = error; }
        String finishedId = runningId; runningId = null; runningReply = null;
        if (conversationId == null) list();
        else { if (conversationId.equals(finishedId)) renderMessages(); updateControls(); }
        if (notice != null) status.setText(notice);
        if (saveError != null) status.setText(tr("回复尚未成功保存，请保持应用打开并重试。", "Reply could not be saved; keep the app open and retry."));
    }
}
