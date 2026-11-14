package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/** The four-destination phone navigation; it becomes the future tablet rail. */
@android.annotation.SuppressLint("ViewConstructor")
final class WorkbenchNavigation extends LinearLayout {
    WorkbenchNavigation(Context context, String selected, Runnable home, Runnable sessions, Runnable computers, Runnable settings) {
        super(context);
        Palette palette = Palette.of(context);
        setOrientation(HORIZONTAL);
        setGravity(Gravity.CENTER);
        setPadding(dp(4), dp(4), dp(4), dp(4));
        setMinimumHeight(dp(64));
        setTag("workbenchNav");
        GradientDrawable face = new GradientDrawable();
        face.setColor(palette.card);
        face.setCornerRadius(dp(Palette.RADIUS_NAVIGATION));
        setBackground(face);
        setElevation(dp(4));
        addItem("home", "home", "工作台", "Workbench", selected, home, palette);
        addItem("sessions", "sessions", "会话", "Sessions", selected, sessions, palette);
        addItem("computers", "computer", "电脑", "Computers", selected, computers, palette);
        addItem("settings", "settings", "设置", "Settings", selected, settings, palette);
    }

    private void addItem(String id, String icon, String zh, String en, String selected, Runnable action, Palette palette) {
        boolean active = id.equals(selected);
        LinearLayout item = new LinearLayout(getContext());
        item.setOrientation(VERTICAL);
        item.setGravity(Gravity.CENTER);
        item.setMinimumHeight(dp(48));
        item.setTag("nav:" + id);
        item.setFocusable(true);
        item.setContentDescription(chinese() ? zh : en);
        GradientDrawable selectedFace = new GradientDrawable();
        selectedFace.setColor(active ? Color.argb(24, Color.red(palette.accent), Color.green(palette.accent), Color.blue(palette.accent))
            : Color.TRANSPARENT);
        selectedFace.setCornerRadius(dp(Palette.RADIUS_NAVIGATION));
        item.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), selectedFace,
            new ColorDrawable(Color.WHITE)));
        int color = active ? palette.accent : palette.muted;
        ImageView image = new ImageView(getContext());
        image.setImageDrawable(new LineIcon(icon, color));
        image.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        item.addView(image, new LayoutParams(dp(22), dp(22)));
        TextView label = new TextView(getContext());
        label.setText(chinese() ? zh : en);
        label.setTextSize(10);
        label.setIncludeFontPadding(false);
        label.setTextColor(color);
        label.setGravity(Gravity.CENTER);
        label.setSingleLine(true);
        label.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LayoutParams labelParams = new LayoutParams(-2, -2);
        labelParams.topMargin = dp(2);
        item.addView(label, labelParams);
        item.setOnClickListener(view -> action.run());
        LayoutParams params = new LayoutParams(0, dp(56), 1);
        addView(item, params);
    }

    private boolean chinese() {
        return getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
