package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.TextView;

@android.annotation.SuppressLint("ViewConstructor")
final class ConversationRow extends LinearLayout {
    private final LinearLayout copy;
    private final ChatStyle style;
    ConversationRow(Context context, ChatStyle style, boolean grouped, String title, String state,
                    String tag, String stateTag, Runnable open, Runnable actions) {
        super(context);
        this.style = style;
        setOrientation(HORIZONTAL); setGravity(Gravity.CENTER_VERTICAL);
        setPadding(dp(grouped ? 32 : 2), dp(8), dp(8), dp(8));
        setBackground(new RippleDrawable(ColorStateList.valueOf(0x224176e6), style.rounded(style.background), style.rounded(Color.WHITE)));
        setTag(tag); setFocusable(true); setContentDescription(title + (state.isEmpty() ? "" : " · " + state));
        copy = new LinearLayout(context); copy.setOrientation(VERTICAL);
        addView(copy, new LayoutParams(0, -2, 1));
        LinearLayout headline = new LinearLayout(context); headline.setOrientation(HORIZONTAL);
        headline.setGravity(Gravity.CENTER_VERTICAL); headline.setBaselineAligned(false);
        copy.addView(headline, new LayoutParams(-1, -2));
        TextView name = new TextView(context); name.setText(title); name.setTextSize(16); name.setTextColor(style.ink);
        name.setTag("conversationRowTitle");
        name.setSingleLine(true); name.setMinHeight(dp(36)); name.setGravity(Gravity.CENTER_VERTICAL);
        name.setEllipsize(TextUtils.TruncateAt.END); headline.addView(name, new LayoutParams(0, -2, 1));
        if (!state.isEmpty()) {
            TextView badge = new TextView(context); badge.setText(state); badge.setTextSize(12); badge.setTextColor(style.accent);
            badge.setTag(stateTag); badge.setMaxWidth(dp(152)); badge.setSingleLine(true); badge.setEllipsize(TextUtils.TruncateAt.END);
            badge.setGravity(Gravity.END | Gravity.CENTER_VERTICAL); badge.setPadding(dp(8), 0, 0, 0);
            headline.addView(badge, new LayoutParams(-2, -2));
        }
        setOnClickListener(view -> open.run());
        setOnLongClickListener(view -> { actions.run(); return true; });
    }

    void preview(ConversationPreview preview) {
        if (preview == null) return;
        LinearLayout chip = new LinearLayout(getContext()); chip.setGravity(Gravity.CENTER_VERTICAL);
        chip.setPadding(dp(10), dp(7), dp(10), dp(7)); chip.setBackground(style.rounded(style.surface));
        chip.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        android.widget.ImageView icon = new android.widget.ImageView(getContext());
        icon.setImageDrawable(new LineIcon(preview.image ? "image" : "file", style.muted));
        chip.addView(icon, new LayoutParams(dp(18), dp(18)));
        TextView filename = new TextView(getContext()); filename.setText(preview.name); filename.setTextSize(13); filename.setTextColor(style.muted);
        filename.setSingleLine(true); filename.setEllipsize(TextUtils.TruncateAt.MIDDLE); filename.setTag("conversationFilePreview");
        filename.setPadding(dp(7), 0, 0, 0); chip.addView(filename, new LayoutParams(0, -2, 1));
        if (preview.count > 1) {
            TextView count = new TextView(getContext()); count.setText("+" + (preview.count - 1)); count.setTextSize(12); count.setTextColor(style.muted);
            count.setPadding(dp(8), 0, 0, 0); chip.addView(count);
        }
        LayoutParams params = new LayoutParams(-1, -2); params.topMargin = dp(3); params.bottomMargin = dp(4);
        copy.addView(chip, params);
        setContentDescription(getContentDescription() + " · " + preview.name + (preview.count > 1 ? " +" + (preview.count - 1) : ""));
    }

    void selection(boolean active, boolean selected) {
        if (!active) return;
        CheckBox check = new CheckBox(getContext()); check.setChecked(selected);
        check.setClickable(false); check.setFocusable(false);
        check.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        check.setButtonTintList(ColorStateList.valueOf(new ChatStyle(getContext()).accent));
        addView(check, 0, new LayoutParams(dp(40), dp(40)));
        setSelected(selected);
        setContentDescription(getContentDescription() + (selected ? " · ✓" : " · ○"));
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
