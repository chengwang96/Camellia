package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Device selection never changes the active conversation or starts a connection. */
@android.annotation.SuppressLint("ViewConstructor")
final class TabletComputerPane extends LinearLayout {
    interface Listener {
        String name(JSONObject computer);
        void selected(String address);
        void open(JSONObject computer);
        void test(JSONObject computer);
        void rename(JSONObject computer);
        void lanPin(JSONObject computer);
        void restart(JSONObject computer);
        void forget(JSONObject computer);
        void add();
    }
    private final SettingsStyle style;
    private final boolean chinese;
    private final Listener listener;
    private final List<JSONObject> computers;
    private final Map<String, TextView> stateLabels = new LinkedHashMap<>();
    private final Map<String, View> deviceRows = new LinkedHashMap<>();
    private final Map<String, String> states, routes;
    private final Map<String, JSONObject> information;
    private final LinearLayout detail;
    private final ScrollView detailScroll;
    private JSONObject selected;
    private TextView detailState, connectionMethod, connectionPath, permission, unavailable;
    private TextView restart;
    private boolean expanded;

    TabletComputerPane(Context context, boolean chinese, List<JSONObject> computers, String address,
                       Map<String, String> states, Map<String, String> routes,
                       Map<String, JSONObject> information, boolean expanded, Listener listener) {
        super(context); this.chinese = chinese; this.listener = listener; this.computers = computers;
        this.states = states; this.routes = routes; this.information = information; this.expanded = expanded;
        style = new SettingsStyle(context); setOrientation(HORIZONTAL); setTag("tabletComputerPane");
        LinearLayout sidebar = column(); sidebar.setPadding(dp(12), dp(10), dp(12), 0);
        sidebar.setBackgroundColor(style.background);
        LinearLayout heading = new LinearLayout(context); heading.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = label(tr("电脑列表", "Computers"), 20, style.ink); title.setTypeface(null, Typeface.BOLD);
        heading.addView(title, new LayoutParams(0, dp(56), 1));
        TextView add = action("+", "tabletAddComputer", listener::add); add.setTextSize(26);
        add.setContentDescription(tr("添加电脑", "Add computer")); heading.addView(add, new LayoutParams(dp(48), dp(48)));
        sidebar.addView(heading); sidebar.addView(label(tr(computers.size() + " 台已配对电脑", computers.size() + " paired computers"), 12, style.secondary));
        ScrollView list = ScrollViews.plain(context); list.setTag("tabletDeviceScroll");
        LinearLayout rows = column(); rows.setPadding(0, dp(12), 0, dp(16)); list.addView(rows);
        sidebar.addView(list, new LayoutParams(-1, 0, 1));
        addView(sidebar, new LayoutParams(dp(252), -1));
        View separator = new View(context); separator.setBackgroundColor(style.divider);
        addView(separator, new LayoutParams(Math.max(1, dp(1)), -1));
        detailScroll = ScrollViews.plain(context); detailScroll.setTag("tabletComputerDetailScroll");
        detail = column(); detail.setPadding(dp(24), dp(24), dp(24), dp(24)); detailScroll.addView(detail);
        addView(detailScroll, new LayoutParams(0, -1, 1));
        for (JSONObject computer : computers) {
            String key = computer.optString("address");
            LinearLayout row = new LinearLayout(context); row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(12), dp(14), dp(10), dp(14)); row.setMinimumHeight(dp(80));
            row.setTag("tabletDevice:" + key); row.setFocusable(true);
            ImageView icon = new ImageView(context); icon.setImageDrawable(new LineIcon("computer", style.secondary));
            icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            LayoutParams iconParams = new LayoutParams(dp(24), dp(24)); iconParams.setMarginEnd(dp(12)); row.addView(icon, iconParams);
            LinearLayout copy = column();
            TextView name = label(listener.name(computer), 15, style.ink); name.setSingleLine(true); name.setEllipsize(android.text.TextUtils.TruncateAt.END);
            copy.addView(name); TextView state = label("", 12, style.secondary); state.setSingleLine(true);
            state.setEllipsize(android.text.TextUtils.TruncateAt.END); copy.addView(state); stateLabels.put(key, state);
            row.addView(copy, new LayoutParams(0, -2, 1));
            TextView chevron = label("›", 22, style.secondary); row.addView(chevron);
            LayoutParams placement = new LayoutParams(-1, -2); placement.bottomMargin = dp(7); rows.addView(row, placement);
            deviceRows.put(key, row); row.setOnClickListener(v -> select(computer));
            if (key.equals(address)) selected = computer;
        }
        if (selected == null && !computers.isEmpty()) selected = computers.get(0);
        if (selected == null) {
            style.emptyState(detail, tr("连接第一台电脑", "Connect your first computer"),
                tr("扫描电脑端的配对码，在平板继续会话。", "Scan the desktop pairing code to continue on your tablet."),
                tr("添加电脑", "Add computer"), listener::add);
        } else select(selected);
        for (JSONObject computer : computers) update(computer.optString("address"));
    }

    private void select(JSONObject computer) {
        selected = computer; listener.selected(computer.optString("address"));
        for (Map.Entry<String, View> entry : deviceRows.entrySet()) {
            boolean active = entry.getKey().equals(computer.optString("address"));
            View view = entry.getValue(); view.setSelected(active);
            var face = style.round(active ? style.card : Color.TRANSPARENT, 13);
            if (active) face.setStroke(dp(1), Color.argb(55, Color.red(style.accent), Color.green(style.accent), Color.blue(style.accent)));
            ((ImageView) ((LinearLayout) view).getChildAt(0)).setImageDrawable(new LineIcon("computer", active ? style.accent : style.secondary));
            view.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), face, style.round(Color.WHITE, 13)));
        }
        renderDetail(); detailScroll.scrollTo(0, 0);
    }

    private void renderDetail() {
        detail.removeAllViews();
        JSONObject computer = selected;
        LinearLayout hero = new LinearLayout(getContext()); hero.setGravity(Gravity.CENTER_VERTICAL);
        ImageView icon = new ImageView(getContext()); icon.setImageDrawable(new LineIcon("computer", style.accent));
        icon.setPadding(dp(12), dp(12), dp(12), dp(12)); icon.setBackground(style.round(style.field, 14));
        LayoutParams iconParams = new LayoutParams(dp(48), dp(48)); iconParams.setMarginEnd(dp(14)); hero.addView(icon, iconParams);
        LinearLayout copy = column(); TextView name = label(listener.name(computer), 24, style.ink); medium(name); name.setPadding(0, 0, 0, 0);
        name.setTag("tabletComputerName"); name.setMaxLines(2); name.setEllipsize(android.text.TextUtils.TruncateAt.END); copy.addView(name);
        detailState = label("", 13, style.secondary); detailState.setPadding(0, dp(4), 0, 0); detailState.setTag("tabletComputerState"); copy.addView(detailState);
        hero.addView(copy, new LayoutParams(0, -2, 1));
        TextView open = action(tr("进入会话", "Open sessions"), "tabletOpenComputer", () -> listener.open(computer));
        open.setTextSize(14); medium(open); open.setTextColor(style.palette().onAccent);
        open.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), style.round(style.accent, 12), style.round(Color.WHITE, 12)));
        LayoutParams openPlacement = new LayoutParams(-2, -2); openPlacement.setMarginStart(dp(16)); hero.addView(open, openPlacement);
        detail.addView(hero, new LayoutParams(-1, -2));
        unavailable = label("", 12, style.palette().warning); unavailable.setPadding(0, dp(12), 0, 0); detail.addView(unavailable);
        LinearLayout connection = group(dp(20));
        LinearLayout header = new LinearLayout(getContext()); header.setGravity(Gravity.CENTER_VERTICAL);
        header.setMinimumHeight(dp(56));
        TextView heading = label(tr("连接信息", "Connection"), 14, style.ink); medium(heading); heading.setPadding(0, 0, 0, 0);
        heading.setGravity(Gravity.CENTER_VERTICAL); heading.setTag("tabletConnectionTitle"); header.addView(heading, new LayoutParams(0, -2, 1));
        TextView test = action(tr("稳定性测试", "Stability test"), "tabletConnectionTest", () -> listener.test(computer));
        test.setTextSize(14); test.setPadding(dp(12), 0, 0, 0); header.addView(test);
        connection.addView(header); connection.addView(divider(), new LayoutParams(-1, Math.max(1, dp(1))));
        LinearLayout facts = new Facts(); facts.setPadding(0, dp(18), 0, dp(18)); facts.setTag("tabletConnectionFacts");
        connectionMethod = fact(facts, tr("连接方式", "Connection"), "tabletConnectionMethod");
        connectionPath = fact(facts, tr("传输路径", "Transport path"), "tabletConnectionPath");
        permission = fact(facts, tr("会话访问", "Session access"), "tabletComputerPermission"); connection.addView(facts);
        TextView management = label(tr("电脑管理", "Computer management"), 14, style.ink); medium(management);
        management.setPadding(0, dp(22), 0, dp(10)); detail.addView(management);
        LinearLayout tiles = new ActionTiles();
        LinearLayout rename = tile(tr("显示名称", "Display name"), listener.name(computer), tr("仅在此设备显示，不修改电脑名称", "Used on this device; the computer's name stays unchanged"),
            "tabletComputerRename", () -> listener.rename(computer));
        tiles.addView(rename, new LayoutParams(-1, -2));
        detail.addView(tiles);
        LinearLayout maintenance = group(dp(16));
        LinearLayout more = new LinearLayout(getContext()); more.setGravity(Gravity.CENTER_VERTICAL); more.setMinimumHeight(dp(54));
        more.setTag("tabletComputerMore"); more.setFocusable(true); more.setContentDescription(tr("更多操作", "More actions"));
        TextView moreTitle = label(tr("更多操作", "More actions"), 14, style.ink); medium(moreTitle);
        more.addView(moreTitle, new LayoutParams(0, -2, 1));
        ImageView arrow = arrow(); arrow.setRotation(expanded ? 90 : 0); more.addView(arrow, new LayoutParams(dp(18), dp(18)));
        more.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), null, style.round(Color.WHITE, 10)));
        more.setOnClickListener(view -> {
            int y = detailScroll.getScrollY(); expanded = !expanded; renderDetail(); detailScroll.post(() -> detailScroll.scrollTo(0, y));
        });
        more.setSelected(expanded); maintenance.addView(more, new LayoutParams(-1, -2));
        restart = null;
        if (expanded) {
            maintenance.addView(divider(), new LayoutParams(-1, Math.max(1, dp(1))));
            TextView lanPin = action(tr("使用 PIN 直连", "Connect with PIN"), "tabletComputerLanPin", () -> listener.lanPin(computer));
            lanPin.setTextSize(14); lanPin.setPadding(0, dp(12), 0, dp(12)); lanPin.setGravity(Gravity.CENTER_VERTICAL); lanPin.setTextColor(style.ink);
            maintenance.addView(lanPin, new LayoutParams(-1, -2));
            restart = action(tr("重启桌面端 Camellia", "Restart desktop Camellia"), "tabletComputerRestart", () -> listener.restart(computer));
            restart.setTextSize(14); restart.setPadding(0, dp(12), 0, dp(12)); restart.setGravity(Gravity.CENTER_VERTICAL); restart.setTextColor(style.ink); maintenance.addView(restart, new LayoutParams(-1, -2));
            TextView forget = action(tr("移除配对", "Forget pairing"), "tabletComputerForget", () -> listener.forget(computer));
            forget.setTextSize(14); forget.setPadding(0, dp(12), 0, dp(12)); forget.setTextColor(style.error); forget.setGravity(Gravity.CENTER_VERTICAL); maintenance.addView(forget, new LayoutParams(-1, -2));
            TextView note = label(tr("移除本机凭据，电脑上的会话不受影响。", "Removes local credentials; conversations on the computer stay intact."), 12, style.secondary);
            note.setPadding(0, 0, 0, dp(14)); maintenance.addView(note);
        }
        update(computer.optString("address"));
    }

    void update(String address) {
        String state = states.getOrDefault(address, tr("待检查", "Not checked"));
        boolean connected = state.equals(tr("已连接", "Connected"));
        TextView row = stateLabels.get(address);
        if (row != null) { row.setText(state); row.setTextColor(connected ? style.palette().success : style.secondary); row.setContentDescription(state); }
        if (selected == null || !address.equals(selected.optString("address")) || detailState == null) return;
        detailState.setText(state); detailState.setTextColor(connected ? style.palette().success : style.secondary);
        String route = connected ? routes.getOrDefault(address, "") : "";
        String[] parts = route.split(" · ", 2);
        connectionMethod.setText(route.isEmpty() ? tr("待确认", "Unconfirmed") : parts[0]);
        connectionPath.setText(parts.length > 1 ? parts[1] : tr("待确认", "Unconfirmed"));
        JSONObject info = connected ? information.get(address) : null;
        String access = info == null ? "" : info.optString("permission");
        permission.setText(access.equals("control") ? tr("完整控制", "Full control") : access.equals("read") || access.equals("readonly")
            ? tr("只读", "Read only") : connected && selected.has("token") ? tr("已配对", "Paired") : tr("待连接确认", "Verify when connected"));
        boolean checking = state.equals(tr("待检查", "Not checked")) || state.equals(tr("正在检查…", "Checking…"));
        unavailable.setText(!connected && !checking ? tr("电脑暂不可用；已缓存的会话与草稿会保留。", "Computer unavailable. Cached conversations and drafts are retained.") : "");
        unavailable.setVisibility(connected || checking ? GONE : VISIBLE);
        TextView open = detail.findViewWithTag("tabletOpenComputer");
        if (open != null) open.setText(connected || checking ? tr("进入会话", "Open sessions") : tr("查看会话", "View sessions"));
        if (restart != null) {
            JSONArray capabilities = info == null ? null : info.optJSONArray("capabilities");
            boolean supported = false;
            for (int i = 0; capabilities != null && i < capabilities.length(); i++) supported |= "desktop-restart".equals(capabilities.optString(i));
            restart.setEnabled(connected && access.equals("control") && supported);
            restart.setAlpha(restart.isEnabled() ? 1f : .45f);
            restart.setContentDescription(tr("重启桌面端 Camellia，需要完整控制权限", "Restart desktop Camellia; requires full control"));
        }
    }

    boolean expanded() { return expanded; }
    private TextView fact(LinearLayout facts, String title, String tag) {
        boolean first = facts.getChildCount() == 0;
        if (!first) facts.addView(divider(), new LayoutParams(Math.max(1, dp(1)), -1));
        LinearLayout column = column(); column.setPadding(first ? 0 : dp(18), 0, dp(12), 0);
        TextView caption = label(title, 12, style.secondary); caption.setPadding(0, 0, 0, 0); caption.setTag(tag + "Label"); column.addView(caption);
        TextView value = label("", 16, style.ink); medium(value); value.setTag(tag); value.setPadding(0, 0, 0, 0);
        LayoutParams placement = new LayoutParams(-1, -2); placement.topMargin = dp(6); column.addView(value, placement);
        facts.addView(column, new LayoutParams(0, -2, 1)); return value;
    }
    private LinearLayout group(int top) {
        LinearLayout group = column(); group.setPadding(dp(18), 0, dp(18), 0);
        var face = style.round(style.card, 14); face.setStroke(dp(1), style.palette().cardBorder); group.setBackground(face);
        LayoutParams placement = new LayoutParams(-1, -2); placement.topMargin = top; detail.addView(group, placement); return group;
    }
    private LinearLayout tile(String title, String value, String note, String tag, Runnable action) {
        LinearLayout result = column(); result.setTag(tag); result.setFocusable(true); result.setMinimumHeight(dp(96));
        result.setPadding(dp(18), dp(16), dp(18), dp(16));
        var face = style.round(style.card, 13); face.setStroke(dp(1), style.palette().cardBorder);
        result.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), face, style.round(Color.WHITE, 13)));
        LinearLayout heading = new LinearLayout(getContext()); heading.setGravity(Gravity.CENTER_VERTICAL); heading.setMinimumHeight(dp(24));
        TextView name = label(title, 14, style.ink); medium(name); name.setTag(tag + "Title"); name.setPadding(0, 0, 0, 0);
        name.setSingleLine(true); name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        heading.addView(name, new LayoutParams(0, -2, 1));
        if (!value.isEmpty()) {
            TextView current = label(value, 14, style.secondary); current.setTag("tabletComputerAlias"); current.setMaxWidth(dp(96));
            current.setMaxLines(1); current.setEllipsize(android.text.TextUtils.TruncateAt.END); current.setPadding(dp(8), 0, dp(8), 0); heading.addView(current);
        }
        heading.addView(arrow(), new LayoutParams(dp(18), dp(18))); result.addView(heading, new LayoutParams(-1, -2));
        TextView description = label(note, 12, style.secondary); description.setTag(tag + "Description"); description.setPadding(0, 0, 0, 0);
        LayoutParams descriptionPlacement = new LayoutParams(-1, -2); descriptionPlacement.topMargin = dp(8); result.addView(description, descriptionPlacement);
        result.setContentDescription(title + (value.isEmpty() ? "" : " · " + value) + " · " + note); result.setOnClickListener(view -> action.run());
        return result;
    }
    private ImageView arrow() {
        ImageView arrow = new ImageView(getContext()); arrow.setImageDrawable(new LineIcon("right", style.secondary));
        arrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); return arrow;
    }
    private final class Facts extends LinearLayout {
        private boolean configured;
        Facts() { super(TabletComputerPane.this.getContext()); }
        @Override protected void onMeasure(int width, int height) {
            float scale = Math.max(1f, getResources().getConfiguration().fontScale / 1.3f);
            int direction = MeasureSpec.getSize(width) >= dp(Math.round(560 * scale)) ? HORIZONTAL : VERTICAL;
            if (!configured || getOrientation() != direction) {
                configured = true; setOrientation(direction);
                for (int index = 0; index < getChildCount(); index++) {
                    View child = getChildAt(index); LayoutParams placement = (LayoutParams) child.getLayoutParams();
                    if (child instanceof LinearLayout) {
                        LinearLayout fact = (LinearLayout) child; boolean wide = direction == HORIZONTAL;
                        fact.setOrientation(wide ? VERTICAL : HORIZONTAL); fact.setGravity(Gravity.CENTER_VERTICAL);
                        fact.setMinimumHeight(wide ? 0 : dp(56));
                        fact.setPadding(wide && index > 0 ? dp(18) : 0, wide ? 0 : dp(10), wide ? dp(12) : 0, wide ? 0 : dp(10));
                        placement.width = wide ? 0 : -1; placement.height = -2; placement.weight = wide ? 1 : 0;
                        TextView caption = (TextView) fact.getChildAt(0), value = (TextView) fact.getChildAt(1);
                        LayoutParams captionPlacement = (LayoutParams) caption.getLayoutParams();
                        captionPlacement.width = wide ? -1 : 0; captionPlacement.weight = wide ? 0 : .44f;
                        LayoutParams valuePlacement = (LayoutParams) value.getLayoutParams();
                        valuePlacement.width = wide ? -1 : 0; valuePlacement.weight = wide ? 0 : .56f;
                        valuePlacement.topMargin = wide ? dp(6) : 0; valuePlacement.setMarginStart(wide ? 0 : dp(12));
                        value.setGravity(wide ? Gravity.START : Gravity.END);
                        caption.setLayoutParams(captionPlacement); value.setLayoutParams(valuePlacement);
                    } else {
                        placement.width = direction == HORIZONTAL ? Math.max(1, dp(1)) : -1;
                        placement.height = direction == HORIZONTAL ? -1 : Math.max(1, dp(1));
                    }
                    child.setLayoutParams(placement);
                }
            }
            super.onMeasure(width, height);
        }
    }
    private final class ActionTiles extends LinearLayout {
        private boolean configured;
        ActionTiles() { super(TabletComputerPane.this.getContext()); }
        @Override protected void onMeasure(int width, int height) {
            float scale = Math.max(1f, getResources().getConfiguration().fontScale / 1.3f);
            int direction = MeasureSpec.getSize(width) >= dp(Math.round(560 * scale)) ? HORIZONTAL : VERTICAL;
            if (!configured || getOrientation() != direction) {
                configured = true; setOrientation(direction);
                for (int i = 0; i < getChildCount(); i++) {
                    LayoutParams placement = (LayoutParams) getChildAt(i).getLayoutParams();
                    placement.width = direction == HORIZONTAL ? 0 : -1; placement.height = direction == HORIZONTAL ? -1 : -2;
                    placement.weight = direction == HORIZONTAL ? 1 : 0; placement.topMargin = 0;
                    placement.setMarginStart(0); placement.setMarginEnd(0);
                    if (i > 0) { if (direction == HORIZONTAL) placement.setMarginStart(dp(12)); else placement.topMargin = dp(12); }
                    getChildAt(i).setLayoutParams(placement);
                }
            }
            super.onMeasure(width, height);
        }
    }
    private View divider() { View line = new View(getContext()); line.setBackgroundColor(style.divider); return line; }
    private void medium(TextView text) { text.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); }
    private TextView action(String title, String tag, Runnable action) {
        TextView result = label(title, 13, style.accent); result.setTag(tag); result.setGravity(Gravity.CENTER); result.setMinHeight(dp(48));
        result.setPadding(dp(12), dp(8), dp(12), dp(8)); result.setFocusable(true);
        result.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), null, style.round(Color.WHITE, 10)));
        result.setOnClickListener(v -> action.run()); return result;
    }
    private LinearLayout column() { LinearLayout view = new LinearLayout(getContext()); view.setOrientation(VERTICAL); return view; }
    private TextView label(String value, int size, int color) { TextView view = style.label(value, size, color); view.setPadding(0, dp(3), 0, dp(3)); return view; }
    private int dp(int value) { return style.dp(value); }
    private String tr(String zh, String en) { return chinese ? zh : en; }
}
