package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

final class SettingsStyle {
    final int background, card, ink, secondary, divider, error, field, fieldBorder, accent;
    private final Context context;

    SettingsStyle(Context context) {
        this.context = context;
        boolean dark = (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        background = Color.parseColor(dark ? "#151517" : "#F5F5F5");
        card = Color.parseColor(dark ? "#232326" : "#FFFFFF");
        ink = Color.parseColor(dark ? "#F5F5F7" : "#191A1C");
        secondary = Color.parseColor(dark ? "#ABAEB5" : "#75787E");
        divider = Color.parseColor(dark ? "#37373C" : "#ECECEE");
        error = Color.parseColor(dark ? "#FF969A" : "#B8323B");
        field = Color.parseColor(dark ? "#303036" : "#FFFFFF");
        fieldBorder = Color.parseColor(dark ? "#62626C" : "#B9BEC7");
        accent = Color.parseColor(dark ? "#679EFE" : "#4176E6");
    }

    private int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }

    GradientDrawable fieldBackground(int border) {
        GradientDrawable shape = new GradientDrawable(); shape.setColor(field); shape.setCornerRadius(dp(18));
        shape.setStroke(dp(1), border); return shape;
    }

    void sheetPanel(LinearLayout panel) {
        panel.setOrientation(LinearLayout.VERTICAL); panel.setPadding(dp(18), dp(14), dp(18), dp(18));
        GradientDrawable shape = new GradientDrawable(); shape.setColor(background); shape.setCornerRadius(dp(30)); panel.setBackground(shape);
        View handle = new View(context); handle.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        GradientDrawable gripShape = new GradientDrawable(); gripShape.setColor(divider); gripShape.setCornerRadius(dp(3)); handle.setBackground(gripShape);
        LinearLayout.LayoutParams grip = new LinearLayout.LayoutParams(dp(36), dp(4));
        grip.gravity = Gravity.CENTER_HORIZONTAL; grip.bottomMargin = dp(16); panel.addView(handle, grip);
    }

    void sheetWindow(android.view.Window window, View panel) {
        window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM);
        window.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT));
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND); window.setDimAmount(.28f);
        window.setGravity(Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        var attributes = window.getAttributes(); attributes.y = dp(12); window.setAttributes(attributes);
        Runnable resize = () -> {
            View decor = window.peekDecorView();
            if (decor == null || decor.getWindowToken() == null) return;
            android.graphics.Rect visible = new android.graphics.Rect(); decor.getWindowVisibleDisplayFrame(visible);
            int available = visible.height() > 0 ? visible.height() : context.getResources().getDisplayMetrics().heightPixels;
            int width = Math.min(dp(560), context.getResources().getDisplayMetrics().widthPixels - dp(24));
            int limit = Math.max(dp(160), available - dp(32));
            panel.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(limit, View.MeasureSpec.AT_MOST));
            window.setLayout(width, Math.min(limit, panel.getMeasuredHeight()));
        };
        panel.setOnApplyWindowInsetsListener((view, insets) -> { view.post(resize); return insets; });
        panel.post(resize);
    }

    GradientDrawable cardBackground() {
        GradientDrawable shape = new GradientDrawable(); shape.setColor(card); shape.setCornerRadius(dp(26)); return shape;
    }

    LinearLayout header(String title, String backLabel, Runnable back) {
        LinearLayout header = new LinearLayout(context); header.setGravity(Gravity.CENTER_VERTICAL);
        header.setClipChildren(false); header.setClipToPadding(false);
        header.setPadding(0, dp(4), 0, dp(16));
        ImageButton button = new ChatStyle(context).backButton(backLabel, back); button.setTag("settingsBack");
        header.addView(button, new LinearLayout.LayoutParams(dp(48), dp(48)));
        TextView heading = new TextView(context); heading.setText(title); heading.setTextSize(20); heading.setTextColor(ink);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); heading.setGravity(Gravity.CENTER);
        heading.setPadding(dp(6), dp(8), dp(6), dp(8)); heading.setTag("settingsTitle");
        if (android.os.Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        View balance = new View(context); header.addView(balance, new LinearLayout.LayoutParams(dp(48), 1));
        return header;
    }

    LinearLayout group(LinearLayout parent, String label) {
        if (!label.isEmpty()) {
            TextView title = new TextView(context); title.setText(label); title.setTextSize(13); title.setTextColor(secondary);
            title.setPadding(dp(16), dp(12), dp(16), dp(10));
            if (android.os.Build.VERSION.SDK_INT >= 28) title.setAccessibilityHeading(true);
            parent.addView(title);
        }
        LinearLayout group = new LinearLayout(context); group.setOrientation(LinearLayout.VERTICAL);
        group.setBackground(cardBackground()); group.setClipToOutline(true); group.setTag("settingsGroup");
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, 0, 0, dp(14)); parent.addView(group, params);
        return group;
    }

    void row(LinearLayout group, String iconName, String title, String value, String tag, Runnable action) {
        if (group.getChildCount() > 0) {
            View line = new View(context); line.setBackgroundColor(divider); line.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, Math.max(1, dp(1) / 2)); params.setMargins(dp(52), 0, dp(16), 0); group.addView(line, params);
        }
        LinearLayout row = new LinearLayout(context); row.setGravity(Gravity.CENTER_VERTICAL); row.setMinimumHeight(dp(64));
        row.setPadding(dp(16), dp(14), dp(14), dp(14)); row.setTag(tag); row.setFocusable(true);
        row.setBackground(new RippleDrawable(ColorStateList.valueOf(0x184176e6), null, new android.graphics.drawable.ColorDrawable(Color.WHITE)));
        row.setContentDescription(value.isEmpty() ? title : title + ", " + value);
        row.setOnClickListener(view -> action.run());
        ImageView icon = new ImageView(context); icon.setImageDrawable(new LineIcon(iconName, ink)); icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        row.addView(icon, new LinearLayout.LayoutParams(dp(23), dp(23)));
        TextView label = new TextView(context); label.setText(title); label.setTextColor(ink); label.setTextSize(17);
        label.setPadding(dp(13), 0, dp(8), 0); label.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        row.addView(label, new LinearLayout.LayoutParams(0, -2, 1));
        if (!value.isEmpty()) {
            TextView current = new TextView(context); current.setText(value); current.setTextSize(14); current.setTextColor(secondary);
            current.setMaxWidth(dp(100)); current.setGravity(Gravity.END); current.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); row.addView(current);
        }
        ImageView arrow = new ImageView(context); arrow.setImageDrawable(new LineIcon("right", secondary)); arrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams arrowParams = new LinearLayout.LayoutParams(dp(18), dp(18)); arrowParams.setMarginStart(dp(8)); row.addView(arrow, arrowParams);
        group.addView(row, new LinearLayout.LayoutParams(-1, -2));
    }

    private void separator(LinearLayout group) {
        if (group.getChildCount() == 0) return;
        View line = new View(context); line.setBackgroundColor(divider); line.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, Math.max(1, dp(1) / 2));
        params.setMargins(dp(18), 0, dp(18), 0); group.addView(line, params);
    }

    private LinearLayout detailRow(LinearLayout group, String title, String description, int titleColor) {
        separator(group);
        LinearLayout row = new LinearLayout(context); row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(62)); row.setPadding(dp(18), dp(16), dp(18), dp(16));
        LinearLayout copy = new LinearLayout(context); copy.setOrientation(LinearLayout.VERTICAL);
        TextView heading = new TextView(context); heading.setText(title); heading.setTextSize(17); heading.setTextColor(titleColor); copy.addView(heading);
        if (!description.isEmpty()) {
            TextView note = new TextView(context); note.setText(description); note.setTextSize(14); note.setTextColor(secondary);
            note.setPadding(0, dp(7), 0, 0); note.setLineSpacing(dp(3), 1); copy.addView(note);
        }
        row.addView(copy, new LinearLayout.LayoutParams(0, -2, 1)); group.addView(row, new LinearLayout.LayoutParams(-1, -2)); return row;
    }

    void info(LinearLayout group, String title, String description) { detailRow(group, title, description, ink); }

    void note(LinearLayout parent, String value) {
        TextView note = new TextView(context); note.setText(value); note.setTextSize(13); note.setTextColor(secondary);
        note.setPadding(dp(16), 0, dp(16), dp(18)); note.setLineSpacing(dp(3), 1); parent.addView(note);
    }

    android.widget.ProgressBar progressBar() {
        android.widget.ProgressBar bar = new android.widget.ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal);
        GradientDrawable track = new GradientDrawable(); track.setColor(divider); track.setCornerRadius(dp(3));
        GradientDrawable fill = new GradientDrawable(); fill.setColor(ink); fill.setCornerRadius(dp(3));
        android.graphics.drawable.ScaleDrawable progress = new android.graphics.drawable.ScaleDrawable(fill, Gravity.START, 1f, -1f);
        android.graphics.drawable.LayerDrawable layers = new android.graphics.drawable.LayerDrawable(new android.graphics.drawable.Drawable[]{track, progress});
        layers.setId(0, android.R.id.background); layers.setId(1, android.R.id.progress);
        bar.setProgressTintList(null); bar.setProgressBackgroundTintList(null); bar.setProgressDrawable(layers);
        bar.setIndeterminate(false); bar.setMax(100); bar.setPadding(0, 0, 0, 0); bar.setMinimumHeight(dp(6));
        bar.setBackground(track.getConstantState().newDrawable().mutate()); bar.setClipToOutline(true); return bar;
    }

    void action(LinearLayout group, String title, String description, String tag, boolean destructive, Runnable action) {
        int color = destructive ? error : ink;
        LinearLayout row = detailRow(group, title, description, color); row.setTag(tag); row.setFocusable(true);
        row.setBackground(new RippleDrawable(ColorStateList.valueOf(0x184176e6), null, new android.graphics.drawable.ColorDrawable(Color.WHITE)));
        row.setContentDescription(description.isEmpty() ? title : title + ", " + description); row.setOnClickListener(view -> action.run());
        for (int index = 0; index < row.getChildCount(); index++) row.getChildAt(index).setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        ImageView arrow = new ImageView(context); arrow.setImageDrawable(new LineIcon("right", secondary)); arrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(18), dp(18)); params.setMarginStart(dp(14)); row.addView(arrow, params);
    }

    android.widget.Switch toggle(LinearLayout group, String title, String description, String tag, boolean checked,
            android.widget.CompoundButton.OnCheckedChangeListener listener) {
        LinearLayout row = detailRow(group, title, description, ink);
        android.widget.Switch toggle = new android.widget.Switch(context); toggle.setTag(tag); toggle.setShowText(false);
        toggle.setContentDescription(title + ", " + description); toggle.setChecked(checked); toggle.setMinimumHeight(dp(48));
        GradientDrawable thumb = new GradientDrawable(); thumb.setShape(GradientDrawable.OVAL); thumb.setColor(Color.WHITE); thumb.setSize(dp(24), dp(24));
        toggle.setThumbDrawable(new android.graphics.drawable.InsetDrawable(thumb, dp(2)));
        android.graphics.drawable.StateListDrawable track = new android.graphics.drawable.StateListDrawable();
        GradientDrawable on = new GradientDrawable(); on.setColor(Color.parseColor("#4176E6")); on.setCornerRadius(dp(14)); on.setSize(dp(48), dp(28));
        GradientDrawable off = new GradientDrawable(); off.setColor(Color.parseColor(background == Color.parseColor("#F5F5F5") ? "#D1D3D8" : "#505058")); off.setCornerRadius(dp(14)); off.setSize(dp(48), dp(28));
        track.addState(new int[]{android.R.attr.state_checked}, on); track.addState(new int[]{}, off);
        toggle.setTrackDrawable(track); toggle.setThumbTintList(null); toggle.setTrackTintList(null);
        toggle.setSplitTrack(false); toggle.setSwitchMinWidth(dp(48)); toggle.setOnCheckedChangeListener(listener);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2); params.setMarginStart(dp(16)); row.addView(toggle, params);
        row.setOnClickListener(view -> toggle.setChecked(!toggle.isChecked())); return toggle;
    }
}
