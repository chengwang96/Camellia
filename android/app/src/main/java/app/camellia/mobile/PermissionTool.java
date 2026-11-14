package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Permission selector beside the composer attachment action. */
@android.annotation.SuppressLint("ViewConstructor")
final class PermissionTool extends LinearLayout {
    private final Context context;
    private final ChatStyle style;
    private final boolean chinese;
    private final boolean expanded;
    private final LineGlyphView icon;
    private final TextView label;

    PermissionTool(Context context, ChatStyle style, boolean chinese, boolean expanded, Runnable action) {
        super(context);
        this.context = context; this.style = style; this.chinese = chinese; this.expanded = expanded;
        setOrientation(HORIZONTAL);
        setGravity(Gravity.CENTER);
        setFocusable(true);
        setMinimumHeight(dp(48));
        setPadding(dp(expanded ? 12 : 0), 0, dp(expanded ? 12 : 0), 0);
        setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), null,
            style.capsule(Color.WHITE)));
        setOnClickListener(view -> action.run());

        FrameLayout iconDisc = new FrameLayout(context);
        iconDisc.setTag("permissionIconDisc");
        iconDisc.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);

        icon = new LineGlyphView(context, "shield", style.ink);
        icon.setTag("permissionIcon");
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        iconDisc.addView(icon, new FrameLayout.LayoutParams(dp(22), dp(22), Gravity.CENTER));
        addView(iconDisc, new LayoutParams(dp(34), dp(34)));

        label = new TextView(context);
        label.setTag("permissionLabel");
        label.setTextSize(Palette.TEXT_SMALL);
        label.setTextColor(style.ink);
        label.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        label.setSingleLine(true);
        label.setEllipsize(TextUtils.TruncateAt.END);
        label.setIncludeFontPadding(false);
        label.setVisibility(expanded ? VISIBLE : GONE);
        label.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LayoutParams labelParams = new LayoutParams(-2, -2);
        labelParams.setMarginStart(dp(6));
        addView(label, labelParams);
    }

    void level(String level, boolean enabled) {
        boolean full = level != null && level.equals("full");
        int color = full ? Palette.PERMISSION_STRICT : style.ink;
        icon.glyph("shield", color);
        label.setText(expanded ? shortLabel(level, chinese) : "");
        label.setTextColor(color);
        setEnabled(enabled);
        setAlpha(enabled ? 1f : .45f);
        String description = (chinese ? "安全级别：" : "Safety level: ")
            + RemoteSettingsPopup.permissionLabel(level == null ? "ask" : level, chinese);
        setContentDescription(description);
        setTooltipText(description);
    }

    TextView labelView() {
        return label;
    }

    View iconView() {
        return icon;
    }

    static String shortLabel(String level, boolean chinese) {
        if (level != null && level.equals("full")) return chinese ? "全自动" : "Full";
        if (level != null && level.equals("auto")) return chinese ? "默认" : "Default";
        return chinese ? "需确认" : "Ask";
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
