package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.LinearLayout;
import android.widget.TextView;

/** A full-row outlined choice for single- and multi-select questions. */
@android.annotation.SuppressLint("ViewConstructor")
final class ChoiceRow extends LinearLayout {
    interface OnCheckedChange { void changed(ChoiceRow row, boolean checked); }

    private final SettingsStyle style;
    private final Palette palette;
    private final String title, description;
    private final boolean multi;
    private final SelectionMark mark;
    private OnCheckedChange listener;
    private boolean checked;

    ChoiceRow(Context context, String title, String description, boolean multi, boolean checked) {
        super(context);
        this.style = new SettingsStyle(context);
        this.palette = style.palette();
        this.title = title == null ? "" : title;
        this.description = description == null ? "" : description;
        this.multi = multi;
        this.checked = checked;
        setOrientation(HORIZONTAL);
        setGravity(Gravity.CENTER_VERTICAL);
        setMinimumHeight(dp(56));
        setPadding(dp(14), dp(12), dp(14), dp(12));
        setFocusable(true);
        setClickable(true);
        setClipToOutline(true);

        mark = new SelectionMark(context, !multi);
        mark.setChecked(checked);
        LayoutParams markParams = new LayoutParams(dp(22), dp(22));
        markParams.setMarginEnd(dp(12));
        addView(mark, markParams);

        LinearLayout copy = new LinearLayout(context);
        copy.setOrientation(VERTICAL);
        copy.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        TextView heading = new TextView(context);
        heading.setText(title);
        heading.setTextColor(palette.ink);
        heading.setTextSize(Palette.TEXT_ROW);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setMaxLines(2);
        heading.setEllipsize(TextUtils.TruncateAt.END);
        copy.addView(heading, new LayoutParams(-1, -2));
        if (!this.description.isEmpty()) {
            TextView note = new TextView(context);
            note.setText(this.description);
            note.setTextColor(palette.muted);
            note.setTextSize(Palette.TEXT_NOTE);
            note.setPadding(0, dp(3), 0, 0);
            note.setMaxLines(3);
            note.setEllipsize(TextUtils.TruncateAt.END);
            copy.addView(note, new LayoutParams(-1, -2));
        }
        addView(copy, new LayoutParams(0, -2, 1));

        setOnClickListener(view -> {
            if (multi) setChecked(!checked);
            else if (!checked) setChecked(true);
        });
        refresh();
    }

    void setOnCheckedChangeListener(OnCheckedChange value) {
        listener = value;
    }

    boolean isChecked() {
        return checked;
    }

    void setChecked(boolean value) {
        if (checked == value) return;
        checked = value;
        refresh();
        if (listener != null) listener.changed(this, checked);
        sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED);
    }

    private void refresh() {
        GradientDrawable face = style.round(checked ? palette.controlFill : palette.card, Palette.RADIUS_FIELD);
        face.setStroke(dp(1), checked ? palette.selectedBorder : palette.cardBorder);
        setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), face,
            style.round(Color.WHITE, Palette.RADIUS_FIELD)));
        SurfaceElevation.apply(this, checked ? 2 : 1);
        mark.setChecked(checked);
        setSelected(checked);
        setContentDescription(title + (description.isEmpty() ? "" : ", " + description)
            + (checked ? (getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh")
                ? "，已选择" : ", selected") : ""));
    }

    @Override public CharSequence getAccessibilityClassName() {
        return multi ? "android.widget.CheckBox" : "android.widget.RadioButton";
    }

    @Override public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(info);
        info.setClassName(getAccessibilityClassName());
        info.setCheckable(true);
        info.setChecked(checked);
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
