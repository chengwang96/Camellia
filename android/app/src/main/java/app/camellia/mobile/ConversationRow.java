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
    ConversationRow(Context context, ChatStyle style, boolean grouped, String title, String state,
                    String tag, String stateTag, Runnable open, Runnable actions) {
        super(context);
        setOrientation(HORIZONTAL); setGravity(Gravity.CENTER_VERTICAL);
        setPadding(dp(grouped ? 32 : 2), dp(8), dp(8), dp(8));
        setBackground(new RippleDrawable(ColorStateList.valueOf(0x224176e6), style.rounded(style.background), style.rounded(Color.WHITE)));
        setTag(tag); setFocusable(true); setContentDescription(title + (state.isEmpty() ? "" : " · " + state));
        TextView name = new TextView(context); name.setText(title); name.setTextSize(15); name.setTextColor(style.ink);
        name.setMaxLines(2); name.setMinHeight(dp(36)); name.setGravity(Gravity.CENTER_VERTICAL);
        name.setEllipsize(TextUtils.TruncateAt.END); addView(name, new LayoutParams(0, -2, 1));
        if (!state.isEmpty()) {
            TextView badge = new TextView(context); badge.setText(state); badge.setTextSize(12); badge.setTextColor(style.accent);
            badge.setTag(stateTag); badge.setMaxWidth(dp(152)); badge.setMaxLines(2); badge.setEllipsize(TextUtils.TruncateAt.END);
            badge.setGravity(Gravity.END | Gravity.CENTER_VERTICAL); badge.setPadding(dp(8), 0, 0, 0);
            addView(badge, new LayoutParams(-2, -2));
        }
        setOnClickListener(view -> open.run());
        setOnLongClickListener(view -> { actions.run(); return true; });
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
