package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;

/** Persistent conversation switcher shown beside chat on a wide landscape screen. */
@android.annotation.SuppressLint("ViewConstructor")
final class ConversationSidebar extends LinearLayout {
    interface Listener {
        void open(Item item);
        void all();
        void refresh();
    }

    static final class Item {
        final String id, title, engine, detail;
        final String workspace, activity;
        final int statusColor;
        final boolean selected, unread;

        Item(String id, String title, String engine, String detail, int statusColor, boolean selected, boolean unread) {
            this(id, title, engine, detail, statusColor, selected, unread, "", "");
        }

        Item(String id, String title, String engine, String detail, int statusColor, boolean selected, boolean unread, String workspace, String activity) {
            this.id = id; this.title = title; this.engine = engine; this.detail = detail;
            this.statusColor = statusColor; this.selected = selected; this.unread = unread;
            this.workspace = workspace; this.activity = activity;
        }
    }

    private final Context context;
    private final boolean chinese;
    private final Listener listener;
    private final Palette palette;
    private final ScrollView scroll;
    private final LinearLayout rows;
    private final TextView count;
    private String selectedId = "";
    private List<Item> allItems = java.util.Collections.emptyList();
    private final android.widget.EditText search;
    private final java.util.Set<String> collapsed = new java.util.LinkedHashSet<>();
    private String filter = "all";

    ConversationSidebar(Context context, boolean chinese, List<Item> items, Listener listener) {
        super(context);
        this.context = context; this.chinese = chinese; this.listener = listener;
        palette = Palette.of(context);
        setOrientation(VERTICAL);
        setTag("detailConversationSidebar");
        setBackgroundColor(palette.background);
        setClipChildren(true);
        setClipToPadding(true);

        LinearLayout header = new LinearLayout(context);
        header.setTag("sidebarHeader");
        header.setBackgroundColor(palette.background);
        header.setTranslationZ(dp(1));
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(14), dp(8), dp(8), dp(4));
        TextView title = label(tr("会话", "Conversations"), Palette.TEXT_TITLE, palette.ink);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        header.addView(title, new LayoutParams(0, -2, 1));
        count = label("", Palette.TEXT_SMALL, palette.muted);
        count.setGravity(Gravity.CENTER);
        count.setMinHeight(dp(32));
        count.setPadding(dp(6), 0, dp(6), 0);
        header.addView(count, new LayoutParams(-2, -2));
        TextView all = label(tr("全部", "All"), Palette.TEXT_SMALL, palette.accent);
        all.setTag("sidebarAllConversations");
        all.setGravity(Gravity.CENTER);
        all.setMinHeight(dp(48));
        all.setPadding(dp(10), 0, dp(10), 0);
        all.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), null,
            rounded(Color.WHITE)));
        all.setOnClickListener(view -> listener.all());
        header.addView(all, new LayoutParams(-2, dp(48)));
        addView(header, new LayoutParams(-1, -2));

        View divider = new View(context);
        divider.setBackgroundColor(palette.separator);
        LayoutParams dividerParams = new LayoutParams(-1, Math.max(1, dp(1)));
        dividerParams.setMargins(dp(14), 0, dp(10), 0);
        addView(divider, dividerParams);

        search = new EditorInput(context); search.setSingleLine(true); search.setTextSize(13);
        search.setTextColor(palette.ink); search.setHintTextColor(palette.muted);
        search.setHint(tr("筛选当前列表", "Filter this list")); search.setContentDescription(tr("筛选当前会话列表", "Filter current conversation list"));
        search.setTag("sidebarSearch"); search.setBackground(rounded(palette.field));
        search.setPadding(dp(12), 0, dp(12), 0);
        LayoutParams searchParams = new LayoutParams(-1, dp(48)); searchParams.setMargins(dp(10), dp(10), dp(10), dp(4));
        addView(search, searchParams);
        search.addTextChangedListener(new android.text.TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void afterTextChanged(android.text.Editable s) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) { paintItems(); }
        });

        scroll = ScrollViews.plain(context);
        scroll.setTag("sidebarScroll");
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setClipChildren(true);
        scroll.setClipToPadding(true);
        scroll.setBackgroundColor(palette.background);
        rows = new LinearLayout(context);
        rows.setOrientation(VERTICAL);
        rows.setPadding(0, dp(6), 0, dp(12));
        scroll.addView(rows);
        addView(scroll, new LayoutParams(-1, 0, 1));
        update(items);
    }

    void update(List<Item> items) {
        allItems = new java.util.ArrayList<>(items);
        paintItems();
    }

    private void paintItems() {
        if (rows == null) return;
        String query = search.getText().toString().trim().toLowerCase(java.util.Locale.ROOT);
        List<Item> items = new java.util.ArrayList<>();
        for (Item item : allItems) {
            if (!(item.title + " " + item.detail + " " + item.workspace).toLowerCase(java.util.Locale.ROOT).contains(query)) continue;
            if (filter.equals("running") && !item.activity.equals("running")) continue;
            if (filter.equals("waiting") && !item.activity.equals("permission") && !item.activity.equals("question")) continue;
            items.add(item);
        }
        int position = scroll.getScrollY();
        rows.removeAllViews();
        count.setText(items.isEmpty() ? "" : String.valueOf(items.size()));
        selectedId = "";
        LinearLayout filters = new LinearLayout(context);
        if (allItems.stream().anyMatch(item -> !item.activity.isEmpty())) {
            String[][] options = {{"all", "全部", "All"}, {"running", "运行中", "Running"}, {"waiting", "待处理", "Waiting"}};
            for (String[] option : options) {
                TextView chip = label(chinese ? option[1] : option[2], Palette.TEXT_SMALL, option[0].equals(filter) ? palette.accent : palette.muted);
                chip.setGravity(Gravity.CENTER); chip.setMinHeight(dp(48)); chip.setTag("sidebarFilter:" + option[0]);
                chip.setFocusable(true); chip.setSelected(option[0].equals(filter));
                chip.setOnClickListener(v -> { filter = option[0]; paintItems(); });
                filters.addView(chip, new LayoutParams(0, dp(48), 1));
            }
            rows.addView(filters);
        }
        if (items.isEmpty()) {
            TextView empty = label(query.isEmpty() && filter.equals("all") ? tr("暂无可切换的会话", "No conversations available")
                : tr("没有匹配的会话，当前对话保持打开。", "No matches. The current conversation stays open."), Palette.TEXT_BODY, palette.muted);
            empty.setPadding(dp(14), dp(18), dp(14), dp(8));
            rows.addView(empty);
            TextView refresh = label(tr("刷新会话", "Refresh conversations"), Palette.TEXT_SMALL, palette.accent);
            refresh.setGravity(Gravity.CENTER);
            refresh.setMinHeight(dp(48));
            refresh.setTag("sidebarRefresh");
            refresh.setText(query.isEmpty() && filter.equals("all") ? tr("刷新会话", "Refresh conversations") : tr("清除筛选", "Clear filters"));
            refresh.setOnClickListener(view -> { if (!query.isEmpty() || !filter.equals("all")) { filter = "all"; search.setText(""); paintItems(); } else listener.refresh(); });
            rows.addView(refresh, new LayoutParams(-1, dp(48)));
            return;
        }
        java.util.Map<String, java.util.List<Item>> grouped = new java.util.LinkedHashMap<>();
        for (Item item : items) grouped.computeIfAbsent(item.workspace, key -> new java.util.ArrayList<>()).add(item);
        items = new java.util.ArrayList<>();
        for (List<Item> group : grouped.values()) items.addAll(group);
        String workspace = null;
        for (Item item : items) {
            if (!item.workspace.isEmpty() && !item.workspace.equals(workspace)) {
                workspace = item.workspace; String group = workspace;
                TextView heading = label((collapsed.contains(group) ? "›  " : "⌄  ") + group, Palette.TEXT_SMALL, palette.muted);
                heading.setMinHeight(dp(48)); heading.setGravity(Gravity.CENTER_VERTICAL); heading.setPadding(dp(14), 0, dp(10), 0);
                heading.setTag("sidebarWorkspace:" + group); heading.setFocusable(true);
                heading.setOnClickListener(v -> { if (!collapsed.add(group)) collapsed.remove(group); paintItems(); }); rows.addView(heading);
            }
            if (collapsed.contains(item.workspace)) continue;
            View row = conversation(item);
            rows.addView(row);
            View divider = new View(context);
            divider.setBackgroundColor(palette.separator);
            LayoutParams dividerParams = new LayoutParams(-1, Math.max(1, dp(1)));
            dividerParams.setMargins(dp(52), 0, dp(10), 0);
            rows.addView(divider, dividerParams);
        }
        scroll.post(() -> {
            scroll.scrollTo(0, position);
        });
    }

    int scrollY() {
        return scroll.getScrollY();
    }

    android.os.Bundle saveState() {
        android.os.Bundle saved = new android.os.Bundle(); saved.putString("query", search.getText().toString()); saved.putString("filter", filter);
        saved.putStringArrayList("collapsed", new java.util.ArrayList<>(collapsed)); saved.putInt("scroll", scroll.getScrollY()); return saved;
    }

    void restoreState(android.os.Bundle saved) {
        if (saved == null) return; filter = saved.getString("filter", "all");
        java.util.ArrayList<String> groups = saved.getStringArrayList("collapsed"); if (groups != null) collapsed.addAll(groups);
        search.setText(saved.getString("query", "")); paintItems(); restoreScroll(saved.getInt("scroll"));
    }

    void restoreScroll(int position) {
        scroll.post(() -> scroll.scrollTo(0, Math.max(0, position)));
    }

    private View conversation(Item item) {
        LinearLayout row = new LinearLayout(context);
        row.setOrientation(HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(64));
        row.setPadding(dp(12), dp(8), dp(10), dp(8));
        row.setTag("sidebarConversation:" + item.id);
        row.setContentDescription(item.title + " · " + item.detail);
        row.setFocusable(true);
        if (item.selected) {
            selectedId = item.id;
            row.setSelected(true);
        }
        GradientDrawable face = new GradientDrawable();
        face.setColor(item.selected
            ? Color.argb(22, Color.red(palette.accent), Color.green(palette.accent), Color.blue(palette.accent))
            : Color.TRANSPARENT);
        face.setCornerRadius(dp(12));
        row.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), face,
            rounded(Color.WHITE)));
        AgentBadge badge = new AgentBadge(context, item.engine, 28);
        LayoutParams badgeParams = new LayoutParams(dp(28), dp(28));
        badgeParams.setMarginEnd(dp(10));
        row.addView(badge, badgeParams);

        LinearLayout copy = new LinearLayout(context);
        copy.setOrientation(VERTICAL);
        row.addView(copy, new LayoutParams(0, -2, 1));
        LinearLayout headline = new LinearLayout(context);
        headline.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = label(item.title, Palette.TEXT_ROW, palette.ink);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.END);
        headline.addView(title, new LayoutParams(0, -2, 1));
        if (item.unread) {
            View dot = new View(context);
            GradientDrawable dotFace = rounded(palette.accent);
            dot.setBackground(dotFace);
            LayoutParams dotParams = new LayoutParams(dp(7), dp(7));
            dotParams.setMarginStart(dp(7));
            headline.addView(dot, dotParams);
        }
        copy.addView(headline, new LayoutParams(-1, -2));

        LinearLayout detailLine = new LinearLayout(context);
        detailLine.setGravity(Gravity.CENTER_VERTICAL);
        detailLine.setPadding(0, dp(2), 0, 0);
        if (item.statusColor != 0) {
            View dot = new View(context);
            dot.setBackground(rounded(item.statusColor));
            LayoutParams dotParams = new LayoutParams(dp(6), dp(6));
            dotParams.setMarginEnd(dp(5));
            detailLine.addView(dot, dotParams);
        }
        TextView detail = label(item.detail, Palette.TEXT_TINY,
            item.statusColor == 0 ? palette.muted : item.statusColor);
        detail.setSingleLine(true);
        detail.setEllipsize(TextUtils.TruncateAt.END);
        detailLine.addView(detail, new LayoutParams(0, -2, 1));
        copy.addView(detailLine, new LayoutParams(-1, -2));

        row.setOnClickListener(view -> listener.open(item));
        return row;
    }

    private TextView label(String value, int size, int color) {
        TextView text = new TextView(context);
        text.setText(value);
        text.setTextSize(size);
        text.setTextColor(color);
        text.setIncludeFontPadding(false);
        return text;
    }

    private GradientDrawable rounded(int color) {
        GradientDrawable face = new GradientDrawable();
        face.setColor(color);
        face.setCornerRadius(dp(999));
        return face;
    }

    private String tr(String zh, String en) {
        return chinese ? zh : en;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
