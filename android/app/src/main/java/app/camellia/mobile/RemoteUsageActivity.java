package app.camellia.mobile;

import android.app.Activity;
import android.content.Context;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Gravity;
import android.graphics.Typeface;
import android.content.res.ColorStateList;
import android.graphics.drawable.RippleDrawable;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;

public final class RemoteUsageActivity extends Activity {
    static java.util.function.Function<String, RemoteApi> clientFactory;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final java.util.concurrent.ExecutorService worker = Executors.newSingleThreadExecutor();
    private SettingsStyle style;
    private boolean chinese, loading, cached, detailsExpanded, filtersExpanded;
    private Boolean supported;
    private volatile boolean active;
    private volatile int generation;
    private int polls;
    private String address = "", tab = "quota", range = "7", source = "", accountId = "", model = "", notice = "", noticeTitle = "", detail = "";
    private List<JSONObject> computers = new ArrayList<>();
    private JSONObject computer, data;
    private volatile RemoteApi client;
    private LinearLayout body, selector;
    private TextView computerName, status, quotaTab, usageTab;
    private ImageButton refresh;
    private ScrollView scroll;
    private ChoiceDropdown choiceDropdown;
    private ComputerPickerPopup computerPicker;
    private android.widget.ImageView computerArrow;
    private AccountUsageCache cache;
    private android.icu.text.CompactDecimalFormat countFormat;

    @Override protected void attachBaseContext(Context context) { super.attachBaseContext(MobilePreferences.wrap(context)); }
    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved); MobileOrientation.lockPhonePortrait(this); PageTransitions.configureActivity(this);
        if (saved != null) getIntent().putExtra(TabletScaffold.CATEGORY_SCROLL, saved.getInt(TabletScaffold.CATEGORY_SCROLL, 0));
        EmbeddedNetwork.initialize(getApplicationContext());
        chinese = getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        countFormat = android.icu.text.CompactDecimalFormat.getInstance(chinese ? java.util.Locale.CHINA : java.util.Locale.US,
            android.icu.text.CompactDecimalFormat.CompactStyle.SHORT);
        countFormat.setSignificantDigitsUsed(false); countFormat.setMaximumFractionDigits(1);
        style = new SettingsStyle(this); cache = new AccountUsageCache(this);
        address = saved == null ? getIntent().getStringExtra("address") : saved.getString("address");
        if (address == null) address = "";
        if (saved != null) { tab = saved.getString("tab", tab); range = saved.getString("range", range); source = saved.getString("source", ""); accountId = saved.getString("account", ""); model = saved.getString("model", ""); }
        boolean tabletSettings = MobileLayout.useTabletRail(getResources().getConfiguration());
        LinearLayout root = column(); root.setBackgroundColor(style.background); style.pagePadding(root);
        getWindow().setStatusBarColor(style.background); getWindow().setNavigationBarColor(style.background);
        getWindow().getDecorView().setSystemUiVisibility(style.palette().dark ? 0 : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        String title = tr("额度与用量", "Quota & usage");
        root.addView(tabletSettings ? style.header(title) : style.header(title, tr("返回", "Back"), this::finish));
        LinearLayout connection = style.group(root, ""); connection.setElevation(0);
        connection.setOrientation(LinearLayout.HORIZONTAL); connection.setGravity(Gravity.CENTER_VERTICAL);
        connection.setPadding(dp(6), dp(4), dp(6), dp(4));
        selector = new LinearLayout(this); selector.setGravity(Gravity.CENTER_VERTICAL);
        selector.setTag("usageComputer"); selector.setMinimumHeight(dp(56)); selector.setPadding(dp(8), dp(4), dp(4), dp(4));
        selector.setFocusable(true); selector.setOnClickListener(v -> chooseComputer());
        selector.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), null, style.round(android.graphics.Color.WHITE, Palette.RADIUS_SETTINGS_CONTROL)));
        android.widget.ImageView computerIcon = new android.widget.ImageView(this); computerIcon.setImageDrawable(new LineIcon("computer", style.secondary));
        selector.addView(computerIcon, new LinearLayout.LayoutParams(dp(22), dp(22)));
        LinearLayout identity = column(); identity.setPadding(dp(12), 0, dp(4), 0);
        computerName = style.label("", Palette.TEXT_BODY, style.ink); computerName.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        computerName.setMaxLines(1); computerName.setEllipsize(android.text.TextUtils.TruncateAt.END); identity.addView(computerName);
        status = style.label("", Palette.TEXT_SMALL, style.secondary); status.setTag("usageStatus");
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); identity.addView(status);
        selector.addView(identity, new LinearLayout.LayoutParams(0, -2, 1));
        computerArrow = new android.widget.ImageView(this); computerArrow.setImageDrawable(new LineIcon("down", style.secondary));
        computerArrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        selector.addView(computerArrow, new LinearLayout.LayoutParams(dp(14), dp(14)));
        connection.addView(selector, new LinearLayout.LayoutParams(0, -2, 1));
        refresh = new ChatStyle(this).lineButton("refresh", tr("刷新", "Refresh"), () -> fetch(true)); refresh.setTag("usageRefresh");
        LinearLayout.LayoutParams refreshParams = new LinearLayout.LayoutParams(dp(48), dp(48)); refreshParams.setMarginStart(dp(8)); connection.addView(refresh, refreshParams);
        LinearLayout tabs = new LinearLayout(this); tabs.setPadding(dp(4), dp(4), dp(4), dp(4));
        tabs.setTag("usageTabs"); tabs.setBackground(style.round(style.palette().progressTrack, Palette.RADIUS_SETTINGS_CARD));
        quotaTab = tabButton(tr("额度与余额", "Quota & balances"), "quota", "usageTabQuota");
        usageTab = tabButton(tr("使用统计", "Usage history"), "usage", "usageTabHistory");
        tabs.addView(quotaTab, new LinearLayout.LayoutParams(0, -1, 1));
        tabs.addView(usageTab, new LinearLayout.LayoutParams(0, -1, 1));
        LinearLayout.LayoutParams tabsParams = new LinearLayout.LayoutParams(-1, -2); tabsParams.topMargin = dp(8); root.addView(tabs, tabsParams);
        scroll = ScrollViews.plain(this); scroll.setVerticalScrollBarEnabled(false); body = column(); body.setPadding(0, dp(12), 0, dp(16)); scroll.addView(body); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        View page = root;
        if (tabletSettings) {
            root.setOnApplyWindowInsetsListener(null); root.setPadding(dp(24), dp(8), dp(24), dp(16));
            View split = TabletScaffold.settingsBody(this, root, "usage", section -> {
                if (section.equals("usage")) return;
                if (section.equals("network")) { leaveTabletUsage("network"); return; }
                TabletScaffold.openSettingsCategory(this, new android.content.Intent(this, SettingsActivity.class).putExtra("section", section)
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP | android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP));
                PageTransitions.finishDestination(this);
            });
            page = TabletScaffold.wrap(this, split, "settings", () -> leaveTabletUsage("home"),
                () -> leaveTabletUsage("sessions"), () -> leaveTabletUsage("computers"), () -> {});
        }
        setContentView(page); page.requestApplyInsets();
    }

    private void leaveTabletUsage(String destination) {
        android.content.Intent target = new android.content.Intent(this, MainActivity.class).putExtra("tabletDestination", destination)
            .addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP | android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (destination.equals("network")) TabletScaffold.openSettingsCategory(this, target);
        else PageTransitions.openDestination(this, target);
        PageTransitions.finishDestination(this);
    }

    @Override protected void onStart() {
        super.onStart(); EmbeddedNetwork.foreground(); active = true; int ticket = ++generation;
        worker.execute(() -> {
            try {
                ComputerStore store = new ComputerStore(new CredentialStore(this));
                var paired = new ArrayList<JSONObject>(); for (JSONObject item : store.all()) if (item.has("token")) paired.add(item);
                String current = store.load().optString("address");
                handler.post(() -> {
                    if (!active || ticket != generation) return;
                    computers = paired; JSONObject selected = null;
                    for (JSONObject item : paired) if (item.optString("address").equals(address.isEmpty() ? current : address)) selected = item;
                    if (selected == null && !paired.isEmpty()) selected = paired.get(0);
                    select(selected);
                });
            } catch (Exception error) { handler.post(() -> { if (active && ticket == generation) { notice = tr("无法读取配对信息，请返回重新打开。", "Cannot read pairing. Go back and reopen this page."); render(); } }); }
        });
    }
    @Override protected void onStop() { if (choiceDropdown != null) choiceDropdown.dismiss(); if (computerPicker != null) computerPicker.dismiss(); active = false; generation++; handler.removeCallbacksAndMessages(null); if (client != null) client.cancel(); loading = false; EmbeddedNetwork.background(); super.onStop(); }
    @Override protected void onDestroy() { if (choiceDropdown != null) choiceDropdown.dismiss(); worker.shutdownNow(); super.onDestroy(); }
    @Override public void finish() { if (choiceDropdown != null) choiceDropdown.dismiss(); if (computerPicker != null) computerPicker.dismiss(); super.finish(); PageTransitions.closeActivity(this); }
    @Override protected void onSaveInstanceState(Bundle saved) { super.onSaveInstanceState(saved); saved.putString("address", address); saved.putString("tab", tab); saved.putString("range", range); saved.putString("source", source); saved.putString("account", accountId); saved.putString("model", model); saved.putInt(TabletScaffold.CATEGORY_SCROLL, TabletScaffold.savedCategoryScroll(this)); }
    private String tr(String zh, String en) { return chinese ? zh : en; }
    private int dp(int value) { return style.dp(value); }
    private TextView tabButton(String title, String id, String tag) {
        TextView button = style.label(title, Palette.TEXT_BODY, style.secondary); button.setTag(tag);
        button.setGravity(Gravity.CENTER); button.setMinHeight(dp(44)); button.setPadding(dp(6), dp(8), dp(6), dp(8));
        button.setFocusable(true); button.setOnClickListener(v -> { tab = id; scroll.scrollTo(0, 0); render(); });
        button.setAccessibilityDelegate(new View.AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View view, android.view.accessibility.AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(view, info); info.setClassName("android.widget.RadioButton");
                info.setCheckable(true); info.setChecked(view.isSelected());
            }
        });
        return button;
    }
    private LinearLayout column() { LinearLayout value = new LinearLayout(this); value.setOrientation(LinearLayout.VERTICAL); return value; }
    private String name(JSONObject item) { return item.optString("computerName", item.optString("address")); }
    private void chooseComputer() {
        if (computerPicker != null && computerPicker.isShowing()) { computerPicker.dismiss(); return; }
        if (computers.isEmpty()) return;
        if (choiceDropdown != null) choiceDropdown.dismiss();
        var entries = new ArrayList<ComputerPickerPopup.Entry>();
        for (JSONObject target : computers) {
            String targetAddress = target.optString("address");
            entries.add(new ComputerPickerPopup.Entry(targetAddress, name(target), "", targetAddress.equals(address),
                () -> { if (!targetAddress.equals(address)) select(target); }));
        }
        computerPicker = new ComputerPickerPopup(selector, new ChatStyle(this), chinese, entries, null, null);
        computerArrow.setImageDrawable(new LineIcon("up", style.secondary)); selector.setSelected(true);
        computerPicker.onDismiss(() -> {
            computerArrow.setImageDrawable(new LineIcon("down", style.secondary)); selector.setSelected(false); computerPicker = null;
        });
    }
    private void choose(String tag, String title, String[] labels, int selected, boolean searchable, java.util.function.IntConsumer action) {
        if (choiceDropdown != null) choiceDropdown.dismiss();
        if (computerPicker != null) computerPicker.dismiss();
        View anchor = getWindow().getDecorView().findViewWithTag(tag);
        choiceDropdown = new ChoiceDropdown(anchor, title, labels, selected, searchable, action);
        choiceDropdown.onDismiss(() -> choiceDropdown = null);
    }
    private void select(JSONObject selected) {
        generation++; polls = 0; handler.removeCallbacksAndMessages(null); if (client != null) client.cancel(); loading = false;
        boolean changed = selected == null || !selected.optString("address").equals(address);
        computer = selected; address = selected == null ? "" : selected.optString("address"); data = null; cached = true; supported = null;
        notice = ""; noticeTitle = ""; detail = ""; detailsExpanded = false;
        if (changed) { accountId = ""; model = ""; scroll.scrollTo(0, 0); }
        computerName.setText(selected == null ? tr("选择电脑", "Choose a computer") : name(selected));
        selector.setContentDescription(tr("数据来源：", "Source computer: ") + computerName.getText());
        render(); if (selected == null) return;
        int ticket = generation;
        worker.execute(() -> {
            JSONObject saved = null; try { saved = cache.load(selected); } catch (Exception ignored) { }
            JSONObject result = saved;
            handler.post(() -> { if (active && ticket == generation) { if (AccountUsage.valid(result)) data = result; render(); fetch(false); } });
        });
    }
    private void fetch(boolean force) {
        if (!active || loading || computer == null) return;
        EmbeddedNetwork.foreground();
        loading = true; if (force) polls = 0; notice = ""; noticeTitle = ""; detail = ""; detailsExpanded = false; render();
        int ticket = generation; JSONObject target = computer;
        Boolean knownSupport = supported;
        RemoteApi request = clientFactory == null ? new RemoteApi(this, address) : clientFactory.apply(address); client = request;
        worker.execute(() -> {
            JSONObject result = null; Exception failure = null; boolean cacheFailed = false; Boolean capability = knownSupport;
            try {
                if (force || capability == null) {
                    JSONObject info = request.json("/v1/status", target.optString("token"), null);
                    capability = false;
                    var capabilities = info.optJSONArray("capabilities");
                    if (capabilities != null) for (int i = 0; i < capabilities.length(); i++) if ("account-usage".equals(capabilities.optString(i))) capability = true;
                }
                // Older hosts send a generic 405 for every unknown POST. Probe with GET
                // when the capability is absent, preserving a scoped host's real 403.
                boolean refreshAccounts = force && Boolean.TRUE.equals(capability);
                result = request.json(refreshAccounts ? "/v1/account-usage/refresh" : "/v1/account-usage", target.optString("token"), refreshAccounts ? new JSONObject() : null);
                if (!AccountUsage.valid(result)) throw new java.io.IOException("Unsupported account usage response");
                if (active && ticket == generation) try { cacheFailed = !cache.save(target, result); } catch (Exception error) { cacheFailed = true; }
            } catch (Exception error) {
                failure = error;
                if (error instanceof RemoteApi.Failure && (((RemoteApi.Failure) error).status == 401 || ((RemoteApi.Failure) error).status == 403)) try { cache.remove(target); } catch (Exception ignored) { }
            } finally { request.cancel(); }
            JSONObject reply = result; Exception error = failure; boolean storageFailed = cacheFailed; Boolean available = capability;
            handler.post(() -> {
                if (!active || ticket != generation) return;
                loading = false; supported = available;
                if (error == null) {
                    data = reply; cached = false;
                    notice = storageFailed ? tr("本次数据未缓存，离线时将显示旧记录。", "This result was not cached. Older data will appear offline.") : "";
                    if (reply.optBoolean("refreshing") && polls++ < 40) handler.postDelayed(() -> fetch(false), 1500);
                } else {
                    cached = true; showFailure(error);
                    if (error instanceof RemoteApi.Failure && (((RemoteApi.Failure) error).status == 401 || ((RemoteApi.Failure) error).status == 403)) data = null;
                }
                render();
            });
        });
    }
    private void renderStatus() {
        String text = data == null ? tr("等待连接", "Waiting to connect") : tr("更新于 ", "Updated ") + date(data.optString("updatedAt"));
        if (loading) text = tr("正在读取…", "Loading…");
        else if (data == null && !noticeTitle.isEmpty()) text = tr("暂未同步", "Not synced");
        else if (cached && data != null) text = tr("上次数据 · ", "Cached · ") + date(data.optString("updatedAt"));
        else if (data != null && data.optBoolean("refreshing")) text += tr(" · 刷新中", " · Refreshing");
        status.setText(text); refresh.setEnabled(computer != null && !loading); refresh.setAlpha(refresh.isEnabled() ? 1f : .5f);
    }
    private void showFailure(Exception error) {
        detail = RemoteApi.failureMessage(error, chinese);
        int code = error instanceof RemoteApi.Failure ? ((RemoteApi.Failure) error).status : 0;
        if (code == 404 || code == 405) {
            noticeTitle = tr("电脑端需要更新或重启", "Update or restart the desktop");
            notice = tr("请在这台电脑上更新并重启 Camellia，然后点击刷新。", "Update and restart Camellia on this computer, then tap Refresh.");
        } else if (code == 401) {
            noticeTitle = tr("需要重新配对", "Pair this computer again");
            notice = tr("配对已失效或被撤销。请返回远程电脑页面重新配对。", "Pairing has expired or was revoked. Pair again from Remote computers.");
        } else if (code == 403) {
            noticeTitle = tr("需要完整电脑权限", "Full-device permission required");
            notice = tr("请在电脑端的移动端访问设置中，允许此设备控制全部工作区。", "In the desktop's Mobile access settings, allow this device to control all workspaces.");
        } else {
            noticeTitle = tr("暂时无法同步", "Unable to sync");
            notice = data == null ? tr("请确认电脑已打开、网络已连接，然后重试。", "Check that the computer is running and connected, then try again.")
                : tr("正在显示上次保存的数据。电脑恢复连接后，点击刷新即可更新。", "Showing saved data. Tap Refresh when the computer is connected again.");
        }
    }
    private LinearLayout contentCard() {
        LinearLayout card = style.group(body, ""); card.setElevation(0); card.setPadding(dp(16), dp(14), dp(16), dp(14));
        ((LinearLayout.LayoutParams) card.getLayoutParams()).bottomMargin = dp(10); return card;
    }
    private void noticeCard() {
        LinearLayout card = contentCard(); card.setTag("usageNotice");
        if (!noticeTitle.isEmpty()) {
            TextView title = style.label(noticeTitle, Palette.TEXT_ROW_STRONG, style.ink);
            title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); title.setPadding(0, 0, 0, dp(8)); card.addView(title);
        }
        card.addView(style.label(notice, Palette.TEXT_BODY, style.secondary));
        if (!detail.isEmpty()) {
            TextView toggle = style.label(detailsExpanded ? tr("收起详情", "Hide details") : tr("查看详情", "View details"), Palette.TEXT_NOTE, style.accent);
            toggle.setTag("usageDetailsToggle"); toggle.setGravity(Gravity.CENTER_VERTICAL); toggle.setMinHeight(dp(44)); toggle.setFocusable(true);
            toggle.setOnClickListener(v -> { detailsExpanded = !detailsExpanded; render(); }); card.addView(toggle);
            if (detailsExpanded) {
                TextView diagnostic = style.label(detail, Palette.TEXT_SMALL, style.secondary); diagnostic.setTag("usageErrorDetails");
                diagnostic.setTextIsSelectable(true); diagnostic.setPadding(dp(10), dp(10), dp(10), dp(10));
                diagnostic.setBackground(style.round(style.field, Palette.RADIUS_SETTINGS_CONTROL)); card.addView(diagnostic);
            }
        }
    }
    private void filterRow(LinearLayout group, String title, String value, String tag, Runnable action) {
        if (group.getChildCount() > 0) {
            View line = new View(this); line.setBackgroundColor(style.divider);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, 1); params.setMargins(dp(14), 0, dp(14), 0); group.addView(line, params);
        }
        LinearLayout row = new LinearLayout(this); row.setGravity(Gravity.CENTER_VERTICAL); row.setMinimumHeight(dp(48));
        row.setPadding(dp(14), dp(8), dp(12), dp(8)); row.setTag(tag); row.setFocusable(true);
        row.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), null, style.round(android.graphics.Color.WHITE, 0)));
        row.setOnClickListener(v -> action.run()); row.setContentDescription(title + ", " + value);
        row.addView(style.label(title, Palette.TEXT_BODY, style.secondary), new LinearLayout.LayoutParams(0, -2, .38f));
        TextView current = style.label(value, Palette.TEXT_BODY, style.ink); current.setGravity(Gravity.END); current.setMaxLines(2);
        current.setEllipsize(android.text.TextUtils.TruncateAt.END); row.addView(current, new LinearLayout.LayoutParams(0, -2, .62f));
        android.widget.ImageView arrow = new android.widget.ImageView(this); arrow.setImageDrawable(new LineIcon("down", style.secondary));
        LinearLayout.LayoutParams arrowParams = new LinearLayout.LayoutParams(dp(14), dp(14)); arrowParams.setMarginStart(dp(8)); row.addView(arrow, arrowParams);
        group.addView(row);
    }
    private void render() {
        if (style == null) return;
        int top = scroll.getScrollY(); body.removeAllViews();
        quotaTab.setSelected(tab.equals("quota")); usageTab.setSelected(tab.equals("usage"));
        for (TextView button : new TextView[]{quotaTab, usageTab}) {
            button.setTextColor(button.isSelected() ? style.ink : style.secondary);
            button.setTypeface(Typeface.create(button.isSelected() ? "sans-serif-medium" : "sans-serif", Typeface.NORMAL));
            button.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD),
                button.isSelected() ? style.round(style.card, Palette.RADIUS_SETTINGS_CONTROL) : null,
                style.round(android.graphics.Color.WHITE, Palette.RADIUS_SETTINGS_CONTROL)));
        }
        renderStatus();
        if (!notice.isEmpty()) noticeCard();
        if (computer == null) { style.emptyState(body, tr("先配对一台电脑", "Pair a computer first"), tr("在远程电脑中添加电脑，即可查看它的额度与用量。", "Add a remote computer to view its quota and usage."), "", null); return; }
        if (data == null) {
            if (notice.isEmpty()) {
                LinearLayout card = contentCard(); card.setPadding(dp(20), dp(24), dp(20), dp(24));
                card.addView(style.label(loading ? tr("正在连接电脑", "Connecting to computer") : tr("连接后查看用量", "Connect to view usage"), Palette.TEXT_ROW_STRONG, style.ink));
                TextView hint = style.label(tr("订阅额度、API 余额和使用记录将在这里显示。", "Subscription quotas, API balances and usage will appear here."), Palette.TEXT_NOTE, style.secondary);
                hint.setPadding(0, dp(8), 0, 0); card.addView(hint);
            }
            return;
        }
        if (data.optBoolean("refreshFailed")) style.note(body, tr("部分刷新失败，保留上次成功结果。", "Refresh failed. Last successful readings are retained."));
        if (tab.equals("quota")) {
            LinearLayout controls = new LinearLayout(this);
            controls.addView(textControl(sourceName(), "usageSource", this::chooseSource), new LinearLayout.LayoutParams(-1, -2));
            controls.setPadding(0, 0, 0, dp(8));
            body.addView(controls); quota();
        } else history();
        scroll.post(() -> scroll.scrollTo(0, top));
    }
    private TextView textControl(String title, String tag, Runnable action) {
        TextView control = style.label(title, Palette.TEXT_BODY, style.ink); control.setTag(tag);
        ActionStyle.apply(control, false, Palette.TEXT_BODY, 44, Palette.RADIUS_SETTINGS_CONTROL);
        control.setGravity(Gravity.CENTER_VERTICAL | Gravity.START); control.setPadding(dp(12), dp(8), dp(12), dp(8));
        control.setSingleLine(true); control.setEllipsize(android.text.TextUtils.TruncateAt.END); control.setTooltipText(title);
        control.setCompoundDrawablePadding(dp(10)); control.setOnClickListener(v -> action.run());
        updateControl(control, title, false, false);
        return control;
    }
    private void updateControl(TextView control, String title, boolean expanded, boolean highlighted) {
        control.setText(title); control.setSelected(expanded);
        LineIcon arrow = new LineIcon(expanded ? "up" : "down", style.secondary); arrow.setBounds(0, 0, dp(14), dp(14));
        control.setCompoundDrawablesRelative(null, null, arrow, null);
        var face = style.round(highlighted ? style.palette().controlFill : style.card, Palette.RADIUS_SETTINGS_CONTROL);
        face.setStroke(dp(1), highlighted ? style.palette().selectedBorder : style.palette().cardBorder);
        control.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), face,
            style.round(android.graphics.Color.WHITE, Palette.RADIUS_SETTINGS_CONTROL)));
    }
    private String sourceName() { return source.equals("api") ? "API" : source.equals("subscription") ? tr("订阅", "Subscription") : tr("全部类型", "All types"); }
    private void chooseSource() {
        String[] labels = {tr("全部类型", "All types"), tr("订阅", "Subscription"), "API"}; String[] ids = {"", "subscription", "api"};
        choose("usageSource", tr("类型", "Type"), labels, Math.max(0, java.util.Arrays.asList(ids).indexOf(source)), false, i -> { source = ids[i]; accountId = ""; model = ""; render(); });
    }
    private void quota() {
        int shown = 0;
        for (String kind : new String[]{"subscription", "api"}) {
            var accounts = AccountUsage.accounts(data, source).stream().filter(a -> kind.equals(a.optString("source")) && !a.optBoolean("archived")).toList();
            if (accounts.isEmpty()) continue;
            TextView heading = style.label(kind.equals("api") ? "API" : tr("订阅", "Subscription"), Palette.TEXT_ROW_STRONG, style.ink); heading.setPadding(dp(4), dp(8), 0, dp(8)); body.addView(heading);
            for (JSONObject account : accounts) {
                shown++; LinearLayout card = contentCard();
                TextView provider = style.label(account.optString("provider"), Palette.TEXT_ROW_STRONG, style.ink);
                provider.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); card.addView(provider);
                TextView label = style.label(account.optString("label"), Palette.TEXT_NOTE, style.secondary); label.setPadding(0, dp(2), 0, dp(8)); card.addView(label);
                if (!account.optBoolean("enabled", true)) card.addView(style.label(tr("未启用或未登录", "Disabled or signed out"), Palette.TEXT_NOTE, style.secondary));
                for (JSONObject balance : AccountUsage.objects(account.optJSONArray("balances"))) {
                    TextView amount = style.label(balance.isNull("value") ? balance.optString("currency") + " · " + tr("余额未知", "Balance unavailable") : number(balance.optDouble("value")) + " " + balance.optString("currency"), balance.isNull("value") ? Palette.TEXT_BODY : Palette.TEXT_TITLE, balance.isNull("value") ? style.secondary : style.ink);
                    amount.setFontFeatureSettings("tnum"); amount.setPadding(0, dp(4), 0, dp(4)); card.addView(amount);
                }
                for (JSONObject window : AccountUsage.objects(account.optJSONArray("windows"))) {
                    boolean percent = !window.isNull("usedPercent");
                    double remaining = Math.max(0, Math.min(100, 100 - window.optDouble("usedPercent", 0)));
                    String value = percent ? number(remaining) + tr("% 剩余", "% remaining") : !window.isNull("remainingValue") ? number(window.optDouble("remainingValue")) + " " + window.optString("unit") : tr("暂不可用", "Unavailable");
                    LinearLayout line = new LinearLayout(this); line.setGravity(Gravity.CENTER_VERTICAL); line.setPadding(0, dp(8), 0, dp(6));
                    line.addView(style.label(window.optString("label"), Palette.TEXT_BODY, style.secondary), new LinearLayout.LayoutParams(0, -2, 1));
                    TextView amount = style.label(value, Palette.TEXT_BODY, style.ink); amount.setFontFeatureSettings("tnum"); amount.setPadding(dp(8), 0, 0, 0); line.addView(amount); card.addView(line);
                    if (percent) { var bar = style.progressBar(); bar.setProgress((int) Math.round(remaining)); bar.setContentDescription(window.optString("label") + ", " + value); card.addView(bar, new LinearLayout.LayoutParams(-1, dp(5))); }
                    if (!window.isNull("resetsAt")) card.addView(style.label(tr("重置于 ", "Resets ") + date(window.optString("resetsAt")), Palette.TEXT_NOTE, style.secondary));
                }
                if (AccountUsage.objects(account.optJSONArray("balances")).isEmpty() && AccountUsage.objects(account.optJSONArray("windows")).isEmpty()) card.addView(style.label(account.optBoolean("supported") ? tr("尚未查询到额度，点击刷新。", "No reading yet. Tap Refresh.") : tr("暂不支持查询额度", "Quota queries are not supported"), Palette.TEXT_BODY, style.secondary));
                if (!account.isNull("updatedAt")) { TextView updated = style.label(tr("更新于 ", "Updated ") + date(account.optString("updatedAt")), Palette.TEXT_SMALL, style.secondary); updated.setPadding(0, dp(10), 0, 0); card.addView(updated); }
                if (account.optBoolean("failed") || account.optBoolean("stale")) card.addView(style.label(tr("数据可能过期；请稍后刷新。", "Reading may be stale. Refresh again later."), Palette.TEXT_NOTE, style.error));
            }
        }
        if (shown == 0) style.note(body, tr("这台电脑尚无相关账号。", "No matching accounts on this computer."));
        style.note(body, tr("额度由服务商提供，可能与其他设备共享。不同账号、Key 和币种的余额不合计。", "Provider quotas may be shared across devices. Balances are not summed across accounts, keys or currencies."));
    }
    private void history() {
        boolean monthly = AccountUsage.hasRange(data, "month"); if (!monthly && range.equals("month")) range = "7";
        String[] ranges = monthly ? new String[]{"1", "7", "30", "month", "all"} : new String[]{"1", "7", "30", "all"};
        String[] names = monthly ? new String[]{tr("今天", "Today"), tr("最近 7 天", "Last 7 days"), tr("最近 30 天", "Last 30 days"), tr("本月", "This month"), tr("全部", "All")}
            : new String[]{tr("今天", "Today"), tr("最近 7 天", "Last 7 days"), tr("最近 30 天", "Last 30 days"), tr("全部", "All")};
        LinearLayout controls = new LinearLayout(this); controls.setGravity(Gravity.CENTER_VERTICAL); controls.setPadding(0, 0, 0, dp(8));
        controls.addView(textControl(names[java.util.Arrays.asList(ranges).indexOf(range)], "usageRange", () -> choose("usageRange", tr("时间", "Period"), names, java.util.Arrays.asList(ranges).indexOf(range), false, i -> { range = ranges[i]; model = ""; render(); })), new LinearLayout.LayoutParams(0, -2, 1));
        int activeFilters = (source.isEmpty() ? 0 : 1) + (accountId.isEmpty() ? 0 : 1) + (model.isEmpty() ? 0 : 1);
        TextView toggle = textControl(tr("筛选", "Filters"), "usageFiltersToggle", () -> { filtersExpanded = !filtersExpanded; render(); });
        LinearLayout.LayoutParams toggleParams = new LinearLayout.LayoutParams(0, -2, 1); toggleParams.setMarginStart(dp(8));
        controls.addView(toggle, toggleParams); body.addView(controls);
        LinearLayout filters = column(); filters.setTag("usageFilters"); filters.setBackground(style.cardBackground());
        if (filtersExpanded) { LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.bottomMargin = dp(12); body.addView(filters, params); }
        filterRow(filters, tr("类型", "Type"), sourceName(), "usageSource", this::chooseSource);
        var accounts = AccountUsage.accounts(data, source); var accountNames = new ArrayList<String>(); var accountIds = new ArrayList<String>();
        accountNames.add(tr("全部账号", "All accounts")); accountIds.add("");
        for (JSONObject account : accounts) { accountNames.add(account.optString("provider") + " · " + account.optString("label") + (account.optBoolean("archived") ? tr(" · 历史 Key", " · Previous key") : "")); accountIds.add(account.optString("id")); }
        if (!accountIds.contains(accountId)) accountId = "";
        filterRow(filters, tr("账号 / Key", "Account / key"), accountNames.get(accountIds.indexOf(accountId)), "usageAccount", () -> choose("usageAccount", tr("账号 / Key", "Account / key"), accountNames.toArray(new String[0]), accountIds.indexOf(accountId), true, i -> { accountId = accountIds.get(i); model = ""; render(); }));
        var models = new java.util.TreeSet<String>(); for (JSONObject row : AccountUsage.rows(data, range, source, accountId, "")) if (!row.optString("model").isEmpty()) models.add(row.optString("model"));
        var modelIds = new ArrayList<String>(); modelIds.add(""); modelIds.addAll(models); if (!modelIds.contains(model)) model = "";
        activeFilters = (source.isEmpty() ? 0 : 1) + (accountId.isEmpty() ? 0 : 1) + (model.isEmpty() ? 0 : 1);
        updateControl(toggle, tr("筛选", "Filters") + (activeFilters == 0 ? "" : " · " + activeFilters), filtersExpanded, filtersExpanded || activeFilters > 0);
        toggle.setContentDescription(toggle.getText() + tr("，筛选类型、账号和模型，", ", filter by type, account and model, ") + (filtersExpanded ? tr("已展开", "expanded") : tr("已收起", "collapsed")));
        var modelNames = new ArrayList<String>(modelIds); modelNames.set(0, tr("全部模型", "All models"));
        filterRow(filters, tr("模型", "Model"), modelNames.get(modelIds.indexOf(model)), "usageModel", () -> choose("usageModel", tr("模型", "Model"), modelNames.toArray(new String[0]), modelIds.indexOf(model), true, i -> { model = modelIds.get(i); render(); }));
        var rows = AccountUsage.rows(data, range, source, accountId, model);
        LinearLayout summary = contentCard(); summary.setTag("usageSummary");
        double totalTokens = AccountUsage.sum(rows, "inputTokens", "outputTokens");
        LinearLayout first = new LinearLayout(this); first.setGravity(Gravity.TOP);
        stat(first, tr("Token 总量", "Total tokens"), totalTokens, "usageTotalTokens", Palette.TEXT_TITLE);
        stat(first, tr("成功请求 / 轮次", "Successful requests / turns"), AccountUsage.sum(rows, "requests"));
        summary.addView(first);
        LinearLayout second = new LinearLayout(this); second.setGravity(Gravity.TOP); second.setPadding(0, dp(14), 0, 0);
        stat(second, tr("输入 Token", "Input tokens"), AccountUsage.sum(rows, "inputTokens"));
        stat(second, tr("输出 Token", "Output tokens"), AccountUsage.sum(rows, "outputTokens"));
        summary.addView(second);
        if (AccountUsage.sum(rows, "unreported") > 0) style.note(body, tr("部分请求未完整上报 Token，用量合计可能偏低。", "Some requests did not report complete token usage. Totals may be low."));
        if (data.optBoolean("usageFailed")) style.note(body, tr("电脑端订阅统计保存异常，请检查电脑端。", "Subscription usage could not be saved. Check the desktop."));
        for (JSONObject row : rows) {
            JSONObject account = null; for (JSONObject item : accounts) if (item.optString("id").equals(row.optString("accountId"))) account = item;
            LinearLayout card = contentCard();
            card.addView(style.label(row.optString("model").isEmpty() ? tr("历史合计（未按模型归类）", "Legacy totals (model unknown)") : row.optString("model"), Palette.TEXT_ROW_STRONG, style.ink));
            if (account != null) card.addView(style.label(account.optString("provider") + " · " + account.optString("label") + (account.optBoolean("archived") ? tr(" · 历史 Key", " · Previous key") : ""), Palette.TEXT_NOTE, style.secondary));
            card.addView(usageLine(tr("输入 ", "Input "), row.optDouble("inputTokens", 0), tr("输出 ", "Output "), row.optDouble("outputTokens", 0), Palette.TEXT_BODY, style.ink));
            card.addView(usageLine(tr("缓存读取 ", "Cache read "), row.optDouble("cacheReadTokens", 0), tr("写入 ", "Write "), row.optDouble("cacheWriteTokens", 0), Palette.TEXT_NOTE, style.secondary));
            card.addView(usageLine(tr("成功 ", "Success "), row.optDouble("requests", 0), tr("失败/取消 ", "Failed/canceled "), AccountUsage.sum(List.of(row), "failures", "cancelled"), Palette.TEXT_NOTE, style.secondary));
            if (account != null && account.optString("source").equals("subscription")) {
                if (row.optDouble("pricedTokens", 0) > 0) card.addView(style.label(tr("API 等价估值 ", "API equivalent ") + String.format(java.util.Locale.ROOT, "$%.4f", row.optDouble("estimatedCostUsd", 0)), Palette.TEXT_NOTE, style.secondary));
                if (row.optDouble("unpricedTokens", 0) > 0) card.addView(style.label(tr("部分 Token 尚未定价", "Some tokens are unpriced"), Palette.TEXT_NOTE, style.secondary));
            }
        }
        if (rows.isEmpty()) style.note(body, tr("此时间范围没有相关记录。", "No matching usage in this period."));
        style.note(body, tr("仅统计这台电脑记录的调用，日期按电脑时区计算。订阅金额按标准 API 价格折算，不是实际账单。", "Only calls recorded on this computer are included; dates use its time zone. Subscription amounts are standard API equivalents, not bills."));
    }
    private String number(double value) { java.text.NumberFormat format = java.text.NumberFormat.getNumberInstance(chinese ? java.util.Locale.CHINA : java.util.Locale.US); format.setMaximumFractionDigits(2); return format.format(value); }
    private String count(double value) { return countFormat.format(value); }
    private TextView usageLine(String firstTitle, double first, String secondTitle, double second, int size, int color) {
        TextView label = style.label(firstTitle + count(first) + " · " + secondTitle + count(second), size, color);
        String exact = firstTitle + number(first) + " · " + secondTitle + number(second);
        label.setContentDescription(exact); label.setTooltipText(exact); return label;
    }
    private void stat(LinearLayout group, String title, double value) {
        stat(group, title, value, null, Palette.TEXT_ROW_STRONG);
    }
    private void stat(LinearLayout group, String title, double value, String tag, int size) {
        LinearLayout stat = column(); stat.setPadding(0, 0, dp(12), 0);
        stat.addView(style.label(title, Palette.TEXT_SMALL, style.secondary));
        TextView number = style.label(count(value), size, style.ink); number.setFontFeatureSettings("tnum");
        if (size > Palette.TEXT_ROW_STRONG) number.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        if (tag != null) number.setTag(tag);
        number.setContentDescription(title + ": " + number(value)); number.setTooltipText(number(value)); stat.addView(number);
        group.addView(stat, new LinearLayout.LayoutParams(0, -2, 1));
    }
    private String date(String value) { try { return java.time.Instant.parse(value).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm")); } catch (Exception error) { return tr("未知", "Unknown"); } }
}
