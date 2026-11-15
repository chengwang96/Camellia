package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.InsetDrawable;
import android.graphics.drawable.RippleDrawable;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.view.Gravity;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.function.Supplier;

final class ChatStyle {
    final int background, surface, ink, muted, faint, accent;
    private final Context context;
    private final Palette palette;

    ChatStyle(Context context) {
        this.context = context;
        this.palette = Palette.of(context);
        background = palette.background;
        surface = palette.surface;
        ink = palette.ink;
        muted = palette.muted;
        faint = palette.faint;
        accent = palette.accent;
    }

    int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }

    int dockBottomPadding() { return dp(8); }

    void dockStatus(TextView status) {
        status.setPadding(0, dp(2), 0, dp(2)); status.setTextSize(11); status.setGravity(Gravity.CENTER);
        status.setSingleLine(true); status.setLines(1); status.setEllipsize(android.text.TextUtils.TruncateAt.END);
        status.setAccessibilityLiveRegion(android.view.View.ACCESSIBILITY_LIVE_REGION_POLITE);
    }

    int dockFadeHeight() { return dp(36); }

    android.graphics.drawable.Drawable dockBackdrop() {
        return new DockBackdrop(background, dockFadeHeight());
    }

    android.view.View dockFade(String tag) {
        android.view.View fade = new android.view.View(context);
        fade.setTag(tag + "Fade");
        fade.setImportantForAccessibility(android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        fade.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
            new int[] {Color.TRANSPARENT, (background & 0x00ffffff) | 0x28000000,
                (background & 0x00ffffff) | 0xb8000000, background}));
        return fade;
    }

    GradientDrawable rounded(int color) {
        GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(Palette.RADIUS_CARD)); return shape;
    }

    android.graphics.drawable.Drawable pageBackground() { return palette.pageBackground(); }

    GradientDrawable capsule(int color) {
        GradientDrawable shape = rounded(color); shape.setCornerRadius(dp(Palette.RADIUS_CAPSULE)); return shape;
    }

    GradientDrawable outlinedCapsule(int color) {
        GradientDrawable shape = capsule(color);
        shape.setStroke(dp(1), palette.cardBorder);
        return shape;
    }

    private GradientDrawable circle(int color) {
        GradientDrawable shape = new GradientDrawable();
        shape.setShape(GradientDrawable.OVAL);
        shape.setColor(color);
        return shape;
    }

    void raised(android.view.View view, int elevationDp) {
        SurfaceElevation.apply(view, elevationDp);
    }

    GradientDrawable floatingBar(android.view.View view) {
        GradientDrawable shape = capsule(palette.card); shape.setStroke(dp(1), floatingBarEdge());
        view.setBackground(shape); view.setElevation(dp(4)); view.setTranslationZ(dp(1));
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            view.setOutlineAmbientShadowColor(0x12000000); view.setOutlineSpotShadowColor(0x28000000);
        }
        return shape;
    }

    int floatingBarEdge() { return palette.separator; }

    ColorStateList enabledColors(int enabled, int disabled) {
        return new ColorStateList(new int[][] {{-android.R.attr.state_enabled}, {}}, new int[] {disabled, enabled});
    }

    ImageButton lineButton(String icon, String label, Runnable action) {
        ImageButton button = new ImageButton(context); button.setImageDrawable(new LineIcon(icon, accent));
        button.setContentDescription(label); button.setTooltipText(label); button.setPadding(dp(12), dp(12), dp(12), dp(12));
        button.setMinimumWidth(dp(48)); button.setMinimumHeight(dp(48));
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_PAGE),
            null, circle(Color.WHITE)));
        button.setElevation(0f);
        button.setOnClickListener(view -> action.run()); return button;
    }

    ImageButton accentButton(String icon, String label, Runnable action) {
        ImageButton button = new ImageButton(context); button.setImageDrawable(new LineIcon(icon, ink));
        button.setContentDescription(label); button.setTooltipText(label); button.setPadding(dp(13), dp(13), dp(13), dp(13));
        GradientDrawable face = new GradientDrawable();
        face.setColor(Color.argb(22, Color.red(accent), Color.green(accent), Color.blue(accent)));
        face.setCornerRadius(dp(999));
        face.setStroke(dp(1), Color.argb(60, Color.red(accent), Color.green(accent), Color.blue(accent)));
        GradientDrawable mask = capsule(Color.WHITE);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), face, mask));
        raised(button, 2);
        button.setOnClickListener(view -> action.run()); return button;
    }

    /** An icon-only composer tool: the surrounding composer is the control surface. */
    ImageButton composerToolButton(String icon, String label, int color, Runnable action) {
        ImageButton button = new ImageButton(context);
        button.setImageDrawable(new LineIcon(icon, color));
        button.setContentDescription(label); button.setTooltipText(label);
        button.setPadding(dp(12), dp(12), dp(12), dp(12));
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_PAGE),
            null, capsule(Color.WHITE)));
        button.setMinimumWidth(dp(48)); button.setMinimumHeight(dp(48));
        button.setOnClickListener(view -> action.run());
        return button;
    }

    LinearLayout workspaceHeader(String title, String label, String tag, Runnable action) {
        LinearLayout header = new LinearLayout(context); header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(0, dp(12), 0, 0);
        TextView heading = new TextView(context); heading.setText(title); heading.setTextSize(Palette.TEXT_CARD); heading.setTextColor(ink);
        heading.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        ImageButton create = composerToolButton("add", label, accent, action); create.setTag(tag);
        header.addView(create, new LinearLayout.LayoutParams(dp(48), dp(48)));
        return header;
    }

    ImageButton backButton(String label, Runnable action) {
        ImageButton button = new ImageButton(context); button.setImageDrawable(new LineIcon("back", accent));
        button.setContentDescription(label); button.setTooltipText(label); button.setTag("pageBack");
        button.setPadding(dp(14), dp(14), dp(14), dp(14)); button.setMinimumWidth(dp(48)); button.setMinimumHeight(dp(48));
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_PAGE),
            null, circle(Color.WHITE)));
        button.setElevation(0f);
        button.setOnClickListener(view -> action.run()); return button;
    }

    ImageButton composerAction(String label, int icon, Runnable action) {
        ImageButton button = new ImageButton(context); button.setImageResource(icon);
        button.setContentDescription(label); button.setTooltipText(label); button.setPadding(dp(14), dp(14), dp(14), dp(14));
        GradientDrawable enabledFace = circle(accent);
        GradientDrawable disabledFace = circle(palette.controlFill);
        android.graphics.drawable.StateListDrawable faces = new android.graphics.drawable.StateListDrawable();
        int inset = dp(5);
        faces.addState(new int[]{-android.R.attr.state_enabled},
            new InsetDrawable(disabledFace, inset, inset, inset, inset));
        faces.addState(new int[]{}, new InsetDrawable(enabledFace, inset, inset, inset, inset));
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_ACCENT_LIGHT),
            faces, new InsetDrawable(circle(Color.WHITE), inset, inset, inset, inset)));
        button.setImageTintList(enabledColors(Color.WHITE, muted));
        button.setElevation(0f);
        button.setOnClickListener(view -> action.run()); return button;
    }

    void reserveDockSpace(android.view.View dock, android.view.View content) {
        int bottomPadding = content.getPaddingBottom();
        dock.addOnLayoutChangeListener((view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            int reserved = bottomPadding + bottom - top;
            if (content.getPaddingBottom() != reserved) {
                content.setPadding(content.getPaddingLeft(), content.getPaddingTop(), content.getPaddingRight(), reserved);
            }
        });
    }

    LinearLayout messageBlock(boolean user) {
        LinearLayout block = new LinearLayout(context); block.setOrientation(LinearLayout.VERTICAL);
        block.setPadding(user ? dp(14) : 0, dp(8), user ? dp(14) : 0, dp(12));
        if (user) {
            GradientDrawable bubble = rounded(palette.userBubble);
            bubble.setCornerRadius(dp(Palette.RADIUS_USER_BUBBLE)); block.setBackground(bubble);
        }
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(user ? -2 : -1, -2);
        params.gravity = user ? android.view.Gravity.END : android.view.Gravity.START;
        params.setMargins(user ? dp(Palette.BUBBLE_INSET) : 0, dp(6), 0, dp(16)); block.setLayoutParams(params);
        return block;
    }

    void messageTypography(TextView view) {
        var metrics = context.getResources().getDisplayMetrics();
        float base = android.os.Build.VERSION.SDK_INT >= 34
            ? android.util.TypedValue.deriveDimension(android.util.TypedValue.COMPLEX_UNIT_SP, view.getTextSize(), metrics)
            : view.getTextSize() / metrics.scaledDensity;
        view.setTextSize(MobilePreferences.chatTextSize(context, base));
        view.setLineSpacing(dp(7), 1);
    }

    LinearLayout messageWithFooter(LinearLayout block, boolean user, Supplier<String> content, long at, boolean chinese) {
        LinearLayout wrapper = new LinearLayout(context); wrapper.setOrientation(LinearLayout.VERTICAL);
        wrapper.setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams bubbleParams = (LinearLayout.LayoutParams) block.getLayoutParams();
        bubbleParams.bottomMargin = 0; wrapper.addView(block);
        LinearLayout footer = new LinearLayout(context); footer.setGravity(Gravity.CENTER_VERTICAL);
        footer.setTag("messageFooter");
        LinearLayout.LayoutParams footerParams = new LinearLayout.LayoutParams(user ? -2 : -1, dp(48));
        footerParams.gravity = user ? Gravity.END : Gravity.START; footerParams.bottomMargin = dp(18);
        String label = chinese ? "复制消息" : "Copy message";
        ImageButton copy = composerToolButton("copy", label, faint, () -> {
            String value = content.get();
            if (value == null || value.isEmpty()) return;
            ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(ClipData.newPlainText(label, value));
            if (android.os.Build.VERSION.SDK_INT < 33) Toast.makeText(context, chinese ? "已复制" : "Copied", Toast.LENGTH_SHORT).show();
        });
        copy.setTag("copyMessage");
        footer.addView(copy, new LinearLayout.LayoutParams(dp(48), dp(48)));
        wrapper.addView(footer, footerParams); updateMessageTimestamp(wrapper, at, chinese); return wrapper;
    }

    void updateMessageTimestamp(LinearLayout wrapper, long at, boolean chinese) {
        LinearLayout footer = wrapper.findViewWithTag("messageFooter");
        TextView time = wrapper.findViewWithTag("messageTimestamp");
        if (at <= 0) { if (time != null) footer.removeView(time); return; }
        if (time == null) {
            time = new TextView(context); time.setTextColor(faint); time.setTextSize(Palette.TEXT_SMALL); time.setTag("messageTimestamp"); footer.addView(time);
            time.setMaxLines(1); time.setEllipsize(android.text.TextUtils.TruncateAt.END);
        }
        time.setText(new SimpleDateFormat(chinese ? "M月d日 HH:mm" : "MMM d, HH:mm", chinese ? Locale.CHINA : Locale.ENGLISH).format(new Date(at)));
    }
}
