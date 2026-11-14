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
    ChatChoiceRow(Context context, boolean chinese, int ink, int muted,
                  String title, String description, String icon, boolean selected, String tag, Runnable action) {
        super(context);
        Palette palette = Palette.of(context);
        setGravity(Gravity.CENTER_VERTICAL); setPadding(dp(14), dp(9), dp(12), dp(9)); setMinimumHeight(dp(54));
        setTag(tag); setFocusable(true); setSelected(selected);
        GradientDrawable face = new GradientDrawable();
        face.setColor(selected ? palette.controlFill : Color.TRANSPARENT);
        face.setCornerRadius(dp(Palette.RADIUS_FIELD));
        GradientDrawable mask = new GradientDrawable(); mask.setColor(Color.WHITE); mask.setCornerRadius(dp(Palette.RADIUS_FIELD));
        setBackground(new RippleDrawable(ColorStateList.valueOf((ink & 0xffffff) | 0x18000000), face, mask));
        setClipToOutline(true);
        setLayoutParams(new LayoutParams(-1, -2));
        LinearLayout words = new LinearLayout(context); words.setOrientation(VERTICAL);
        TextView name = label(title, Palette.TEXT_ROW_STRONG, ink); name.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        name.setSingleLine(true); words.addView(name);
        if (!description.isEmpty()) {
            TextView detail = label(description, Palette.TEXT_SMALL, muted); detail.setMaxLines(3); detail.setPadding(0, dp(3), 0, 0); words.addView(detail);
        }
        addView(words, new LayoutParams(0, -2, 1));
        if (selected) {
            SelectionMark check = new SelectionMark(context, true);
            check.setChecked(true);
            LayoutParams checkParams = new LayoutParams(dp(22), dp(22));
            checkParams.setMarginStart(dp(10));
            addView(check, checkParams);
        } else if (icon != null) {
            ImageView arrow = new ImageView(context); arrow.setImageDrawable(new LineIcon(icon, muted));
            arrow.setPadding(dp(4), dp(4), dp(4), dp(4)); arrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            addView(arrow, new LayoutParams(dp(26), dp(26)));
        }
        setContentDescription(title + (description.isEmpty() ? "" : ", " + description) + (selected ? chinese ? "，已选择" : ", selected" : ""));
        setTooltipText(title + (description.isEmpty() ? "" : "\n" + description));
        setOnClickListener(view -> action.run());
    }

    private TextView label(String value, int size, int color) {
        TextView label = new TextView(getContext()); label.setText(value); label.setTextSize(size); label.setTextColor(color);
        label.setLineSpacing(dp(3), 1); label.setEllipsize(TextUtils.TruncateAt.END); return label;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
