package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

@android.annotation.SuppressLint("ViewConstructor")
final class ChatEmptyState extends LinearLayout {
    private final ChatStyle style;

    ChatEmptyState(Context context, ChatStyle style, String icon, String title, String description) {
        this(context, style, icon, title, description, "", null);
    }

    ChatEmptyState(Context context, ChatStyle style, String icon, String title, String description,
                   String actionLabel, Runnable action) {
        super(context); setOrientation(VERTICAL); setGravity(Gravity.CENTER); setTag("chatEmptyState");
        this.style = style;
        setPadding(style.dp(20), style.dp(24), style.dp(20), style.dp(24));
        ImageView mark = new ImageView(context);
        if (icon.equals("brand")) mark.setImageResource(R.drawable.desktop_logo);
        else { mark.setImageDrawable(new LineIcon(icon, style.muted)); mark.setPadding(style.dp(8), style.dp(8), style.dp(8), style.dp(8)); }
        mark.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        addView(mark, new LayoutParams(style.dp(52), style.dp(52)));
        TextView heading = new TextView(context); heading.setText(title); heading.setTextColor(style.ink); heading.setTextSize(21);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); heading.setGravity(Gravity.CENTER);
        heading.setPadding(0, style.dp(20), 0, style.dp(8));
        if (android.os.Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        addView(heading, new LayoutParams(-1, -2));
        TextView hint = new TextView(context); hint.setText(description); hint.setTextColor(style.muted); hint.setTextSize(14);
        hint.setGravity(Gravity.CENTER); hint.setLineSpacing(style.dp(4), 1); addView(hint, new LayoutParams(-1, -2));
        if (action != null && !actionLabel.isEmpty()) addAction(actionLabel, "emptyStateAction", action);
    }

    void addAction(String label, String tag, Runnable action) {
        TextView button = new TextView(getContext()); button.setText(label); button.setTextColor(style.ink); button.setTextSize(15);
        button.setGravity(Gravity.CENTER); button.setMinHeight(style.dp(48)); button.setPadding(style.dp(20), style.dp(10), style.dp(20), style.dp(10));
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(0x224176e6), style.capsule(style.surface), style.capsule(Color.WHITE)));
        button.setFocusable(true); button.setTag(tag); button.setOnClickListener(view -> action.run());
        LayoutParams params = new LayoutParams(-2, -2); params.topMargin = style.dp(12); addView(button, params);
    }
}
