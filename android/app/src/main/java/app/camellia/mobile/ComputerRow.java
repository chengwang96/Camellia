package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

@android.annotation.SuppressLint("ViewConstructor")
final class ComputerRow extends LinearLayout {
    private final SettingsStyle style;
    private final String name, address;
    private final TextView state;
    private final View presence;

    ComputerRow(Context context, SettingsStyle style, boolean chinese, String name, String address, Runnable open, Runnable manage) {
        super(context); this.style = style; this.name = name; this.address = address;
        setOrientation(HORIZONTAL); setGravity(Gravity.CENTER_VERTICAL); setMinimumHeight(dp(84));
        setPadding(dp(18), dp(14), dp(16), dp(14)); setTag("computer:" + address); setFocusable(true);
        setBackground(new RippleDrawable(ColorStateList.valueOf(0x184176e6), null, new ColorDrawable(Color.WHITE)));
        setOnClickListener(view -> open.run());

        FrameLayout symbol = new FrameLayout(context);
        symbol.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        ImageView icon = new ImageView(context); icon.setImageDrawable(new LineIcon("computer", style.ink));
        symbol.addView(icon, new FrameLayout.LayoutParams(dp(28), dp(28), Gravity.CENTER));
        presence = new View(context); presence.setTag("computerPresence:" + address);
        symbol.addView(presence, new FrameLayout.LayoutParams(dp(12), dp(12), Gravity.TOP | Gravity.END));
        addView(symbol, new LayoutParams(dp(32), dp(32)));

        LinearLayout copy = new LinearLayout(context); copy.setOrientation(VERTICAL);
        copy.setPadding(dp(12), 0, dp(12), 0);
        TextView title = new TextView(context); title.setText(name); title.setTextSize(17); title.setTextColor(style.ink);
        title.setTag("computerName:" + address); title.setMaxLines(2); title.setEllipsize(TextUtils.TruncateAt.END);
        title.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); copy.addView(title, new LayoutParams(-1, -2));
        state = new TextView(context); state.setTextSize(12); state.setPadding(0, dp(4), 0, 0);
        state.setTag("computerState:" + address); state.setMaxLines(2); state.setEllipsize(TextUtils.TruncateAt.END);
        state.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); copy.addView(state, new LayoutParams(-1, -2));
        addView(copy, new LayoutParams(0, -2, 1));

        TextView action = new TextView(context); action.setText(chinese ? "管理" : "Manage"); action.setTextSize(14);
        action.setTextColor(style.ink); action.setGravity(Gravity.CENTER); action.setMinHeight(dp(48)); action.setMinWidth(dp(60));
        action.setPadding(dp(14), 0, dp(14), 0); action.setSingleLine(true); action.setFocusable(true);
        action.setTag("manage:" + address); action.setContentDescription((chinese ? "管理电脑" : "Manage computer") + " · " + name);
        GradientDrawable face = new GradientDrawable(); face.setColor(style.background); face.setCornerRadius(dp(18));
        GradientDrawable mask = new GradientDrawable(); mask.setColor(Color.WHITE); mask.setCornerRadius(dp(18));
        action.setBackground(new RippleDrawable(ColorStateList.valueOf(0x184176e6),
            new android.graphics.drawable.InsetDrawable(face, 0, dp(6), 0, dp(6)),
            new android.graphics.drawable.InsetDrawable(mask, 0, dp(6), 0, dp(6))));
        action.setOnClickListener(view -> manage.run()); addView(action, new LayoutParams(-2, dp(48)));
    }

    void state(String label, boolean online, boolean checking) {
        state.setText(label); state.setTextColor(online || checking ? style.secondary : style.error);
        GradientDrawable dot = new GradientDrawable(); dot.setShape(GradientDrawable.OVAL);
        dot.setColor(online ? 0xff27b56d : checking ? style.secondary : style.error);
        dot.setStroke(dp(2), style.card); presence.setBackground(dot);
        setContentDescription(name + ", " + label + ", " + address);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
