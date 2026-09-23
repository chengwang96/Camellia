package app.camellia.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
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
    private AlertDialog dialog;

    @Override protected void attachBaseContext(Context context) { super.attachBaseContext(MobilePreferences.wrap(context)); }

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved); PageTransitions.configureActivity(this);
        style = new ChatStyle(this); chinese = getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        settingsStyle = new SettingsStyle(this);
        section = saved == null ? getIntent().getStringExtra("section") : saved.getString("section");
        if (section == null) section = "providers";
        pages = new PageTransitions(this);
        getWindow().setStatusBarColor(settingsStyle.background); getWindow().setNavigationBarColor(settingsStyle.background);
        if ((getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK) != android.content.res.Configuration.UI_MODE_NIGHT_YES)
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        try { store = new LocalChatStore(this); render(); }
        catch (Exception error) { shell(tr("设置", "Settings")); failure(error); }
    }

    @Override protected void onSaveInstanceState(Bundle saved) { super.onSaveInstanceState(saved); saved.putString("section", section); }
    @Override protected void onStop() { pages.finishTransition(); super.onStop(); }
    @Override protected void onDestroy() { if (dialog != null) dialog.dismiss(); super.onDestroy(); }
    @Override public void finish() { super.finish(); PageTransitions.closeActivity(this); }

    private String tr(String zh, String en) { return chinese ? zh : en; }
    private int dp(int value) { return style.dp(value); }
    private LinearLayout column() { LinearLayout result = new LinearLayout(this); result.setOrientation(LinearLayout.VERTICAL); return result; }
    private TextView text(String value, int size, int color) {
        TextView result = new TextView(this); result.setText(value); result.setTextSize(size); result.setTextColor(color); result.setPadding(0, dp(5), 0, dp(5)); return result;
    }
    private void shell(String title) {
        LinearLayout root = column(); root.setBackgroundColor(settingsStyle.background);
        root.setClipChildren(false); root.setClipToPadding(false);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(dp(20) + insets.getSystemWindowInsetLeft(), dp(12) + insets.getSystemWindowInsetTop(), dp(20) + insets.getSystemWindowInsetRight(), dp(20) + insets.getSystemWindowInsetBottom()); return insets;
        });
        root.addView(settingsStyle.header(title, tr("返回", "Back"), this::finish));
        ScrollView scroll = new ScrollView(this); scroll.setVerticalScrollBarEnabled(false);
        content = column(); content.setPadding(0, dp(12), 0, dp(16)); scroll.addView(content); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        status = text("", 13, style.muted); status.setTag("settingsStatus"); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); root.addView(status);
        pages.show(root, section, 0); root.requestApplyInsets();
    }
    private void failure(Exception error) { status.setText(error.getMessage() == null ? tr("无法保存，请重试。", "Could not save. Try again.") : error.getMessage()); }
    private void render() throws Exception {
        if (section.equals("general")) general(); else if (section.equals("archived")) archived(); else providers();
    }

    private void general() {
        shell(tr("通用", "General"));
        LinearLayout group = settingsStyle.group(content, "");
        preference(group, "language", tr("语言", "Language"), new String[]{tr("跟随系统", "System"), "简体中文", "English"}, new String[]{"system", "zh-CN", "en"});
        preference(group, "theme", tr("外观", "Appearance"), new String[]{tr("跟随系统", "System"), tr("浅色", "Light"), tr("深色", "Dark")}, new String[]{"system", "light", "dark"});
        preference(group, "enterMode", tr("键盘回车", "Enter key"),
            new String[]{tr("回车发送，长按换行", "Enter sends; hold for newline"), tr("回车换行，长按发送", "Enter inserts newline; hold to send"), tr("仅点击发送按钮", "Send button only")},
            new String[]{"send", "newline", "button"});
        settingsStyle.note(content, tr("仅点击发送按钮模式下，回车始终换行。长按需要键盘提供按键事件；部分软键盘不支持，可切换为回车换行并点击发送按钮。", "In button-only mode, Enter always inserts a newline. Holding Enter requires key events from your keyboard; some software keyboards do not support this. Use newline mode and the send button instead."));
        settingsStyle.note(content, tr("应用于这台手机上的所有页面，不影响电脑设置。", "Applies throughout this phone. Desktop preferences are unchanged."));
        LinearLayout remote = settingsStyle.group(content, tr("远程控制", "Remote control"));
        settingsStyle.toggle(remote, tr("短暂离开时保持连接", "Keep connection while away"),
            tr("后台最多保持 5 分钟，短暂切换应用后可直接继续。", "Keep the connection for up to 5 minutes in the background so you can return quickly."),
            "preference:remoteKeepAlive", RemoteKeepAliveService.enabled(this), (view, checked) -> {
                MobilePreferences.set(this, "remoteKeepAlive", checked ? "enabled" : "disabled");
                if (!checked) RemoteKeepAliveService.finish(this, false);
                if (checked && RemoteKeepAliveService.eligible(this) && android.os.Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 73);
                }
            });
        settingsStyle.note(content, tr("默认关闭。仅已配对远程电脑时生效；未添加电脑不会启动后台服务。到时自动断开，返回应用后重新连接。保持期间会显示通知，可能增加耗电；系统仍可能提前结束后台运行。", "Off by default. Only takes effect with a paired remote computer; no background service runs without one. Disconnects automatically at the limit and reconnects when you return. A notification is shown while active. May use more battery; Android may end background activity earlier."));
    }
    private void preference(LinearLayout group, String key, String title, String[] labels, String[] values) {
        int selected = java.util.Arrays.asList(values).indexOf(MobilePreferences.get(this, key));
        final int current = Math.max(0, selected);
        settingsStyle.row(group, key.equals("theme") ? "appearance" : key.equals("enterMode") ? "settings" : "language", title, labels[current], "preference:" + key, () -> {
            dialog = new SettingsChoiceDialog(this, title, labels, current, tr("取消", "Cancel"), which -> {
                MobilePreferences.set(this, key, values[which]); recreate();
            });
            dialog.show();
        });
    }

    private void providers() throws Exception {
        shell(tr("供应商与 Key", "Providers & keys"));
        LinearLayout setup = settingsStyle.group(content, "");
        settingsStyle.action(setup, tr("添加供应商", "Add provider"), tr("设置 Endpoint、API Key 和模型", "Set an endpoint, API key and models"), "providerAdd", false, () -> editProvider(-1));
        settingsStyle.note(content, tr("供本地聊天使用，配置加密保存在这台手机上。", "Used by local chat. Configuration is encrypted on this phone."));
        JSONArray providers = store.config().optJSONArray("providers");
        if (providers == null || providers.length() == 0) {
            LinearLayout empty = settingsStyle.group(content, tr("我的供应商", "My providers"));
            settingsStyle.info(empty, tr("暂无供应商", "No providers yet"), tr("手动添加，或粘贴电脑 / 手机导出的配置。", "Add one manually, or paste an export from desktop or mobile."));
        }
        for (int index = 0; providers != null && index < providers.length(); index++) {
            final int selected = index; JSONObject provider = providers.getJSONObject(index);
            LinearLayout card = settingsStyle.group(content, index == 0 ? tr("我的供应商", "My providers") : "");
            settingsStyle.toggle(card, provider.optString("name", provider.optString("id")), provider.optString("baseUrl"), "providerEnabled:" + index,
                provider.optBoolean("enabled", true), (view, checked) -> {
                try { JSONObject config = copyConfig(); config.getJSONArray("providers").getJSONObject(selected).put("enabled", checked); store.importConfig(config); provider.put("enabled", checked); }
                catch (Exception error) { failure(error); view.setOnCheckedChangeListener(null); view.setChecked(provider.optBoolean("enabled", true)); view.setEnabled(false); }
            });
            settingsStyle.action(card, tr("模型与密钥", "Models & keys"), provider.optString("protocol", "openai") + " · " + provider.getJSONArray("models").length() + tr(" 个模型", " models")
                + " · " + provider.getJSONArray("keys").length() + tr(" 个密钥", " keys"), "providerEdit:" + index, false, () -> editProvider(selected));
            settingsStyle.action(card, tr("移除供应商", "Remove provider"), "", "providerDelete:" + index, true, () -> {
                dialog = new CamelliaDialog.Builder(this).setTitle(tr("移除供应商？", "Remove provider?"))
                    .setMessage(tr("仅删除 API 配置，保留聊天记录。", "Only removes the API configuration. Chats are kept."))
                    .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("移除", "Remove"), (prompt, which) -> {
                        try { JSONObject config = copyConfig(); config.getJSONArray("providers").remove(selected); store.importConfig(config); providers(); } catch (Exception error) { failure(error); }
                    }).show();
            });
        }
        LinearLayout transfer = settingsStyle.group(content, tr("配置迁移", "Configuration transfer"));
        settingsStyle.action(transfer, tr("粘贴导入", "Paste import"), tr("兼容电脑端配置，不影响聊天记录", "Compatible with desktop exports; chats are kept"), "providerImport", false, this::importConfig);
        settingsStyle.action(transfer, tr("复制导出", "Copy export"), tr("包含 API Key，仅粘贴到可信设备", "Includes API keys; paste only on trusted devices"), "providerExport", false, this::exportConfig);
    }

    private JSONObject copyConfig() throws Exception {
        JSONObject config = new JSONObject(store.config().toString());
        if (!config.has("providers")) config.put("providers", new JSONArray());
        config.put("version", 2); if (!config.has("enabled")) config.put("enabled", true); return config;
    }
    private EditText field(LinearLayout form, String label, String tag, String value, boolean secret, boolean multiline) {
        TextView caption = text(label, 13, settingsStyle.secondary); caption.setPadding(dp(2), dp(16), dp(2), dp(8)); form.addView(caption);
        EditText field = new EditText(this); field.setTextColor(style.ink); field.setTextSize(15); field.setTag(tag);
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
            form.addView(text(tr("API 协议", "API protocol"), 13, style.muted));
            String[] protocols = {"openai", "anthropic", "dual"}, protocolLabels = {"OpenAI", "Anthropic", "Dual"};
            int[] selectedProtocol = {Math.max(0, java.util.Arrays.asList(protocols).indexOf(original.optString("protocol", "openai")))};
            TextView protocol = text(protocolLabels[selectedProtocol[0]] + "  ›", 16, style.ink); protocol.setTag("providerProtocol");
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
            TextView errorLabel = text("", 13, settingsStyle.error); errorLabel.setTag("providerError");
            errorLabel.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); form.addView(errorLabel);
            ScrollView scroll = new ScrollView(this); scroll.addView(form);
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
                    LocalChatConfig.routes(config); store.importConfig(config); dialog.dismiss(); providers();
                } catch (Exception error) { errorLabel.setText(error.getMessage()); }
            }));
            dialog.setOnDismissListener(closed -> keys.setText(""));
            dialog.show();
        } catch (Exception error) { failure(error); }
    }

    private void importConfig() {
        LinearLayout form = column(); form.setPadding(0, 0, 0, dp(8));
        form.addView(text(tr("粘贴完整的 Camellia v2 配置。导入会替换供应商与密钥，不删除会话。", "Paste a complete Camellia v2 export. Replaces providers and keys, not chats."), 14, style.muted));
        EditText source = field(form, "JSON", "providerImportText", "", false, true);
        source.setSaveEnabled(false); source.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(LocalChatConfig.MAX_IMPORT + 1)});
        TextView errorLabel = text("", 13, settingsStyle.error); errorLabel.setTag("providerImportError");
        errorLabel.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); form.addView(errorLabel);
        ScrollView scroll = new ScrollView(this); scroll.addView(form);
        dialog = new CamelliaDialog.Builder(this).setTitle(tr("粘贴导入", "Paste import")).setView(scroll)
            .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("替换配置", "Replace configuration"), null).create();
        dialog.setOnShowListener(shown -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try { JSONObject config = LocalChatConfig.parse(source.getText().toString()); store.importConfig(config); dialog.dismiss(); providers(); status.setText(tr("已导入配置", "Configuration imported")); }
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
                    status.setText(tr("已复制配置（含密钥），请妥善保管。", "Configuration copied (includes keys). Keep it private."));
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
                try { store.archiveConversation(id, false); archived(); } catch (Exception error) { failure(error); }
            });
            settingsStyle.action(card, tr("永久删除", "Delete permanently"), "", "archiveDelete:" + id, true, () -> {
                dialog = new CamelliaDialog.Builder(this).setTitle(tr("永久删除此会话？", "Permanently delete this chat?"))
                    .setMessage(tr("聊天记录将被删除，无法恢复。", "The chat history will be deleted. This cannot be undone."))
                    .setNegativeButton(tr("取消", "Cancel"), null).setPositiveButton(tr("删除", "Delete"), (prompt, which) -> {
                        try { store.deleteConversation(id); archived(); } catch (Exception error) { failure(error); }
                    }).show();
            });
        }
        if (count == 0) settingsStyle.info(settingsStyle.group(content, ""), tr("暂无已归档会话", "No archived chats"),
            tr("在本地聊天列表长按会话，即可将它归档到这里。", "Long-press a chat in the local list to archive it here."));
    }
}
