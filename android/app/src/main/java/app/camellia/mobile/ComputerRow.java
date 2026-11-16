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
    private final boolean chinese;
    private final String name, address;
    private final TextView state, route;
    private final View presence;
    private String stateDescription = "";

    ComputerRow(Context context, SettingsStyle style, boolean chinese, String name, String address, Runnable open, Runnable manage) {
        super(context); this.style = style; this.chinese = chinese; this.name = name; this.address = address;
        setOrientation(HORIZONTAL); setGravity(Gravity.CENTER_VERTICAL); setMinimumHeight(dp(84));
        setPadding(dp(18), dp(14), dp(16), dp(14)); setTag("computer:" + address); setFocusable(true);
        setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), null, new ColorDrawable(Color.WHITE)));
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
        TextView title = new TextView(context); title.setText(name); title.setTextSize(Palette.TEXT_ROW_STRONG); title.setTextColor(style.ink);
        title.setTag("computerName:" + address); title.setMaxLines(2); title.setEllipsize(TextUtils.TruncateAt.END);
        title.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); copy.addView(title, new LayoutParams(-1, -2));
        LinearLayout statusLine = new LinearLayout(context); statusLine.setOrientation(HORIZONTAL);
        statusLine.setGravity(Gravity.CENTER_VERTICAL); statusLine.setPadding(0, dp(4), 0, 0);
        state = new TextView(context); state.setTextSize(Palette.TEXT_SMALL);
        state.setTag("computerState:" + address); state.setMaxLines(2); state.setEllipsize(TextUtils.TruncateAt.END);
        state.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        statusLine.addView(state, new LinearLayout.LayoutParams(0, -2, 1));
        route = new TextView(context); route.setTextSize(Palette.TEXT_NOTE);
        route.setTag("computerRoute:" + address); route.setMaxLines(1); route.setEllipsize(TextUtils.TruncateAt.END);
        route.setTextColor(style.secondary); route.setVisibility(GONE);
        LinearLayout.LayoutParams routeParams = new LinearLayout.LayoutParams(-2, -2);
        routeParams.setMargins(dp(10), 0, 0, 0); statusLine.addView(route, routeParams);
        copy.addView(statusLine, new LayoutParams(-1, -2));
        addView(copy, new LayoutParams(0, -2, 1));

        TextView action = new TextView(context); action.setText(chinese ? "管理" : "Manage"); action.setTextSize(Palette.TEXT_BODY);
        action.setTextColor(style.accent); action.setGravity(Gravity.CENTER); action.setMinHeight(dp(48)); action.setMinWidth(dp(60));
        action.setPadding(dp(14), 0, dp(14), 0); action.setSingleLine(true); action.setFocusable(true);
        action.setTag("manage:" + address); action.setContentDescription((chinese ? "管理电脑" : "Manage computer") + " · " + name);
        GradientDrawable face = new GradientDrawable();
        face.setColor(android.graphics.Color.argb(20, android.graphics.Color.red(style.accent),
            android.graphics.Color.green(style.accent), android.graphics.Color.blue(style.accent)));
        face.setCornerRadius(dp(Palette.RADIUS_FIELD));
        GradientDrawable mask = new GradientDrawable(); mask.setColor(Color.WHITE); mask.setCornerRadius(dp(Palette.RADIUS_FIELD));
        action.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD),
            new android.graphics.drawable.InsetDrawable(face, 0, dp(6), 0, dp(6)),
            new android.graphics.drawable.InsetDrawable(mask, 0, dp(6), 0, dp(6))));
        action.setOnClickListener(view -> manage.run()); addView(action, new LayoutParams(-2, dp(48)));
    }

    void state(String label, boolean online, boolean checking) {
        stateDescription = label;
        state.setText(online || checking ? label : (chinese ? "连接失败" : "Connection failed"));
        state.setTextColor(online || checking ? style.secondary : style.error);
        GradientDrawable dot = new GradientDrawable(); dot.setShape(GradientDrawable.OVAL);
        dot.setColor(online ? Palette.ONLINE : checking ? style.secondary : style.error);
        dot.setStroke(dp(2), style.card); presence.setBackground(dot);
        describe(label);
    }

    void route(String label) {
        boolean visible = label != null && !label.isEmpty();
        route.setText(label); route.setVisibility(visible ? VISIBLE : GONE);
        state.setMaxLines(visible ? 1 : 2);
        describe(stateDescription);
    }

    private void describe(String label) {
        String path = route.getVisibility() == VISIBLE ? route.getText().toString() : "";
        setContentDescription(name + ", " + label + (path.isEmpty() ? "" : ", " + path) + ", " + address);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
