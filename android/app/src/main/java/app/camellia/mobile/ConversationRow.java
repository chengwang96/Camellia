package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

@android.annotation.SuppressLint("ViewConstructor")
final class ConversationRow extends LinearLayout {
    private android.graphics.drawable.GradientDrawable face;
    private final Palette palette;
    private boolean selecting;
    ConversationRow(Context context, ChatStyle style, boolean grouped, String title, String state,
                    String tag, String stateTag, Runnable open, Runnable actions) {
        this(context, style, grouped, "", title, "", state, style.accent, "", tag, stateTag, open, actions);
    }

    ConversationRow(Context context, ChatStyle style, boolean grouped, String engine, String title, String state, int statusColor,
                    String tag, String stateTag, Runnable open, Runnable actions) {
        this(context, style, grouped, engine, title, RemoteEngines.label(engine), state, statusColor, "", tag, stateTag, open, actions);
    }

    ConversationRow(Context context, ChatStyle style, boolean grouped, String engine, String title, String subtitle,
                    String state, int statusColor, String time, String tag, String stateTag, Runnable open, Runnable actions) {
        super(context);
        palette = Palette.of(context);
        setOrientation(HORIZONTAL); setGravity(Gravity.CENTER_VERTICAL);
        setMinimumHeight(dp(68));
        setPadding(dp(14), dp(8), dp(12), dp(8));
        face = rounded(palette.card, Palette.RADIUS_CARD);
        face.setStroke(dp(1), palette.cardBorder);
        setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), face, rounded(Color.WHITE, Palette.RADIUS_CARD)));
        setElevation(dp(1));
        setOutlineProvider(new android.view.ViewOutlineProvider() {
            @Override public void getOutline(View view, android.graphics.Outline outline) {
                outline.setRoundRect(0, 0, view.getWidth(), view.getHeight(), dp(Palette.RADIUS_CARD));
            }
        });
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            setOutlineAmbientShadowColor(0x10000000); setOutlineSpotShadowColor(0x1c000000);
        }
        setTag(tag); setFocusable(true); setContentDescription(title + (state.isEmpty() ? "" : " · " + state));
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(-1, -2);
        rowParams.setMargins(0, 0, 0, dp(6));
        setLayoutParams(rowParams);
        AgentBadge badge = new AgentBadge(context, engine, 28);
        LinearLayout.LayoutParams badgeParams = new LinearLayout.LayoutParams(dp(28), dp(28));
        badgeParams.setMarginEnd(dp(10));
        addView(badge, badgeParams);
        LinearLayout copy = new LinearLayout(context); copy.setOrientation(VERTICAL);
        addView(copy, new LayoutParams(0, -2, 1));
        LinearLayout headline = new LinearLayout(context); headline.setOrientation(HORIZONTAL);
        headline.setGravity(Gravity.CENTER_VERTICAL); headline.setBaselineAligned(false);
        copy.addView(headline, new LayoutParams(-1, -2));
        TextView name = new TextView(context); name.setText(title); name.setTextSize(Palette.TEXT_ROW); name.setTextColor(style.ink);
        name.setTag("conversationRowTitle");
        name.setSingleLine(true); name.setGravity(Gravity.CENTER_VERTICAL);
        name.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
        name.setEllipsize(TextUtils.TruncateAt.END); headline.addView(name, new LayoutParams(0, -2, 1));
        if (!state.isEmpty()) {
            StatusPill pill = new StatusPill(context, state, statusColor);
            pill.setTag(stateTag);
            LinearLayout.LayoutParams pillParams = new LayoutParams(-2, -2);
            pillParams.setMarginStart(dp(8));
            headline.addView(pill, pillParams);
        }
        if ((subtitle != null && !subtitle.isEmpty()) || (time != null && !time.isEmpty())) {
            LinearLayout metaLine = new LinearLayout(context);
            metaLine.setGravity(Gravity.CENTER_VERTICAL);
            metaLine.setPadding(0, dp(3), 0, 0);
            TextView contextLine = new TextView(context);
            contextLine.setText(subtitle == null ? "" : subtitle);
            contextLine.setTextSize(Palette.TEXT_TINY);
            contextLine.setTextColor(style.muted);
            contextLine.setSingleLine(true);
            contextLine.setEllipsize(TextUtils.TruncateAt.END);
            contextLine.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            contextLine.setTag("conversationRowMeta");
            metaLine.addView(contextLine, new LayoutParams(0, -2, 1));
            if (time != null && !time.isEmpty()) {
                TextView timestamp = new TextView(context);
                timestamp.setText(time);
                timestamp.setTextSize(Palette.TEXT_TINY);
                timestamp.setTextColor(style.muted);
                timestamp.setSingleLine(true);
                timestamp.setTag("conversationRowTime");
                timestamp.setPadding(dp(8), 0, 0, 0);
                timestamp.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
                metaLine.addView(timestamp);
            }
            copy.addView(metaLine, new LayoutParams(-1, -2));
        }
        setOnClickListener(view -> open.run());
        MobileHaptics.setOnLongClickListener(this, view -> { actions.run(); return true; });
    }

    void selection(boolean active, boolean selected) {
        selecting = active;
        if (!active) return;
        SelectionMark mark = new SelectionMark(getContext(), false);
        mark.setChecked(selected);
        LayoutParams params = new LayoutParams(dp(22), dp(22));
        params.setMarginEnd(dp(10));
        addView(mark, 0, params);
        setSelected(selected);
        setContentDescription(getContentDescription() + (selected ? " · ✓" : " · ○"));
    }

    void activeConversation(boolean selected) {
        if (selecting) return; // The checked selection owns this state during bulk actions.
        setSelected(selected);
        face.setStroke(dp(1), selected ? palette.accent : palette.cardBorder);
    }

    private android.graphics.drawable.GradientDrawable rounded(int color, int radiusDp) {
        android.graphics.drawable.GradientDrawable shape = new android.graphics.drawable.GradientDrawable();
        shape.setColor(color); shape.setCornerRadius(dp(radiusDp)); return shape;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
