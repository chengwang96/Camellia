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
        final int statusColor;
        final boolean selected, unread;

        Item(String id, String title, String engine, String detail, int statusColor, boolean selected, boolean unread) {
            this.id = id; this.title = title; this.engine = engine; this.detail = detail;
            this.statusColor = statusColor; this.selected = selected; this.unread = unread;
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

        scroll = new ScrollView(context);
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
        int position = scroll.getScrollY();
        rows.removeAllViews();
        count.setText(items.isEmpty() ? "" : String.valueOf(items.size()));
        selectedId = "";
        if (items.isEmpty()) {
            TextView empty = label(tr("暂无可切换的会话", "No conversations available"), Palette.TEXT_BODY, palette.muted);
            empty.setPadding(dp(14), dp(18), dp(14), dp(8));
            rows.addView(empty);
            TextView refresh = label(tr("刷新会话", "Refresh conversations"), Palette.TEXT_SMALL, palette.accent);
            refresh.setGravity(Gravity.CENTER);
            refresh.setMinHeight(dp(48));
            refresh.setTag("sidebarRefresh");
            refresh.setOnClickListener(view -> listener.refresh());
            rows.addView(refresh, new LayoutParams(-1, dp(48)));
            return;
        }
        for (Item item : items) {
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
