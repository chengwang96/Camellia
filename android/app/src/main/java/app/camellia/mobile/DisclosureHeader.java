package app.camellia.mobile;

import android.content.Context;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

@android.annotation.SuppressLint("ViewConstructor")
final class DisclosureHeader extends LinearLayout {
    private final TextView title;

    DisclosureHeader(Context context, String name, int textColor, int iconColor, boolean collapsed) {
        super(context);
        setGravity(Gravity.CENTER_VERTICAL);
        setMinimumHeight(dp(48));
        setFocusable(true);
        title = new TextView(context);
        title.setText(name);
        title.setTextSize(16);
        title.setTextColor(textColor);
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.END);
        title.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        addView(title, new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT));
        ImageView arrow = new ImageView(context);
        arrow.setImageDrawable(new LineIcon(collapsed ? "right" : "down", iconColor));
        arrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LayoutParams arrowParams = new LayoutParams(dp(18), dp(18));
        arrowParams.setMarginStart(dp(6));
        addView(arrow, arrowParams);
        setContentDescription(name);
    }

    void setTypeface(android.graphics.Typeface typeface) { title.setTypeface(typeface); }

    @Override protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        title.setMaxWidth(MeasureSpec.getMode(widthMeasureSpec) == MeasureSpec.UNSPECIFIED ? Integer.MAX_VALUE
            : Math.max(0, MeasureSpec.getSize(widthMeasureSpec) - getPaddingLeft() - getPaddingRight() - dp(24)));
        super.onMeasure(widthMeasureSpec, heightMeasureSpec);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
