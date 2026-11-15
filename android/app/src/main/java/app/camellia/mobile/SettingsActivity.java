package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

public final class SettingsActivity extends Activity {
    private ChatStyle style;
    private SettingsStyle settingsStyle;
    private boolean chinese;
    private String section;
    private LocalChatStore store;
    private PageTransitions pages;
    private LinearLayout content;
    private TextView status;
    private TextView storageStatus;
    private Runnable dismissStatus;
    private AlertDialog dialog;
    private java.util.concurrent.ExecutorService worker;
    private boolean computerBusy;
    private boolean finishingAfterSave;
    private TextView storageRetry;
    private String storageError = "";

    @Override protected void attachBaseContext(Context context) { super.attachBaseContext(MobilePreferences.wrap(context)); }

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved); MobileOrientation.lockPhonePortrait(this); PageTransitions.configureActivity(this);
        style = new ChatStyle(this); chinese = getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        settingsStyle = new SettingsStyle(this);
        section = saved == null ? getIntent().getStringExtra("section") : saved.getString("section");
        if (section == null) section = "providers";
        pages = new PageTransitions(this);
        worker = java.util.concurrent.Executors.newSingleThreadExecutor();
        EmbeddedNetwork.initialize(getApplicationContext());
        getWindow().setStatusBarColor(settingsStyle.background);
        getWindow().setNavigationBarColor(android.graphics.Color.TRANSPARENT);
        if (android.os.Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(false);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        if ((getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK) != android.content.res.Configuration.UI_MODE_NIGHT_YES)
            getWindow().getDecorView().setSystemUiVisibility(getWindow().getDecorView().getSystemUiVisibility()
                | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        loadStore();
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) {
            getWindow().setNavigationBarColor(android.graphics.Color.TRANSPARENT);
            if (android.os.Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(false);
        }
    }

    private void loadStore() {
        shell(tr("正在读取设置…", "Loading settings…"));
        LocalChatStore.open(this, null, new LocalChatStore.Callback<>() {
            public void done(LocalChatStore value) {
                if (isDestroyed()) return;
                store = value;
                try {
                    render();
                    if (value.cleanupError != null) failure(value.cleanupError);
                    if (value.pendingError != null) storageFailure(value.pendingError);
                }
                catch (Exception error) { failure(error); }
            }
            public void failed(Exception error) {
                if (isDestroyed()) return;
                failure(error);
                TextView retry = settingsStyle.secondaryButton(tr("重新读取", "Read again"),
                    "localStorageLoadRetry", SettingsActivity.this::loadStore);
                content.addView(retry);
            }
        });
    }

    @Override protected void onSaveInstanceState(Bundle saved) { super.onSaveInstanceState(saved); saved.putString("section", section); }
    @Override protected void onStop() {
        clearStatus();
        pages.finishTransition();
        if (store != null) try { store.flush(stored(value -> {})); } catch (Exception error) { storageFailure(error); }
        super.onStop();
    }
    @Override protected void onDestroy() { clearStatus(); if (dialog != null) dialog.dismiss(); if (worker != null) worker.shutdownNow(); super.onDestroy(); }
    @Override public void finish() {
        if (store == null || finishingAfterSave) { super.finish(); PageTransitions.closeActivity(this); return; }
        try { store.flush(stored(value -> { finishingAfterSave = true; finish(); })); }
        catch (Exception error) { storageFailure(error); }
    }

    private interface Stored<T> { void run(T value) throws Exception; }
    private <T> LocalChatStore.Callback<T> stored(Stored<T> action) {
        return new LocalChatStore.Callback<>() {
            public void done(T value) {
                if (isDestroyed()) return;
                try { action.run(value); } catch (Exception error) { storageFailure(error); }
            }
            public void failed(Exception error) { if (!isDestroyed()) storageFailure(error); }
        };
    }
    private void storageFailure(Exception error) {
        storageError = ErrorDetails.withSummary(tr("设置尚未保存，请重试。", "Settings have not been saved. Retry."), error);
        clearStatus();
        if (storageStatus != null) { storageStatus.setText(storageError); storageStatus.setVisibility(View.VISIBLE); }
        if (storageRetry != null) storageRetry.setVisibility(View.VISIBLE);
    }
    private void retryStorage() {
        try { store.flush(stored(value -> { storageError = ""; storageRetry.setVisibility(View.GONE); storageStatus.setText(""); storageStatus.setVisibility(View.GONE); })); }
        catch (Exception error) { storageFailure(error); }
    }

    private String tr(String zh, String en) { return chinese ? zh : en; }
    private int dp(int value) { return style.dp(value); }
    private LinearLayout column() { LinearLayout result = new LinearLayout(this); result.setOrientation(LinearLayout.VERTICAL); return result; }
    private TextView text(String value, int size, int color) {
        TextView result = new TextView(this); result.setText(value); result.setTextSize(size); result.setTextColor(color); result.setPadding(0, dp(5), 0, dp(5)); return result;
    }
    private void shell(String title) {
        clearStatus();
        LinearLayout root = column(); root.setBackground(settingsStyle.palette().pageBackground());
        root.setClipChildren(true); root.setClipToPadding(true);
        root.setPadding(dp(16), dp(6), dp(16), 0);
        root.addView(settingsStyle.header(title, tr("返回", "Back"), this::finish));
        FrameLayout viewport = new FrameLayout(this); viewport.setTag("settingsViewport");
        // Keep scrolling text and elevated cards inside the body, below the header and system insets.
        viewport.setClipChildren(true); viewport.setClipToPadding(true);
        ScrollView scroll = ScrollViews.plain(this); scroll.setTag("settingsScroll"); scroll.setVerticalScrollBarEnabled(false);
        scroll.setClipToPadding(false); scroll.setPadding(0, 0, 0, dp(20));
        content = column(); content.setPadding(0, dp(12), 0, dp(16)); scroll.addView(content);
        viewport.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
        root.addView(viewport, new LinearLayout.LayoutParams(-1, 0, 1));
        status = text("", Palette.TEXT_BODY, settingsStyle.ink); status.setTag("settingsStatus");
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        status.setGravity(Gravity.CENTER); status.setPadding(dp(16), dp(12), dp(16), dp(12));
        status.setMaxWidth(dp(560)); status.setElevation(dp(6));
        var bubble = settingsStyle.round(settingsStyle.card, Palette.RADIUS_CAPSULE);
        bubble.setStroke(dp(1), settingsStyle.palette().cardBorder); status.setBackground(bubble);
        status.setVisibility(View.GONE);
        FrameLayout.LayoutParams notice = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        notice.setMargins(dp(8), dp(8), dp(8), dp(12)); viewport.addView(status, notice);
        storageStatus = text(storageError, Palette.TEXT_NOTE, settingsStyle.error); storageStatus.setTag("settingsStorageError");
        storageStatus.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        storageStatus.setVisibility(storageError.isEmpty() ? View.GONE : View.VISIBLE); root.addView(storageStatus);
        storageRetry = settingsStyle.secondaryButton(tr("重试保存", "Retry saving"),
            "settingsStorageRetry", this::retryStorage);
        storageRetry.setVisibility(storageError.isEmpty() ? View.GONE : View.VISIBLE); root.addView(storageRetry);
        View retry = storageRetry;
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int left = insets.getSystemWindowInsetLeft(), top = insets.getSystemWindowInsetTop();
            int right = insets.getSystemWindowInsetRight();
            // IME resizing is handled by the window. Reserve actual system/cutout
            // space here, not an assumed phone height or a keyboard-sized footer.
            int bottom = Math.min(insets.getSystemWindowInsetBottom(), insets.getStableInsetBottom());
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets safe = insets.getInsets(android.view.WindowInsets.Type.systemBars()
                    | android.view.WindowInsets.Type.displayCutout());
                left = safe.left; top = safe.top; right = safe.right; bottom = safe.bottom;
            }
            view.setPadding(dp(16) + left, dp(6) + top, dp(16) + right, 0);
            // The viewport reaches the physical bottom. Internal padding lets
            // the final line scroll clear of gestures without an opaque strip.
            scroll.setPadding(0, 0, 0, dp(20) + bottom);
            LinearLayout.LayoutParams retryPlacement = (LinearLayout.LayoutParams) retry.getLayoutParams();
            int margin = dp(20) + bottom;
            if (retryPlacement.bottomMargin != margin) { retryPlacement.bottomMargin = margin; retry.setLayoutParams(retryPlacement); }
            return insets;
        });
        pages.show(root, section, 0); root.requestApplyInsets();
    }
    private void clearStatus() {
        if (status == null) return;
        if (dismissStatus != null) status.removeCallbacks(dismissStatus);
        dismissStatus = null; status.setText(""); status.setVisibility(View.GONE);
    }
    private void showStatus(String message) { showStatus(message, true); }
    private void showStatus(String message, boolean temporary) {
        clearStatus();
        if (status == null || message == null || message.isEmpty() || isFinishing() || isDestroyed()) return;
        status.setText(message); status.setVisibility(View.VISIBLE);
        if (!temporary) return;
        int duration = 4000;
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            var accessibility = getSystemService(android.view.accessibility.AccessibilityManager.class);
            if (accessibility != null) duration = accessibility.getRecommendedTimeoutMillis(duration,
                android.view.accessibility.AccessibilityManager.FLAG_CONTENT_TEXT);
        }
        dismissStatus = this::clearStatus; status.postDelayed(dismissStatus, duration);
    }
    private void failure(Exception error) { showStatus(error.getMessage() == null ? tr("无法保存，请重试。", "Could not save. Try again.") : error.getMessage(), false); }
    private void render() throws Exception {
        if (section.equals("general")) general();
        else if (section.equals("reading")) reading();
        else if (section.equals("notifications")) notifications();
        else if (section.equals("archived")) archived(); else providers();
    }

    private void reading() {
        shell(tr("阅读与显示", "Reading & display"));
        LinearLayout group = settingsStyle.group(content, "");
        preference(group, "chatFontSize", tr("聊天字号", "Chat text size"),
            new String[]{tr("小 · 90%", "Small · 90%"), tr("标准 · 100%", "Standard · 100%"),
                tr("大 · 115%", "Large · 115%"), tr("特大 · 130%", "Extra large · 130%")},
            new String[]{"small", "system", "large", "largest"});
        settingsStyle.toggle(group, tr("代码自动换行", "Wrap code"),
            tr("长代码按屏幕宽度换行，复制时保留原文。", "Fit long code lines to the screen. Copied code stays unchanged."),
            "preference:codeWrap", MobilePreferences.codeWrap(this), (view, checked) -> {
                MobilePreferences.codeWrap(this, checked); reading();
            });
        preference(group, "processMode", tr("执行过程", "Execution process"),
            new String[]{tr("默认折叠", "Collapsed by default"), tr("执行时展开，完成后折叠", "Expand while running; collapse when finished"),
                tr("默认展开", "Expanded by default")}, new String[]{"system", "live", "expanded"});
        settingsStyle.note(content, tr("应用于这台手机的本地与远程聊天，字号随系统字体大小一起缩放。执行过程仍可手动展开或收起。",
            "Applies to local and remote chats on this phone. Text also follows system font scaling. You can still expand or collapse each process."));
        LinearLayout preview = settingsStyle.group(content, tr("预览", "Preview"));
        LinearLayout sample = column(); sample.setPadding(dp(14), dp(8), dp(14), dp(8)); sample.setTag("readingPreview");
        View rendered = new MarkdownView(this, settingsStyle.ink, settingsStyle.secondary, settingsStyle.field, settingsStyle.accent)
            .render(tr("这是聊天内容的字号预览。\n\n```java\nString message = \"Long code lines follow your word wrap setting.\";\n```",
                "Preview of chat text at the selected size.\n\n```java\nString message = \"Long code lines follow your word wrap setting.\";\n```"));
        rendered.findViewWithTag("markdownCodeWrap").setVisibility(View.GONE);
        rendered.findViewWithTag("markdownCodeCopy").setVisibility(View.GONE);
        sample.addView(rendered);
        preview.addView(sample);
    }

    private void notifications() {
        shell(tr("通知控制", "Notifications"));
        LinearLayout group = settingsStyle.group(content, "");
        settingsStyle.toggle(group, tr("会话通知", "Chat notifications"),
            tr("提醒新的回复、审批和执行失败。", "Notify about new replies, approval requests and failures."),
            "preference:chatNotifications", ChatNotifications.enabled(this), (view, checked) -> {
                MobilePreferences.set(this, "chatNotifications", checked ? "enabled" : "disabled");
                if (!checked) ChatNotifications.clear(this);
                if (checked && android.os.Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED)
                    requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 74);
            });
        LinearLayout events = settingsStyle.group(content, tr("提醒内容", "Notify me about"));
        notificationToggle(events, "reply", tr("回复完成", "Reply completed"));
        notificationToggle(events, "approval", tr("等待审批或回答问题", "Approval or answer needed"));
        notificationToggle(events, "error", tr("执行失败", "Execution failed"));
        settingsStyle.toggle(events, tr("查看会话时也提醒", "Also notify while viewing the chat"), "",
            "preference:notifyForeground", MobilePreferences.get(this, "notifyForeground").equals("enabled"),
            (view, checked) -> MobilePreferences.set(this, "notifyForeground", checked ? "enabled" : "disabled"));
        LinearLayout system = settingsStyle.group(content, tr("系统权限", "System permission"));
        settingsStyle.action(system, tr("系统通知设置", "System notification settings"),
            ChatNotifications.allowed(this) ? tr("已允许 · 声音与震动由系统管理", "Allowed · sound and vibration are managed by Android")
                : tr("系统通知未开启，开启后才能收到提醒。", "Notifications are blocked by Android. Enable them to receive alerts."),
            "notificationSystemSettings", false, () -> {
                try { startActivity(new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName())); }
                catch (Exception error) { failure(error); }
            });
        settingsStyle.note(content, tr("远程通知在连接保持期间接收；后台接收需要开启“短暂离开时保持连接”。应用被系统关闭后不接收推送。下载和连接保活通知独立管理。",
            "Remote alerts arrive while connected. Enable “Keep connection while away” to receive them in the background. No push alerts arrive after Android closes the app. Download and connection-service notifications are managed separately."));
    }

    private void notificationToggle(LinearLayout group, String type, String title) {
        settingsStyle.toggle(group, title, "", "preference:notify:" + type, ChatNotifications.categoryEnabled(this, type),
            (view, checked) -> {
                MobilePreferences.set(this, "notify:" + type, checked ? "enabled" : "disabled");
                if (!checked) ChatNotifications.clear(this, type);
            });
    }

    @Override protected void onResume() {
        super.onResume();
        if (store != null && section.equals("notifications")) notifications();
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants);
        if (request == 74 && store != null && section.equals("notifications")) notifications();
    }

    private void general() {
        shell(tr("通用", "General"));
        LinearLayout group = settingsStyle.group(content, "");
        preference(group, "language", tr("语言", "Language"), new String[]{tr("跟随系统", "System"), "简体中文", "English"}, new String[]{"system", "zh-CN", "en"});
        settingsStyle.appearance(group, MobilePreferences.get(this, "theme"), tr("外观", "Appearance"),
            new String[]{tr("跟随系统", "System"), tr("浅色", "Light"), tr("深色", "Dark")}, value -> {
                MobilePreferences.set(this, "theme", value); recreate();
            });
        preference(group, "enterMode", tr("键盘回车", "Enter key"),
            new String[]{tr("回车发送，长按换行", "Enter sends; hold for newline"), tr("回车换行，长按发送", "Enter inserts newline; hold to send"), tr("仅点击发送按钮", "Send button only")},
            new String[]{"send", "newline", "button"});
        settingsStyle.toggle(group, tr("震动效果", "Haptic feedback"), tr("遵循系统触感设置", "Respects system haptic settings"),
            "preference:hapticFeedback", MobileHaptics.enabled(this), (view, checked) ->
                MobilePreferences.set(this, "hapticFeedback", checked ? "enabled" : "disabled"));
        // Only what the three labels cannot say. The labels already name each
        // mode; repeating them here made this the longest text on the page and
        // pushed everything else down. What they cannot say is which keyboards
        // actually have the hold gesture.
        settingsStyle.note(content, tr("回车发送模式会向键盘声明发送键：搜狗等输入法可长按发送键换行，而 Gboard 等没有长按手势的键盘需要改用回车换行并点击发送按钮。", "Enter-sends mode declares a send key. Keyboards such as Sogou insert a newline while it is held; keyboards without a hold gesture, such as Gboard, need newline mode and the send button."));
        settingsStyle.note(content, tr("以上设置仅作用于这台手机。", "These settings apply to this phone only."));
        LinearLayout downloads = settingsStyle.group(content, tr("下载", "Downloads"));
        android.net.Uri directory = DownloadDirectory.selected(this);
        settingsStyle.action(downloads, tr("默认下载目录", "Default download folder"),
            directory == null ? tr("每次询问保存位置", "Ask where to save each time") : DownloadDirectory.label(this),
            "preference:downloadDirectory", false, () -> {
                try { startActivityForResult(DownloadDirectory.picker(this), DownloadDirectory.PICK_REQUEST); }
                catch (Exception error) { showStatus(tr("无法打开文件夹选择器。", "Cannot open the folder picker.")); }
            });
        if (directory != null) settingsStyle.action(downloads, tr("每次选择保存位置", "Choose a location each time"), "",
            "downloadDirectoryClear", false, () -> { DownloadDirectory.clear(this); general(); });
        settingsStyle.note(content, tr("选择并授权一次，后续下载自动保存；同名文件自动编号。", "Authorize a folder once to save future downloads there. Duplicate names receive a number."));
        LinearLayout remote = settingsStyle.group(content, tr("远程控制", "Remote control"));
        settingsStyle.toggle(remote, tr("短暂离开时保持连接", "Keep connection while away"),
            tr("后台最多保持 30 分钟，短暂切换应用后可直接继续。", "Keep the connection for up to 30 minutes in the background so you can return quickly."),
            "preference:remoteKeepAlive", RemoteKeepAliveService.enabled(this), (view, checked) -> {
                MobilePreferences.set(this, "remoteKeepAlive", checked ? "enabled" : "disabled");
                if (!checked) RemoteKeepAliveService.finish(this, false);
                if (checked && RemoteKeepAliveService.eligible(this) && android.os.Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 73);
                }
            });
        // The toggle's own description already says what it does and when it is
        // useful. This is the consequence of turning it on, which the switch
        // cannot show — and it leads with "off by default", which the switch
        // state already says.
        settingsStyle.note(content, tr("保持期间会显示通知，可能增加耗电；到时自动断开，返回应用后重新连接，系统也可能提前结束后台运行。", "A notification is shown while active, which may use more battery. The connection drops at the limit and reconnects when you return; Android may also end background activity earlier."));
    }

    @Override protected void onActivityResult(int request, int result, android.content.Intent data) {
        super.onActivityResult(request, result, data);
        if (request != DownloadDirectory.PICK_REQUEST || result != RESULT_OK || data == null) return;
        worker.execute(() -> {
            try {
                DownloadDirectory.saveSelection(this, data);
                runOnUiThread(() -> { if (!isDestroyed() && section.equals("general")) general(); });
            } catch (Exception error) {
                runOnUiThread(() -> { if (!isDestroyed()) showStatus(tr("无法保存下载目录，请选择可写入的文件夹并允许访问。", "Cannot save this folder. Select a writable folder and allow access.")); });
            }
        });
    }
    private void preference(LinearLayout group, String key, String title, String[] labels, String[] values) {
        int selected = java.util.Arrays.asList(values).indexOf(MobilePreferences.get(this, key));
        final int current = Math.max(0, selected);
        // The choice goes on a second line, not in the narrow right-hand column:
        // these labels are sentences ("Enter sends; hold for newline"), and a
        // 100dp single-line slot truncated them to "Enter sends; h…".
        String icon = key.equals("theme") ? "appearance" : key.equals("language") ? "language" : key.equals("chatFontSize") ? "file" : "settings";
        settingsStyle.preference(group, icon, title, labels[current], "preference:" + key, () -> {
            dialog = new SettingsChoiceDialog(this, title, labels, current, tr("取消", "Cancel"), which -> {
                MobilePreferences.set(this, key, values[which]);
                if (key.equals("chatFontSize") || key.equals("processMode")) reading(); else recreate();
            });
            dialog.show();
        });
    }

    private void providers() throws Exception {
        shell(tr("供应商与 Key", "Providers & keys"));
        LinearLayout setup = settingsStyle.group(content, "");
        settingsStyle.action(setup, tr("添加供应商", "Add provider"), tr("设置 Endpoint、API Key 和模型", "Set an endpoint, API key and models"), "providerAdd", false, () -> editProvider(-1));
        settingsStyle.note(content, tr("供本地聊天使用，配置加密保存在这台手机上。导入或从电脑读取会替换现有 API 配置，聊天记录不受影响。",
            "Used by local chat. Configuration is encrypted on this phone. Importing or reading from a computer replaces the API configuration; chats are kept."));
        JSONArray providers = store.config().optJSONArray("providers");
        if (providers == null || providers.length() == 0) {
            // No card, no chevron, and no group heading above it: this reports a
            // state, and a card with a heading and an arrow reads as a fifth
            // thing to tap. The group's own label said "My providers" and the
            // heading said "No providers yet" — the same fact twice.
            settingsStyle.emptyState(content, tr("暂无供应商", "No providers yet"),
                tr("手动添加、粘贴导入，或从已连接的电脑读取。", "Add one manually, paste an export, or import from a paired computer."),
                tr("添加供应商", "Add provider"), () -> editProvider(-1));
        }
        for (int index = 0; providers != null && index < providers.length(); index++) {
            final int selected = index; JSONObject provider = providers.getJSONObject(index);
            LinearLayout card = settingsStyle.group(content, index == 0 ? tr("我的供应商", "My providers") : "");
            settingsStyle.toggle(card, provider.optString("name", provider.optString("id")), provider.optString("baseUrl"), "providerEnabled:" + index,
                provider.optBoolean("enabled", true), (view, checked) -> {
                try { JSONObject config = copyConfig(); config.getJSONArray("providers").getJSONObject(selected).put("enabled", checked); store.importConfig(config, stored(result -> {})); }
                catch (Exception error) { failure(error); view.setOnCheckedChangeListener(null); view.setChecked(provider.optBoolean("enabled", true)); view.setEnabled(false); }
            });
            settingsStyle.action(card, tr("模型与密钥", "Models & keys"), provider.optString("protocol", "openai") + " · " + provider.getJSONArray("models").length() + tr(" 个模型", " models")
                + " · " + provider.getJSONArray("keys").length() + tr(" 个密钥", " keys"), "providerEdit:" + index, false, () -> editProvider(selected));
            settingsStyle.action(card, tr("移除供应商", "Remove provider"), "", "providerDelete:" + index, true, () -> {
                dialog = new CamelliaDialog.Builder(this).setTitle(tr("移除供应商？", "Remove provider?"))
                    .setMessage(tr("仅删除 API 配置，保留聊天记录。", "Only removes the API configuration. Chats are kept."))
                    .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("移除", "Remove"), (prompt, which) -> {
                        try { JSONObject config = copyConfig(); config.getJSONArray("providers").remove(selected); store.importConfig(config, stored(result -> providers())); } catch (Exception error) { failure(error); }
                    }).show();
            });
        }
        LinearLayout transfer = settingsStyle.group(content, tr("配置迁移", "Configuration transfer"));
        List<JSONObject> computers = pairedComputers();
        String computerName = computers.size() == 1 ? computers.get(0).optString("computerName", "").trim() : "";
        String importDetail;
        if (computers.isEmpty()) importDetail = tr("连接电脑后可读取其 API Key 配置", "Available once a computer is paired; reads its API key configuration");
        else if (computers.size() > 1) importDetail = tr("从已配对的电脑中选择要读取的一台", "Choose one of the paired computers");
        else if (computerName.isEmpty()) importDetail = tr("读取已连接电脑端的 API Key 与模型配置", "Reads API keys and models from the paired computer");
        else importDetail = tr("使用「" + computerName + "」的 API Key 与模型配置", "Uses API keys and models from “" + computerName + "”");
        settingsStyle.action(transfer, tr("从电脑导入", "Import from computer"), importDetail, "providerImportComputer", false, this::importFromComputer);
        settingsStyle.action(transfer, tr("粘贴导入", "Paste import"), tr("兼容电脑端配置，不影响聊天记录", "Compatible with desktop exports; chats are kept"), "providerImport", false, this::importConfig);
        settingsStyle.action(transfer, tr("复制导出", "Copy export"), tr("包含 API Key，仅粘贴到可信设备", "Includes API keys; paste only on trusted devices"), "providerExport", false, this::exportConfig);
    }

    private List<JSONObject> pairedComputers() {
        List<JSONObject> paired = new ArrayList<>();
        try {
            for (JSONObject computer : new ComputerStore(new CredentialStore(this)).all())
                if (!computer.optString("address").isEmpty() && !computer.optString("token").isEmpty()) paired.add(computer);
        } catch (Exception error) { paired.clear(); }
        return paired;
    }

    private String computerLabel(JSONObject computer) {
        String name = computer.optString("computerName", "").trim();
        if (!name.isEmpty()) return name;
        String address = computer.optString("address", "");
        return address.isEmpty() ? tr("我的电脑", "My computer") : address;
    }

    // Several computers can be paired, so the import must let the user pick the
    // source instead of silently reading whichever profile is active.
    private void importFromComputer() {
        List<JSONObject> computers = pairedComputers();
        if (computers.isEmpty()) { showStatus(tr("请先在主界面连接并配对此电脑。", "Connect and pair with the computer in the main screen first.")); return; }
        if (computers.size() == 1) { confirmImport(computers.get(0)); return; }
        String[] labels = new String[computers.size()];
        for (int index = 0; index < computers.size(); index++) labels[index] = computerLabel(computers.get(index));
        dialog = new SettingsChoiceDialog(this, tr("选择电脑", "Choose a computer"), labels, -1, tr("取消", "Cancel"),
            choice -> confirmImport(computers.get(choice)));
        dialog.show();
    }

    // Reading replaces the phone's API configuration, so confirm the source and
    // the overwrite first, in the same sheet style as the other settings prompts.
    private void confirmImport(JSONObject computer) {
        JSONArray configured = store.config().optJSONArray("providers");
        int existing = configured == null ? 0 : configured.length();
        String name = computerLabel(computer);
        String message = existing == 0
            ? tr("将读取「" + name + "」的 API Key 与模型配置，写入这台手机。聊天记录保留。",
                "API keys and models are read from “" + name + "” onto this phone. Chats are kept.")
            : tr("将用「" + name + "」的 API Key 与模型配置替换这台手机上现有的 " + existing + " 个供应商配置。聊天记录保留。",
                "API keys and models from “" + name + "” replace the " + existing + " provider configurations stored on this phone. Chats are kept.");
        dialog = new CamelliaDialog.Builder(this).setTitle(tr("导入 API 配置？", "Import API configuration?"))
            .setMessage(message).setNegativeButton(tr("取消", "Cancel"), null)
            .setPositiveButton(tr("导入", "Import"), (prompt, which) -> readConfigFrom(computer)).show();
    }

    private void readConfigFrom(JSONObject computer) {
        if (computerBusy) return;
        computerBusy = true;
        String address = computer.optString("address"), token = computer.optString("token");
        String name = computerLabel(computer);
        showStatus(tr("正在读取电脑端 API 配置…", "Reading the API configuration from the computer…"), false);
        worker.execute(() -> {
            try {
                JSONObject bundle = new RemoteApi(address).json("/v1/api-keys", token, null);
                JSONObject config = LocalChatConfig.parse(bundle.toString());
                runOnUiThread(() -> {
                    computerBusy = false;
                    if (isFinishing() || isDestroyed()) return;
                    try { store.importConfig(config, stored(result -> { providers(); showStatus(tr("已从「" + name + "」导入 API 配置，聊天记录保留。", "Imported the API configuration from “" + name + "”. Chats are kept.")); })); }
                    catch (Exception error) { failure(error); }
                });
            } catch (Exception error) {
                runOnUiThread(() -> { computerBusy = false; if (!isFinishing() && !isDestroyed()) showStatus(RemoteApi.failureMessage(error, chinese), false); });
            }
        });
    }

    private JSONObject copyConfig() throws Exception {
        JSONObject config = LocalChatRecord.object(store.config());
        if (!config.has("providers")) config.put("providers", new JSONArray());
        config.put("version", 2); if (!config.has("enabled")) config.put("enabled", true); return config;
    }
    private EditText field(LinearLayout form, String label, String tag, String value, boolean secret, boolean multiline) {
        TextView caption = text(label, Palette.TEXT_NOTE, settingsStyle.secondary); caption.setPadding(dp(2), dp(16), dp(2), dp(8)); form.addView(caption);
        EditText field = new EditText(this); field.setTextColor(style.ink); field.setTextSize(Palette.TEXT_INPUT); field.setTag(tag);
        field.setInputType(InputType.TYPE_CLASS_TEXT | (secret ? InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
            | (multiline ? InputType.TYPE_TEXT_FLAG_MULTI_LINE : 0));
        field.setSingleLine(!multiline); field.setMinLines(multiline ? 3 : 1); field.setMaxLines(multiline ? 6 : 1);
        if (secret) field.setTransformationMethod(new MaskedKeyTransformation());
        field.setText(value);
        field.setSaveEnabled(false); field.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); field.setContentDescription(label); form.addView(new SettingsField(field), new LinearLayout.LayoutParams(-1, -2)); return field;
    }
    private void editProvider(int index) {
        try {
            JSONObject original = index < 0 ? new JSONObject() : copyConfig().getJSONArray("providers").getJSONObject(index);
            LinearLayout form = column(); form.setPadding(0, 0, 0, dp(8));
            EditText name = field(form, tr("供应商名称", "Provider name"), "providerName", original.optString("name"), false, false);
            EditText endpoint = field(form, "Endpoint", "providerEndpoint", original.optString("baseUrl", "https://"), false, false);
            form.addView(text(tr("API 协议", "API protocol"), Palette.TEXT_NOTE, style.muted));
            String[] protocols = {"openai", "anthropic", "dual"}, protocolLabels = {"OpenAI", "Anthropic", "Dual"};
            int[] selectedProtocol = {Math.max(0, java.util.Arrays.asList(protocols).indexOf(original.optString("protocol", "openai")))};
            TextView protocol = text(protocolLabels[selectedProtocol[0]] + "  ›", Palette.TEXT_ROW, style.ink); protocol.setTag("providerProtocol");
            protocol.setPadding(dp(16), dp(14), dp(16), dp(14)); protocol.setMinHeight(dp(52));
            protocol.setBackground(new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(settingsStyle.divider),
                settingsStyle.fieldBackground(settingsStyle.fieldBorder), settingsStyle.fieldBackground(settingsStyle.fieldBorder)));
            protocol.setFocusable(true); protocol.setContentDescription(tr("选择 API 协议", "Choose API protocol"));
            protocol.setOnClickListener(view -> new SettingsChoiceDialog(this, tr("API 协议", "API protocol"), protocolLabels, selectedProtocol[0], tr("取消", "Cancel"), which -> {
                selectedProtocol[0] = which; protocol.setText(protocolLabels[which] + "  ›");
            }).show()); form.addView(protocol);
            EditText alternate = field(form, tr("Anthropic Endpoint（可选）", "Anthropic endpoint (optional)"), "providerAlternate", original.optString("anthropicBaseUrl"), false, false);
            JSONArray existingKeys = original.optJSONArray("keys");
            if (existingKeys != null && existingKeys.length() > 0) {
                LinearLayout keyGroup = settingsStyle.group(form, tr("已有密钥", "Existing keys"));
                for (int keyIndex = 0; keyIndex < existingKeys.length(); keyIndex++) {
                    JSONObject entry = existingKeys.getJSONObject(keyIndex);
                    String secret = entry.getString("key");
                    String masked = secret.length() > 8 ? "•••• " + secret.substring(secret.length() - 4) : "••••";
                    settingsStyle.toggle(keyGroup, "Key " + (keyIndex + 1), masked, "providerKeyEnabled:" + keyIndex,
                        entry.optBoolean("enabled", true), (toggle, enabled) -> {
                            try { entry.put("enabled", enabled); } catch (Exception error) { failure(error); }
                        });
                }
                settingsStyle.note(form, tr("关闭后保留密钥，但不参与请求或重试；点击保存后生效。按列表顺序使用已启用密钥，全部关闭时此供应商的模型不可用。", "Disabled keys are kept but skipped for requests and retries. Changes apply on Save. Enabled keys are tried in order; disabling all keys makes this provider’s models unavailable."));
            }
            EditText keys = field(form, tr("API Key（每行一个）", "API keys (one per line)"), "providerKeys", "", true, true);
            keys.setHint(index < 0 ? tr("输入 API Key", "Enter API key") : tr("留空保留已有密钥；填写则替换", "Leave blank to keep keys; enter to replace"));
            StringBuilder modelLines = new StringBuilder(); JSONArray models = original.optJSONArray("models");
            if (models != null) for (int modelIndex = 0; modelIndex < models.length(); modelIndex++) {
                JSONObject model = models.getJSONObject(modelIndex); if (modelLines.length() > 0) modelLines.append('\n');
                modelLines.append(model.getString("id")); if (!model.getString("id").equals(model.getString("upstream"))) modelLines.append('=').append(model.getString("upstream"));
            }
            EditText modelInput = field(form, tr("模型（每行一个 ID，或 别名=上游模型）", "Models (one ID or alias=upstream per line)"), "providerModels", modelLines.toString(), false, true);
            TextView errorLabel = text("", Palette.TEXT_NOTE, settingsStyle.error); errorLabel.setTag("providerError");
            errorLabel.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); form.addView(errorLabel);
            ScrollView scroll = ScrollViews.plain(this); scroll.addView(form);
            dialog = new CamelliaDialog.Builder(this).setTitle(index < 0 ? tr("添加供应商", "Add provider") : tr("编辑供应商", "Edit provider"))
                .setView(scroll).setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("保存", "Save"), null).create();
            dialog.setOnShowListener(shown -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
                try {
                    JSONObject provider = new JSONObject(original.toString());
                    String title = name.getText().toString().trim(); if (title.isEmpty()) throw new IllegalArgumentException(tr("请输入供应商名称", "Enter a provider name"));
                    if (!provider.has("id")) provider.put("id", UUID.randomUUID().toString());
                    provider.put("name", title).put("type", original.optString("type", "custom"))
                        .put("baseUrl", LocalChatConfig.endpoint(endpoint.getText().toString())).put("protocol", protocols[selectedProtocol[0]]);
                    String extra = alternate.getText().toString().trim(); provider.put("anthropicBaseUrl", extra.isEmpty() ? "" : LocalChatConfig.endpoint(extra));
                    String secret = keys.getText().toString().trim();
                    if (!secret.isEmpty()) {
                        JSONArray nextKeys = new JSONArray();
                        for (String key : secret.split("\\r?\\n")) if (!key.trim().isEmpty()) nextKeys.put(new JSONObject().put("id", UUID.randomUUID().toString()).put("key", key.trim()).put("enabled", true));
                        provider.put("keys", nextKeys);
                    }
                    if (!provider.has("keys") || provider.getJSONArray("keys").length() == 0) throw new IllegalArgumentException(tr("请填写 API Key", "Enter an API key"));
                    JSONArray nextModels = new JSONArray();
                    for (String line : modelInput.getText().toString().trim().split("\\r?\\n")) {
                        if (line.trim().isEmpty()) continue;
                        String[] parts = line.trim().split("=", 2); String id = parts[0].trim(), upstream = parts.length == 2 ? parts[1].trim() : id;
                        JSONObject model = new JSONObject();
                        if (models != null) for (int modelIndex = 0; modelIndex < models.length(); modelIndex++)
                            if (models.getJSONObject(modelIndex).optString("id").equals(id)) model = new JSONObject(models.getJSONObject(modelIndex).toString());
                        model.put("id", id).put("upstream", upstream); if (!model.has("protocol")) model.put("protocol", "auto"); nextModels.put(model);
                    }
                    if (nextModels.length() == 0) throw new IllegalArgumentException(tr("至少填写一个模型 ID", "Enter at least one model ID"));
                    provider.put("models", nextModels);
                    JSONObject config = copyConfig();
                    if (index < 0) config.getJSONArray("providers").put(provider); else config.getJSONArray("providers").put(index, provider);
                    LocalChatConfig.routes(config);
                    AlertDialog savingDialog = dialog;
                    savingDialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
                    store.importConfig(config, new LocalChatStore.Callback<>() {
                        public void done(JSONObject value) {
                            if (isDestroyed()) return;
                            try { savingDialog.dismiss(); providers(); } catch (Exception error) { failure(error); }
                        }
                        public void failed(Exception error) {
                            if (isDestroyed()) return;
                            errorLabel.setText(ErrorDetails.describe(error)); savingDialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true); storageFailure(error);
                        }
                    });
                } catch (Exception error) { errorLabel.setText(error.getMessage()); }
            }));
            dialog.setOnDismissListener(closed -> keys.setText(""));
            dialog.show();
        } catch (Exception error) { failure(error); }
    }

    private void importConfig() {
        LinearLayout form = column(); form.setPadding(0, 0, 0, dp(8));
        form.addView(text(tr("粘贴完整的 Camellia v2 配置。导入会替换供应商与密钥，不删除会话。", "Paste a complete Camellia v2 export. Replaces providers and keys, not chats."), Palette.TEXT_BODY, style.muted));
        EditText source = field(form, "JSON", "providerImportText", "", false, true);
        source.setSaveEnabled(false); source.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(LocalChatConfig.MAX_IMPORT + 1)});
        TextView errorLabel = text("", Palette.TEXT_NOTE, settingsStyle.error); errorLabel.setTag("providerImportError");
        errorLabel.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); form.addView(errorLabel);
        ScrollView scroll = ScrollViews.plain(this); scroll.addView(form);
        dialog = new CamelliaDialog.Builder(this).setTitle(tr("粘贴导入", "Paste import")).setView(scroll)
            .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("替换配置", "Replace configuration"), null).create();
        dialog.setOnShowListener(shown -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                JSONObject config = LocalChatConfig.parse(source.getText().toString()); AlertDialog savingDialog = dialog;
                savingDialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
                store.importConfig(config, new LocalChatStore.Callback<>() {
                    public void done(JSONObject value) {
                        if (isDestroyed()) return;
                        try { savingDialog.dismiss(); providers(); showStatus(tr("已导入配置", "Configuration imported")); } catch (Exception error) { failure(error); }
                    }
                    public void failed(Exception error) {
                        if (isDestroyed()) return;
                        errorLabel.setText(ErrorDetails.describe(error)); savingDialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true); storageFailure(error);
                    }
                });
            }
            catch (Exception error) { errorLabel.setText(error.getMessage()); }
        })); dialog.setOnDismissListener(closed -> source.setText(""));
        dialog.show(); dialog.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
    }

    private void exportConfig() {
        dialog = new CamelliaDialog.Builder(this).setTitle(tr("复制包含密钥的配置？", "Copy configuration with API keys?"))
            .setMessage(tr("导出包含明文 API Key。仅粘贴到可信设备，不要发送给他人；剪贴板可能被其他应用读取。", "The export contains raw API keys. Paste only on trusted devices. Other apps may read the clipboard."))
            .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("复制", "Copy"), (prompt, which) -> {
                try {
                    String exported = LocalChatConfig.export(store.config());
                    if (exported.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 400 * 1024)
                        throw new IllegalArgumentException(tr("配置过大，无法安全复制到系统剪贴板。请减少配置后重试。", "Configuration is too large for the system clipboard. Reduce it and retry."));
                    ClipData clip = ClipData.newPlainText("Camellia API configuration", exported);
                    android.os.PersistableBundle extras = new android.os.PersistableBundle(); extras.putBoolean("android.content.extra.IS_SENSITIVE", true); clip.getDescription().setExtras(extras);
                    ((ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(clip);
                    showStatus(tr("已复制配置（含密钥），请妥善保管。", "Configuration copied (includes keys). Keep it private."));
                } catch (Exception error) { failure(error); }
            }).show();
    }

    private void archived() throws Exception {
        shell(tr("已归档", "Archived"));
        settingsStyle.note(content, tr("归档会保留聊天记录，恢复后可继续对话。远程归档由电脑端管理。", "Archived chats keep their history and can be restored. Remote archives are managed on the computer."));
        int count = 0;
        for (int index = 0; index < store.conversations().length(); index++) {
            JSONObject conversation = store.conversations().getJSONObject(index); if (!conversation.optBoolean("archived")) continue;
            count++; String id = conversation.getString("id"), title = conversation.optString("title");
            LinearLayout card = settingsStyle.group(content, "");
            settingsStyle.info(card, title.isEmpty() ? tr("新会话", "New chat") : title, tr("本地会话 · 已归档", "Local chat · Archived"));
            settingsStyle.action(card, tr("恢复会话", "Restore chat"), "", "archiveRestore:" + id, false, () -> {
                try { store.archiveConversation(id, false, stored(result -> archived())); } catch (Exception error) { failure(error); }
            });
            settingsStyle.action(card, tr("永久删除", "Delete permanently"), "", "archiveDelete:" + id, true, () -> {
                dialog = new CamelliaDialog.Builder(this).setTitle(tr("永久删除此会话？", "Permanently delete this chat?"))
                    .setMessage(tr("聊天记录将被删除，无法恢复。", "The chat history will be deleted. This cannot be undone."))
                    .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("删除", "Delete"), (prompt, which) -> {
                        store.deleteConversations(java.util.Set.of(id), stored(result -> archived()));
                    }).show();
            });
        }
        if (count == 0) settingsStyle.emptyState(content, tr("暂无已归档会话", "No archived chats"),
            tr("在本地聊天列表长按会话，即可将它归档到这里。", "Long-press a chat in the local list to archive it here."), "", null);
    }
}
