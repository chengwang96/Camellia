package app.camellia.mobile;

import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.TextView;

/** One action appearance for settings, local/remote chat, tasks and dialogs. */
final class ActionStyle {
    private ActionStyle() {}

    static void page(TextView view, boolean primary) {
        apply(view, primary, Palette.TEXT_BODY, 48, Palette.RADIUS_CAPSULE);
    }

    static void dialog(TextView view, boolean primary) {
        apply(view, primary, Palette.TEXT_ROW, 52, Palette.RADIUS_DIALOG_ACTION);
    }

    static void apply(TextView view, boolean primary, int textSize, int height, int radius) {
        SettingsStyle style = new SettingsStyle(view.getContext());
        Palette palette = style.palette();
        view.setAllCaps(false); view.setTextSize(textSize);
        view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        view.setGravity(Gravity.CENTER); view.setMinHeight(style.dp(height)); view.setMinimumHeight(style.dp(height));
        view.setPadding(style.dp(16), style.dp(10), style.dp(16), style.dp(10));
        view.setTextColor(new ColorStateList(new int[][]{{-android.R.attr.state_enabled}, {}},
            new int[]{palette.muted, primary ? palette.onAccent : palette.ink}));
        view.setBackgroundTintList(null);
        GradientDrawable enabled = style.round(primary ? palette.accent : palette.card, radius);
        enabled.setStroke(style.dp(1), primary ? palette.accent : palette.cardBorder);
        GradientDrawable disabled = style.round(palette.field, radius); disabled.setStroke(style.dp(1), palette.cardBorder);
        StateListDrawable states = new StateListDrawable();
        states.addState(new int[]{-android.R.attr.state_enabled}, disabled); states.addState(new int[]{}, enabled);
        RippleDrawable ripple = new RippleDrawable(ColorStateList.valueOf(primary ? Palette.RIPPLE_ON_ACCENT_LIGHT : Palette.RIPPLE_ON_CARD),
            states, style.round(Color.WHITE, radius));
        view.setBackground(ripple);
        view.setFocusable(true); SurfaceElevation.apply(view, primary ? 2 : 1);
        // Initialise the nested selector before the first draw as well as on
        // subsequent enabled-state changes.
        view.refreshDrawableState();
        ripple.getDrawable(0).setState(view.getDrawableState());
        ripple.jumpToCurrentState();
        view.setAccessibilityDelegate(new View.AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View host, android.view.accessibility.AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info); info.setClassName("android.widget.Button");
            }
        });
    }
}
