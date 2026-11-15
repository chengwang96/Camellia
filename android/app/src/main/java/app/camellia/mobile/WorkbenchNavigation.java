package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/** The four-destination phone navigation; it becomes the future tablet rail. */
@android.annotation.SuppressLint("ViewConstructor")
final class WorkbenchNavigation extends FrameLayout {
    static final int HEIGHT_DP = 64;
    static final int CONTENT_GAP_DP = 8;
    static final int SHADOW_GAP_DP = 4;
    private final PopupSurface glass;
    private View backdropSource;
    private int capturedWidth, capturedHeight;

    WorkbenchNavigation(Context context, String selected, Runnable home, Runnable sessions, Runnable computers, Runnable settings) {
        super(context);
        Palette palette = Palette.of(context);
        setMinimumHeight(dp(HEIGHT_DP));
        setTag("workbenchNav");
        GradientDrawable face = new GradientDrawable();
        face.setColor(palette.card);
        face.setCornerRadius(dp(Palette.RADIUS_NAVIGATION));
        setBackground(face);
        setClipToOutline(true);
        setElevation(dp(6));
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            setOutlineAmbientShadowColor(0x40000000);
            setOutlineSpotShadowColor(0x30000000);
        }
        glass = PopupSurface.navigation(context, palette.card);
        glass.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        addView(glass, new FrameLayout.LayoutParams(-1, -1));
        LinearLayout items = new LinearLayout(context);
        items.setGravity(Gravity.CENTER);
        items.setPadding(dp(4), dp(4), dp(4), dp(4));
        addView(items, new FrameLayout.LayoutParams(-1, -1));
        addItem(items, "home", "home", "工作台", "Workbench", selected, home, palette);
        addItem(items, "sessions", "sessions", "会话", "Sessions", selected, sessions, palette);
        addItem(items, "computers", "computer", "电脑", "Computers", selected, computers, palette);
        addItem(items, "settings", "settings", "设置", "Settings", selected, settings, palette);
    }

    void setBackdropSource(View source) {
        backdropSource = source;
        capturedWidth = capturedHeight = 0;
        requestLayout();
    }

    @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        super.onLayout(changed, left, top, right, bottom);
        if (backdropSource == null || getWidth() <= 0 || getHeight() <= 0
            || (capturedWidth == getWidth() && capturedHeight == getHeight())) return;
        capturedWidth = getWidth(); capturedHeight = getHeight();
        int[] position = new int[2]; getLocationOnScreen(position);
        // Capture only the backdrop sibling, never this glass or its buttons.
        glass.capture(backdropSource, position[0], position[1], capturedWidth, capturedHeight);
    }

    private void addItem(LinearLayout items, String id, String icon, String zh, String en, String selected, Runnable action, Palette palette) {
        boolean active = id.equals(selected);
        LinearLayout item = new LinearLayout(getContext());
        item.setOrientation(LinearLayout.VERTICAL);
        item.setGravity(Gravity.CENTER);
        item.setMinimumHeight(dp(48));
        item.setTag("nav:" + id);
        item.setFocusable(true);
        item.setSelected(active);
        item.setContentDescription(chinese() ? zh : en);
        GradientDrawable selectedFace = new GradientDrawable();
        // A light tonal overlay lets the shared glass remain visible rather
        // than replacing it with a nearly opaque grey tile.
        selectedFace.setColor(active ? (palette.dark ? 0x24ffffff : 0x1c000000) : Color.TRANSPARENT);
        selectedFace.setCornerRadius(dp(Palette.RADIUS_NAVIGATION_ITEM));
        GradientDrawable rippleMask = new GradientDrawable();
        rippleMask.setColor(Color.WHITE);
        rippleMask.setCornerRadius(dp(Palette.RADIUS_NAVIGATION_ITEM));
        item.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), selectedFace,
            rippleMask));
        int color = active ? palette.accent : (palette.dark ? 0xffe1e3e8 : 0xff292c32);
        ImageView image = new ImageView(getContext());
        image.setImageDrawable(new LineIcon(icon, color));
        image.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        item.addView(image, new LinearLayout.LayoutParams(dp(24), dp(24)));
        TextView label = new TextView(getContext());
        label.setText(chinese() ? zh : en);
        label.setTextSize(11);
        label.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
        label.setIncludeFontPadding(false);
        label.setTextColor(color);
        label.setGravity(Gravity.CENTER);
        label.setSingleLine(true);
        label.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(-2, -2);
        labelParams.topMargin = dp(2);
        item.addView(label, labelParams);
        item.setOnClickListener(view -> action.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(56), 1);
        items.addView(item, params);
    }

    private boolean chinese() {
        return getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
