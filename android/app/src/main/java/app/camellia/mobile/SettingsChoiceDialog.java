package app.camellia.mobile;

import android.app.AlertDialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.function.IntConsumer;

final class SettingsChoiceDialog extends AlertDialog {
    private final SettingsStyle style;
    private final String title;
    private final String[] labels;
    private final int selected;
    private final String cancelLabel;
    private final IntConsumer onSelect;

    SettingsChoiceDialog(Context context, String title, String[] labels, int selected, String cancelLabel, IntConsumer onSelect) {
        super(context);
        style = new SettingsStyle(context);
        this.title = title; this.labels = labels.clone(); this.selected = selected;
        this.cancelLabel = cancelLabel; this.onSelect = onSelect;
    }

    private int dp(int value) { return Math.round(value * getContext().getResources().getDisplayMetrics().density); }

    private GradientDrawable rounded(int color, int radius) {
        GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(radius)); return shape;
    }

    private TextView text(String value, int size, int color) {
        TextView text = new TextView(getContext()); text.setText(value); text.setTextSize(size); text.setTextColor(color);
        return text;
    }

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout panel = new LinearLayout(getContext()) {
            @Override protected void onMeasure(int widthSpec, int heightSpec) {
                int limit = Math.round(getResources().getDisplayMetrics().heightPixels * .85f);
                if (MeasureSpec.getMode(heightSpec) != MeasureSpec.UNSPECIFIED) limit = Math.min(limit, MeasureSpec.getSize(heightSpec));
                super.onMeasure(widthSpec, MeasureSpec.makeMeasureSpec(limit, MeasureSpec.AT_MOST));
            }
        };
        style.sheetPanel(panel); panel.setTag("settingsChoicePanel");
        TextView heading = text(title, 21, style.ink); heading.setTag("settingsChoiceTitle");
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setPadding(dp(8), dp(4), dp(8), dp(18));
        if (android.os.Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        panel.addView(heading, new LinearLayout.LayoutParams(-1, -2));

        LinearLayout options = new LinearLayout(getContext()); options.setOrientation(LinearLayout.VERTICAL);
        options.setBackground(rounded(style.card, 20)); options.setClipToOutline(true);
        for (int index = 0; index < labels.length; index++) {
            final int choice = index;
            if (index > 0) {
                View divider = new View(getContext()); divider.setBackgroundColor(style.divider);
                divider.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
                LinearLayout.LayoutParams lineParams = new LinearLayout.LayoutParams(-1, Math.max(1, dp(1) / 2));
                lineParams.setMargins(dp(16), 0, dp(16), 0); options.addView(divider, lineParams);
            }
            LinearLayout row = new LinearLayout(getContext()); row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(16), dp(16), dp(16), dp(16)); row.setMinimumHeight(dp(64));
            row.setTag("settingsChoice:" + index); row.setFocusable(true); row.setSelected(index == selected);
            row.setBackground(new RippleDrawable(ColorStateList.valueOf(style.divider), new ColorDrawable(style.card), new ColorDrawable(Color.WHITE)));
            row.setContentDescription(labels[index]);
            row.setAccessibilityDelegate(new View.AccessibilityDelegate() {
                @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
                    super.onInitializeAccessibilityNodeInfo(host, info);
                    info.setClassName("android.widget.RadioButton"); info.setCheckable(true); info.setChecked(choice == selected);
                }
            });
            TextView label = text(labels[index], 16, style.ink); label.setPadding(0, 0, dp(12), 0);
            label.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            if (index == selected) label.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
            row.addView(label, new LinearLayout.LayoutParams(0, -2, 1));
            TextView check = text(index == selected ? "✓" : "", 16, style.card); check.setGravity(Gravity.CENTER);
            check.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            GradientDrawable indicator = rounded(index == selected ? style.ink : Color.TRANSPARENT, 13);
            if (index != selected) indicator.setStroke(dp(1), style.divider);
            check.setBackground(indicator); row.addView(check, new LinearLayout.LayoutParams(dp(26), dp(26)));
            row.setOnClickListener(view -> { dismiss(); if (choice != selected) onSelect.accept(choice); });
            options.addView(row, new LinearLayout.LayoutParams(-1, -2));
        }
        ScrollView scroll = new ScrollView(getContext()); scroll.setFillViewport(false); scroll.addView(options);
        panel.addView(scroll, new LinearLayout.LayoutParams(-1, -2, 1));

        TextView cancel = text(cancelLabel, 16, style.ink); cancel.setGravity(Gravity.CENTER);
        cancel.setPadding(dp(16), dp(14), dp(16), dp(14)); cancel.setMinimumHeight(dp(52));
        cancel.setTag("settingsChoiceCancel"); cancel.setFocusable(true);
        cancel.setBackground(new RippleDrawable(ColorStateList.valueOf(style.divider), rounded(style.card, 20), rounded(Color.WHITE, 20)));
        cancel.setAccessibilityDelegate(new View.AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info); info.setClassName("android.widget.Button");
            }
        });
        cancel.setOnClickListener(view -> cancel());
        LinearLayout.LayoutParams cancelParams = new LinearLayout.LayoutParams(-1, -2); cancelParams.topMargin = dp(12);
        panel.addView(cancel, cancelParams);
        setContentView(panel); setCanceledOnTouchOutside(true);
        style.sheetWindow(getWindow(), panel);
    }
}
