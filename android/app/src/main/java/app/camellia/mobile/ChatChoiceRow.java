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
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

@android.annotation.SuppressLint("ViewConstructor")
final class ChatChoiceRow extends LinearLayout {
    ChatChoiceRow(Context context, boolean chinese, int ink, int muted, int accent,
                  String title, String description, String icon, boolean selected, String tag, Runnable action) {
        super(context);
        setGravity(Gravity.CENTER_VERTICAL); setPadding(dp(16), dp(14), dp(14), dp(14)); setMinimumHeight(dp(64));
        setTag(tag); setFocusable(true); setSelected(selected);
        GradientDrawable mask = new GradientDrawable(); mask.setColor(Color.WHITE); mask.setCornerRadius(dp(18));
        setBackground(new RippleDrawable(ColorStateList.valueOf((accent & 0xffffff) | 0x18000000), null, mask));
        LinearLayout words = new LinearLayout(context); words.setOrientation(VERTICAL);
        TextView name = label(title, 17, ink); name.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        name.setMaxLines(2); words.addView(name);
        if (!description.isEmpty()) {
            TextView detail = label(description, 12, muted); detail.setMaxLines(3); detail.setPadding(0, dp(5), 0, 0); words.addView(detail);
        }
        addView(words, new LayoutParams(0, -2, 1));
        if (selected) {
            TextView check = label("✓", 22, accent); check.setGravity(Gravity.CENTER);
            check.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); addView(check, new LayoutParams(dp(32), dp(32)));
        } else if (icon != null) {
            ImageView arrow = new ImageView(context); arrow.setImageDrawable(new LineIcon(icon, muted));
            arrow.setPadding(dp(4), dp(4), dp(4), dp(4)); arrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            addView(arrow, new LayoutParams(dp(26), dp(26)));
        }
        setContentDescription(title + (description.isEmpty() ? "" : ", " + description) + (selected ? chinese ? "，已选择" : ", selected" : ""));
        setOnClickListener(view -> action.run());
    }

    private TextView label(String value, int size, int color) {
        TextView label = new TextView(getContext()); label.setText(value); label.setTextSize(size); label.setTextColor(color);
        label.setLineSpacing(dp(3), 1); label.setEllipsize(TextUtils.TruncateAt.END); return label;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
