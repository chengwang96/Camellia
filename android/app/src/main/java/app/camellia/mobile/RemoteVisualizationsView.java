package app.camellia.mobile;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.LinkedHashMap;
import java.util.Map;

/** Compact native entries for interactive cards; the HTML opens in one dedicated WebView. */
@SuppressLint("ViewConstructor")
final class RemoteVisualizationsView extends LinearLayout {
    interface Opener { void open(JSONObject card); }

    private final ChatStyle style;
    private final boolean chinese;

    RemoteVisualizationsView(Context context, ChatStyle style, JSONArray cards, boolean chinese, Opener open) {
        super(context);
        this.style = style;
        this.chinese = chinese;
        setOrientation(VERTICAL);
        setTag("remoteVisualizations");
        if (cards == null || cards.length() == 0) {
            setVisibility(GONE);
            return;
        }
        Map<String, JSONObject> latest = new LinkedHashMap<>();
        for (int index = 0; index < cards.length(); index++) {
            JSONObject card = cards.optJSONObject(index);
            if (card == null) continue;
            String cardId = card.optString("cardId");
            if (cardId.isEmpty()) continue;
            JSONObject current = latest.get(cardId);
            if (current == null || card.optInt("revision", 1) >= current.optInt("revision", 1)) latest.put(cardId, card);
        }
        if (latest.isEmpty()) {
            setVisibility(GONE);
            return;
        }
        TextView heading = text(tr("交互卡片", "INTERACTIVE CARDS"), Palette.TEXT_SMALL, style.muted);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setLetterSpacing(.06f);
        heading.setPadding(style.dp(2), style.dp(8), 0, style.dp(6));
        addView(heading, new LinearLayout.LayoutParams(-1, -2));
        int index = 0;
        for (JSONObject card : latest.values()) {
            addView(card(card, open), rowParams(index++ == latest.size() - 1));
        }
    }

    private LinearLayout.LayoutParams rowParams(boolean last) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        if (!last) params.bottomMargin = style.dp(7);
        return params;
    }

    private View card(JSONObject card, Opener open) {
        String cardId = card.optString("cardId");
        String title = card.optString("title", tr("交互卡片", "Interactive card"));
        String summary = card.optString("summary", "").trim();
        int revision = Math.max(1, card.optInt("revision", 1));
        String kind = card.optString("mode").equals("wide") ? tr("宽卡片", "Wide card") : tr("卡片", "Card");

        LinearLayout row = new LinearLayout(getContext());
        row.setOrientation(HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(style.dp(12), style.dp(10), style.dp(10), style.dp(10));
        row.setTag("visualizationCard:" + cardId);
        row.setFocusable(true);
        row.setClickable(true);
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(style.surface);
        shape.setCornerRadius(style.dp(15));
        shape.setStroke(style.dp(1), style.floatingBarEdge());
        row.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_PAGE), shape,
            shape(android.graphics.Color.WHITE, 15)));
        row.setContentDescription(title + (summary.isEmpty() ? "" : " · " + summary) + " · "
            + tr("打开卡片", "Open card"));
        row.setOnClickListener(view -> open.open(card));

        TextView mark = text("◇", 18, style.accent);
        mark.setGravity(Gravity.CENTER);
        mark.setBackground(style.rounded(style.background));
        row.addView(mark, new LinearLayout.LayoutParams(style.dp(38), style.dp(38)));

        LinearLayout info = new LinearLayout(getContext());
        info.setOrientation(VERTICAL);
        LinearLayout.LayoutParams infoParams = new LinearLayout.LayoutParams(0, -2, 1);
        infoParams.setMarginStart(style.dp(10));
        row.addView(info, infoParams);
        TextView name = text(title, Palette.TEXT_ROW, style.ink);
        name.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        name.setMaxLines(1);
        name.setEllipsize(TextUtils.TruncateAt.END);
        info.addView(name);
        if (!summary.isEmpty()) {
            TextView detail = text(summary, Palette.TEXT_SMALL, style.muted);
            detail.setMaxLines(2);
            detail.setEllipsize(TextUtils.TruncateAt.END);
            detail.setPadding(0, style.dp(3), 0, 0);
            info.addView(detail);
        }
        TextView meta = text(kind + " · v" + revision, Palette.TEXT_SMALL, style.faint);
        meta.setPadding(0, style.dp(4), 0, 0);
        info.addView(meta);

        TextView action = text(tr("打开", "Open"), Palette.TEXT_SMALL, style.accent);
        action.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        action.setGravity(Gravity.CENTER);
        action.setMinHeight(style.dp(44));
        action.setPadding(style.dp(10), 0, style.dp(6), 0);
        row.addView(action, new LinearLayout.LayoutParams(-2, -2));
        return row;
    }

    private TextView text(String value, int size, int color) {
        TextView text = new TextView(getContext());
        text.setText(value);
        text.setTextSize(size);
        text.setTextColor(color);
        return text;
    }

    private GradientDrawable shape(int color, int radius) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(style.dp(radius));
        return shape;
    }

    private String tr(String zh, String en) { return chinese ? zh : en; }
}
