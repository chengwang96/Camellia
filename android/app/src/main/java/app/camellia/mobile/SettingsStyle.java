package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
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
    private final Palette palette;

    SettingsStyle(Context context) {
        this.context = context;
        this.palette = Palette.of(context);
        background = palette.grouped;
        card = palette.card;
        ink = palette.ink;
        secondary = palette.secondary;
        divider = palette.divider;
        error = palette.error;
        field = palette.field;
        fieldBorder = palette.fieldBorder;
        accent = palette.accent;
    }

    /** The palette itself, for the call sites that need a value this class does not expose. */
    Palette palette() { return palette; }

    /**
     * Package-visible, unlike most of this class, because the sheets, popups and
     * dialogs are separate classes that each used to carry their own copy of this
     * one line — and one of them had already resorted to `style.dp(value)` to
     * reach it, which is the signal that the copies should go.
     */
    int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }

    /** Keep the index and subpages inset even before Android dispatches window insets. */
    void pagePadding(View page) {
        pagePadding(page, 20);
    }

    void pagePadding(View page, int bottomDp) {
        page.setPadding(dp(16), dp(6), dp(16), dp(bottomDp));
        page.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(dp(16) + insets.getSystemWindowInsetLeft(), dp(6) + insets.getSystemWindowInsetTop(),
                dp(16) + insets.getSystemWindowInsetRight(), dp(bottomDp) + insets.getSystemWindowInsetBottom());
            return insets;
        });
    }

    /** A rounded rectangle in this page's own colours. */
    GradientDrawable round(int color, int radiusDp) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(color); shape.setCornerRadius(dp(radiusDp));
        return shape;
    }

    /**
     * A text view with the shared line spacing.
     *
     * <p>The sheets each had their own copy of this too, differing in whether
     * they set line spacing at all — so two sheets holding the same sentence
     * rendered it at two different heights.
     */
    TextView label(CharSequence value, int sizeSp, int color) {
        TextView view = new TextView(context);
        view.setText(value); view.setTextSize(sizeSp); view.setTextColor(color);
        view.setLineSpacing(dp(3), 1);
        return view;
    }

    GradientDrawable fieldBackground(int border) {
        GradientDrawable shape = new GradientDrawable(); shape.setColor(field); shape.setCornerRadius(dp(Palette.RADIUS_SETTINGS_CONTROL));
        shape.setStroke(dp(1), border); return shape;
    }

    void sheetPanel(LinearLayout panel) {
        panel.setOrientation(LinearLayout.VERTICAL); panel.setPadding(dp(18), dp(14), dp(18), dp(18));
        GradientDrawable shape = new GradientDrawable(); shape.setColor(background); shape.setCornerRadius(dp(Palette.RADIUS_SHEET));
        shape.setStroke(dp(1), palette.cardBorder); panel.setBackground(shape);
        View handle = new View(context); handle.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        GradientDrawable gripShape = new GradientDrawable(); gripShape.setColor(divider); gripShape.setCornerRadius(dp(Palette.RADIUS_GRIP)); handle.setBackground(gripShape);
        LinearLayout.LayoutParams grip = new LinearLayout.LayoutParams(dp(36), dp(4));
        grip.gravity = Gravity.CENTER_HORIZONTAL; grip.bottomMargin = dp(16); panel.addView(handle, grip);
    }

    void sheetWindow(android.view.Window window, View panel) {
        window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM);
        window.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT));
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND); window.setDimAmount(.28f);
        window.setGravity(Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        int width = sheetWidth();
        // Lock the final width before the first frame. The old post-show resize
        // changed both width and height after the sheet was already centered,
        // which made the panel visibly jump sideways as it opened.
        var attributes = window.getAttributes();
        attributes.y = dp(12);
        attributes.width = width;
        attributes.height = android.view.ViewGroup.LayoutParams.WRAP_CONTENT;
        window.setAttributes(attributes);
        Runnable resize = () -> {
            View decor = window.peekDecorView();
            if (decor == null || decor.getWindowToken() == null) return;
            int currentWidth = sheetWidth();
            android.graphics.Rect visible = new android.graphics.Rect(); decor.getWindowVisibleDisplayFrame(visible);
            int available = visible.height() > 0 ? visible.height() : context.getResources().getDisplayMetrics().heightPixels;
            int limit = Math.max(dp(160), available - dp(32));
            panel.measure(View.MeasureSpec.makeMeasureSpec(currentWidth, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(limit, View.MeasureSpec.AT_MOST));
            int height = Math.min(limit, panel.getMeasuredHeight());
            var updated = window.getAttributes();
            if (updated.height != height || updated.width != currentWidth) {
                updated.width = currentWidth;
                updated.height = height;
                window.setAttributes(updated);
            }
        };
        panel.setOnApplyWindowInsetsListener((view, insets) -> { view.post(resize); return insets; });
        panel.post(resize);
    }

    int sheetWidth() {
        return Math.min(dp(560), context.getResources().getDisplayMetrics().widthPixels - dp(24));
    }

    GradientDrawable cardBackground() {
        GradientDrawable shape = new GradientDrawable(); shape.setColor(card); shape.setCornerRadius(dp(Palette.RADIUS_SETTINGS_CARD));
        shape.setStroke(dp(1), palette.cardBorder); return shape;
    }

    LinearLayout header(String title) {
        return header(title, "", null);
    }

    LinearLayout header(String title, String backLabel, Runnable back) {
        LinearLayout header = new LinearLayout(context); header.setGravity(Gravity.CENTER_VERTICAL);
        header.setTag("settingsHeader"); header.setBackgroundColor(background);
        header.setClipChildren(false); header.setClipToPadding(false);
        header.setPadding(0, dp(2), 0, dp(8));
        if (back != null) {
            ImageButton button = new ChatStyle(context).backButton(backLabel, back); button.setTag("settingsBack");
            header.addView(button, new LinearLayout.LayoutParams(dp(48), dp(48)));
        }
        TextView heading = new TextView(context); heading.setText(title); heading.setTextSize(Palette.TEXT_TITLE); heading.setTextColor(ink);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); heading.setGravity(Gravity.CENTER);
        heading.setPadding(dp(6), dp(8), dp(6), dp(8)); heading.setTag("settingsTitle");
        if (back == null) heading.setMinHeight(dp(48));
        if (android.os.Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        if (back != null) {
            View balance = new View(context); header.addView(balance, new LinearLayout.LayoutParams(dp(48), 1));
        }
        return header;
    }

    LinearLayout topLevelHeader(String title) {
        LinearLayout header = new LinearLayout(context);
        header.setBackgroundColor(background);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(0, dp(2), 0, dp(8));
        TextView heading = new TextView(context);
        heading.setText(title);
        heading.setTextSize(Palette.TEXT_HERO);
        heading.setTextColor(ink);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        heading.setPadding(dp(8), dp(8), dp(8), dp(8));
        heading.setTag("settingsTitle");
        if (android.os.Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        return header;
    }

    LinearLayout group(LinearLayout parent, String label) {
        if (!label.isEmpty()) {
            TextView title = new TextView(context); title.setText(label); title.setTextSize(Palette.TEXT_NOTE); title.setTextColor(secondary);
            title.setPadding(dp(4), dp(6), dp(4), dp(2));
            if (android.os.Build.VERSION.SDK_INT >= 28) title.setAccessibilityHeading(true);
            parent.addView(title);
        }
        LinearLayout group = new LinearLayout(context); group.setOrientation(LinearLayout.VERTICAL);
        group.setBackground(cardBackground()); group.setClipToOutline(true); group.setTag("settingsGroup");
        group.setElevation(dp(1));
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            group.setOutlineAmbientShadowColor(0x10000000); group.setOutlineSpotShadowColor(0x1c000000);
        }
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, 0, 0, dp(4)); parent.addView(group, params);
        return group;
    }

    void appearance(LinearLayout group, String selected, String title, String[] labels,
            java.util.function.Consumer<String> choose) {
        separator(group);
        LinearLayout section = new LinearLayout(context); section.setOrientation(LinearLayout.VERTICAL);
        section.setPadding(dp(16), dp(14), dp(16), dp(16)); section.setTag("preference:theme");
        TextView heading = label(title, Palette.TEXT_ROW_STRONG, ink);
        section.addView(heading);
        LinearLayout choices = new LinearLayout(context); choices.setPadding(0, dp(10), 0, 0);
        String[] values = {"system", "light", "dark"};
        String[] icons = {"computer", "appearance", "moon"};
        for (int index = 0; index < values.length; index++) {
            String value = values[index]; boolean active = value.equals(selected);
            LinearLayout button = new LinearLayout(context); button.setOrientation(LinearLayout.VERTICAL);
            button.setGravity(Gravity.CENTER); button.setMinimumHeight(dp(68)); button.setPadding(dp(4), dp(10), dp(4), dp(10));
            button.setTag("appearance:" + value); button.setSelected(active); button.setFocusable(true);
            button.setContentDescription(labels[index]);
            button.setAccessibilityDelegate(new View.AccessibilityDelegate() {
                @Override public void onInitializeAccessibilityNodeInfo(View view, android.view.accessibility.AccessibilityNodeInfo info) {
                    super.onInitializeAccessibilityNodeInfo(view, info);
                    info.setClassName("android.widget.RadioButton"); info.setCheckable(true); info.setChecked(view.isSelected());
                }
            });
            GradientDrawable face = round(active ? palette.controlFill : card, Palette.RADIUS_SETTINGS_CARD);
            face.setStroke(dp(1), active ? palette.selectedBorder : palette.cardBorder);
            button.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), face,
                round(Color.WHITE, Palette.RADIUS_SETTINGS_CARD)));
            button.setElevation(dp(1));
            if (android.os.Build.VERSION.SDK_INT >= 28) {
                button.setOutlineAmbientShadowColor(0x10000000); button.setOutlineSpotShadowColor(0x1c000000);
            }
            ImageView icon = new ImageView(context); icon.setImageDrawable(new LineIcon(icons[index], ink));
            icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            button.addView(icon, new LinearLayout.LayoutParams(dp(20), dp(20)));
            TextView name = label(labels[index], Palette.TEXT_NOTE, ink); name.setGravity(Gravity.CENTER);
            name.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            LinearLayout.LayoutParams text = new LinearLayout.LayoutParams(-1, -2); text.topMargin = dp(6); button.addView(name, text);
            button.setOnClickListener(view -> { if (!button.isSelected()) choose.accept(value); });
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -1, 1); if (index > 0) params.setMarginStart(dp(6));
            choices.addView(button, params);
        }
        section.addView(choices); group.addView(section);
    }

    void row(LinearLayout group, String iconName, String title, String value, String tag, Runnable action) {
        if (group.getChildCount() > 0) {
            View line = new View(context); line.setBackgroundColor(divider); line.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, Math.max(1, dp(1) / 2)); params.setMargins(dp(46), 0, dp(14), 0); group.addView(line, params);
        }
        LinearLayout row = new LinearLayout(context); row.setGravity(Gravity.CENTER_VERTICAL); row.setMinimumHeight(dp(56));
        row.setPadding(dp(14), dp(10), dp(12), dp(10)); row.setTag(tag); row.setFocusable(true);
        row.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), null, new android.graphics.drawable.ColorDrawable(Color.WHITE)));
        row.setContentDescription(value.isEmpty() ? title : title + ", " + value);
        row.setOnClickListener(view -> action.run());
        ImageView icon = new ImageView(context); icon.setImageDrawable(new LineIcon(iconName, ink)); icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        row.addView(icon, new LinearLayout.LayoutParams(dp(21), dp(21)));
        TextView label = new TextView(context); label.setText(title); label.setTextColor(ink); label.setTextSize(Palette.TEXT_ROW_STRONG);
        label.setPadding(dp(11), 0, dp(8), 0); label.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        label.setTag(ROW_TITLE);
        row.addView(label, new LinearLayout.LayoutParams(0, -2, 1));
        if (!value.isEmpty()) {
            TextView current = valueView();
            current.setText(value);
            row.addView(current);
        }
        ImageView arrow = new ImageView(context); arrow.setImageDrawable(new LineIcon("right", secondary)); arrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams arrowParams = new LinearLayout.LayoutParams(dp(18), dp(18)); arrowParams.setMarginStart(dp(8)); row.addView(arrow, arrowParams);
        group.addView(row, new LinearLayout.LayoutParams(-1, -2));
    }

    /** A settings row that reports a value and has no destination. */
    void valueRow(LinearLayout group, String iconName, String title, String value, String tag) {
        if (group.getChildCount() > 0) {
            View line = new View(context);
            line.setBackgroundColor(divider);
            line.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, Math.max(1, dp(1) / 2));
            params.setMargins(dp(46), 0, dp(14), 0);
            group.addView(line, params);
        }
        LinearLayout row = new LinearLayout(context);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(56));
        row.setPadding(dp(14), dp(10), dp(12), dp(10));
        row.setTag(tag);
        row.setContentDescription(value.isEmpty() ? title : title + ", " + value);
        ImageView icon = new ImageView(context);
        icon.setImageDrawable(new LineIcon(iconName, ink));
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        row.addView(icon, new LinearLayout.LayoutParams(dp(21), dp(21)));
        TextView label = new TextView(context);
        label.setText(title);
        label.setTextColor(ink);
        label.setTextSize(Palette.TEXT_ROW_STRONG);
        label.setPadding(dp(11), 0, dp(8), 0);
        label.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        label.setTag(ROW_TITLE);
        row.addView(label, new LinearLayout.LayoutParams(0, -2, 1));
        if (!value.isEmpty()) {
            TextView current = valueView();
            current.setText(value);
            row.addView(current);
        }
        group.addView(row, new LinearLayout.LayoutParams(-1, -2));
    }

    /** The tag {@link #row} puts on the right-hand value, when there is one. */
    static final String ROW_VALUE = "settingsRowValue";
    /** The tag {@link #row} puts on the row's title. */
    static final String ROW_TITLE = "settingsRowTitle";

    /**
     * A row's right-hand value view, configured once.
     *
     * <p>One line, ellipsised. {@code setMaxWidth} bounds the box but not the
     * text, so a long value — a device name runs to 80 characters — wrapped onto
     * a second line, made that one row taller than every other, and left its
     * arrow floating in the middle. {@link #row} and {@link #setRowValue} share
     * this so a value added later looks identical to one added at build time.
     */
    private TextView valueView() {
        TextView current = new TextView(context);
        current.setTextSize(Palette.TEXT_SMALL); current.setTextColor(secondary);
        current.setMaxWidth(dp(100)); current.setGravity(Gravity.END);
        current.setMaxLines(1); current.setEllipsize(android.text.TextUtils.TruncateAt.END);
        current.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        // Tagged so a caller can update it in place. The alternative is
        // rebuilding the whole group, which is how a row showing live state ends
        // up stale: right when the page was built, wrong the moment anything
        // changes.
        current.setTag(ROW_VALUE);
        return current;
    }

    /**
     * Sets a row's right-hand value, creating the view if the row was built
     * without one.
     *
     * <p>Used by the pages whose rows show something that changes while they are
     * open. Passing {@code null} or an empty string hides it, which is how a row
     * goes back to being a plain link.
     *
     * @return true when the row was found. False means the row is not on screen,
     *         which is normal rather than exceptional: the reader may have
     *         navigated away between the update being computed and delivered.
     */
    boolean setRowValue(LinearLayout row, String value) {
        if (row == null) return false;
        View existing = row.findViewWithTag(ROW_VALUE);
        if (value == null || value.isEmpty()) {
            if (existing != null) ((android.view.ViewGroup) row).removeView(existing);
            row.setContentDescription(titleOf(row));
            return true;
        }
        TextView current = existing instanceof TextView ? (TextView) existing : null;
        if (current == null) {
            current = valueView();
            // Before the arrow, which is always last.
            android.view.ViewGroup parent = (android.view.ViewGroup) row;
            parent.addView(current, parent.getChildCount() - 1);
        }
        if (!value.contentEquals(current.getText())) current.setText(value);
        row.setContentDescription(titleOf(row) + ", " + value);
        return true;
    }

    /**
     * The row's own title, read back out of the view.
     *
     * <p>Needed because a row's spoken label is title plus value, and updating
     * the value has to update the label too — otherwise a screen reader reads a
     * stale state while the screen shows the new one.
     */
    private String titleOf(LinearLayout row) {
        View title = row.findViewWithTag(ROW_TITLE);
        return title instanceof TextView ? ((TextView) title).getText().toString() : "";
    }

    private void separator(LinearLayout group) {
        if (group.getChildCount() == 0) return;
        View line = new View(context); line.setBackgroundColor(divider); line.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, Math.max(1, dp(1) / 2));
        params.setMargins(dp(16), 0, dp(16), 0); group.addView(line, params);
    }

    private LinearLayout detailRow(LinearLayout group, String title, String description, int titleColor) {
        return detailRow(group, title, description, titleColor, new LinearLayout(context));
    }

    private LinearLayout detailRow(LinearLayout group, String title, String description, int titleColor, LinearLayout row) {
        separator(group);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(56)); row.setPadding(dp(14), dp(10), dp(12), dp(10));
        LinearLayout copy = new LinearLayout(context); copy.setOrientation(LinearLayout.VERTICAL);
        TextView heading = new TextView(context); heading.setText(title); heading.setTextSize(Palette.TEXT_ROW_STRONG); heading.setTextColor(titleColor); copy.addView(heading);
        if (!description.isEmpty()) {
            TextView note = new TextView(context); note.setText(description); note.setTextSize(Palette.TEXT_BODY); note.setTextColor(secondary);
            note.setPadding(0, dp(2), 0, 0); note.setLineSpacing(dp(3), 1); copy.addView(note);
        }
        row.addView(copy, new LinearLayout.LayoutParams(0, -2, 1)); group.addView(row, new LinearLayout.LayoutParams(-1, -2)); return row;
    }

    void info(LinearLayout group, String title, String description) { detailRow(group, title, description, ink); }

    /**
     * A row that opens a picker: the setting's name on the first line, the
     * current choice on the second.
     *
     * <p>Not {@link #row} with the choice as its right-hand value. That column is
     * 100dp wide and single-line, which is fine for "System" or a device name
     * and useless for a choice like "Enter sends; hold for newline" — it came out
     * as {@code Enter sends; h…}, which tells the reader less than nothing about
     * what is currently set. A preference's label is a sentence, so it belongs
     * where a sentence fits.
     *
     * <p>Keeps the chevron so the row still reads as "opens something" the way
     * {@link #row} does.
     */
    LinearLayout preference(LinearLayout group, String iconName, String title, String choice, String tag, Runnable action) {
        if (group.getChildCount() > 0) {
            View line = new View(context); line.setBackgroundColor(divider);
            line.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, Math.max(1, dp(1) / 2));
            params.setMargins(dp(52), 0, dp(16), 0); group.addView(line, params);
        }
        LinearLayout row = new LinearLayout(context); row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(56)); row.setPadding(dp(14), dp(10), dp(12), dp(10));
        row.setTag(tag); row.setFocusable(true);
        row.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), null, new android.graphics.drawable.ColorDrawable(Color.WHITE)));
        row.setContentDescription(title + ", " + choice);
        row.setOnClickListener(view -> action.run());
        if (iconName != null) {
            ImageView icon = new ImageView(context); icon.setImageDrawable(new LineIcon(iconName, ink));
            icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            row.addView(icon, new LinearLayout.LayoutParams(dp(23), dp(23)));
        }
        LinearLayout labels = new LinearLayout(context); labels.setOrientation(LinearLayout.VERTICAL);
        labels.setPaddingRelative(iconName != null ? dp(13) : 0, 0, 0, 0);
        TextView heading = new TextView(context); heading.setText(title); heading.setTextColor(ink);
        heading.setTextSize(Palette.TEXT_ROW_STRONG); heading.setTag(ROW_TITLE);
        labels.addView(heading);
        TextView current = new TextView(context); current.setText(choice); current.setTextColor(secondary);
        current.setTextSize(Palette.TEXT_BODY); current.setPadding(0, dp(2), dp(8), 0);
        current.setTag(ROW_VALUE);
        labels.addView(current);
        if (MobileLayout.useTabletRail(context.getResources().getConfiguration()) && choice.length() <= 32) {
            labels.setOrientation(LinearLayout.HORIZONTAL); labels.setGravity(Gravity.CENTER_VERTICAL);
            heading.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1)); heading.setTextSize(16);
            current.setLayoutParams(new LinearLayout.LayoutParams(-2, -2));
            current.setTextSize(14); current.setPadding(dp(12), 0, dp(8), 0);
        }
        row.addView(labels, new LinearLayout.LayoutParams(0, -2, 1));
        ImageView arrow = new ImageView(context); arrow.setImageDrawable(new LineIcon("right", secondary));
        arrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams arrowParams = new LinearLayout.LayoutParams(dp(18), dp(18)); arrowParams.setMarginStart(dp(8));
        row.addView(arrow, arrowParams);
        group.addView(row, new LinearLayout.LayoutParams(-1, -2));
        return row;
    }

    /**
     * A "nothing here yet" block for a settings page.
     *
     * <p>Not {@link #info} inside a {@link #group}. That is a card with a title,
     * a description and a chevron — the same shape as every tappable row on the
     * page — so an empty state built from it reads as something to tap, and the
     * reader has to tap it to find out what happens. This has no chevron, no card
     * behind it, and is centred, because it reports a state rather than offering
     * a destination.
     *
     * <p>An optional action can still be offered, as a capsule — the one thing a
     * reader can do about an empty list.
     */
    void emptyState(LinearLayout parent, String title, String description, String actionLabel, Runnable action) {
        LinearLayout block = new LinearLayout(context); block.setOrientation(LinearLayout.VERTICAL);
        block.setGravity(Gravity.CENTER); block.setTag("settingsEmptyState");
        block.setPadding(dp(16), dp(36), dp(16), dp(28));
        TextView heading = new TextView(context); heading.setText(title); heading.setTextColor(ink);
        heading.setTextSize(Palette.TEXT_DISPLAY); heading.setGravity(Gravity.CENTER);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setPadding(0, 0, 0, dp(8));
        if (android.os.Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        block.addView(heading);
        if (description != null && !description.isEmpty()) {
            TextView hint = new TextView(context); hint.setText(description); hint.setTextColor(secondary);
            hint.setTextSize(Palette.TEXT_BODY); hint.setGravity(Gravity.CENTER); hint.setLineSpacing(dp(4), 1);
            block.addView(hint);
        }
        if (action != null && actionLabel != null && !actionLabel.isEmpty()) {
            TextView button = secondaryButton(actionLabel, "settingsEmptyAction", action);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2);
            params.topMargin = dp(20); block.addView(button, params);
        }
        parent.addView(block, new LinearLayout.LayoutParams(-1, -2));
    }

    /**
     * A page-level state line, placed above the content rather than below it.
     *
     * <p>Returns the TextView so the caller can keep updating it. Hidden while
     * the text is empty, so a page that has nothing to report shows nothing.
     */
    TextView statusBanner(LinearLayout parent) {
        TextView banner = new TextView(context);
        banner.setTextSize(Palette.TEXT_BODY);
        banner.setTextColor(ink);
        banner.setGravity(Gravity.START);
        banner.setPadding(dp(16), dp(12), dp(16), dp(12));
        banner.setLineSpacing(dp(3), 1);
        banner.setBackground(fieldBackground(divider));
        banner.setTag("settingsStatusBanner");
        banner.setVisibility(View.GONE);
        // Announced as it changes, which is the point of putting it here.
        banner.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(14);
        parent.addView(banner, params);
        return banner;
    }

    /**
     * A page that cannot do its job yet, saying what is missing and offering the
     * one action that fixes it.
     *
     * <p>Distinct from {@link #emptyState}: an empty state says "there is nothing
     * here yet", which invites the reader to make something. This says "something
     * is missing and here is where to put it" — and the action is not the same as
     * the thing the page would otherwise do. A page in this state must not also
     * render the controls that would fail, or the reader is offered a button that
     * cannot work.
     */
    void blockedState(LinearLayout parent, String title, String description, String actionLabel, Runnable action) {
        LinearLayout block = new LinearLayout(context); block.setOrientation(LinearLayout.VERTICAL);
        block.setGravity(Gravity.CENTER_HORIZONTAL); block.setTag("settingsBlockedState");
        block.setPadding(dp(18), dp(28), dp(18), dp(20));
        block.setBackground(fieldBackground(divider));
        TextView heading = new TextView(context); heading.setText(title); heading.setTextColor(ink);
        heading.setTextSize(Palette.TEXT_DISPLAY); heading.setGravity(Gravity.CENTER);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setPadding(0, 0, 0, dp(8));
        if (android.os.Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        block.addView(heading);
        TextView hint = new TextView(context); hint.setText(description); hint.setTextColor(secondary);
        hint.setTextSize(Palette.TEXT_BODY); hint.setGravity(Gravity.CENTER); hint.setLineSpacing(dp(4), 1);
        block.addView(hint);
        if (action != null && actionLabel != null && !actionLabel.isEmpty()) {
            TextView button = secondaryButton(actionLabel, "settingsBlockedAction", action);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2);
            params.topMargin = dp(20); block.addView(button, params);
        }
        parent.addView(block, new LinearLayout.LayoutParams(-1, -2));
    }

    void note(LinearLayout parent, String value) {
        TextView note = new TextView(context); note.setText(value); note.setTextSize(Palette.TEXT_NOTE); note.setTextColor(palette.faint);
        note.setPadding(dp(16), 0, dp(16), dp(18)); note.setLineSpacing(dp(3), 1); parent.addView(note);
    }

    android.widget.ProgressBar progressBar() {
        android.widget.ProgressBar bar = new android.widget.ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal);
        GradientDrawable track = new GradientDrawable(); track.setColor(palette.progressTrack); track.setCornerRadius(dp(Palette.RADIUS_GRIP));
        GradientDrawable fill = new GradientDrawable(); fill.setColor(accent); fill.setCornerRadius(dp(Palette.RADIUS_GRIP));
        android.graphics.drawable.ScaleDrawable progress = new android.graphics.drawable.ScaleDrawable(fill, Gravity.START, 1f, -1f);
        android.graphics.drawable.LayerDrawable layers = new android.graphics.drawable.LayerDrawable(new android.graphics.drawable.Drawable[]{track, progress});
        layers.setId(0, android.R.id.background); layers.setId(1, android.R.id.progress);
        bar.setProgressTintList(null); bar.setProgressBackgroundTintList(null); bar.setProgressDrawable(layers);
        bar.setIndeterminate(false); bar.setMax(100); bar.setPadding(0, 0, 0, 0); bar.setMinimumHeight(dp(6));
        bar.setBackground(track.getConstantState().newDrawable().mutate()); bar.setClipToOutline(true); return bar;
    }

    void raised(View view, int elevationDp) {
        SurfaceElevation.apply(view, elevationDp);
    }

    TextView secondaryButton(String label, String tag, Runnable action) {
        TextView button = new TextView(context);
        button.setText(label);
        ActionStyle.page(button, false);
        button.setFocusable(true);
        button.setTag(tag);
        button.setOnClickListener(view -> action.run());
        return button;
    }

    void action(LinearLayout group, String title, String description, String tag, boolean destructive, Runnable action) {
        int color = destructive ? error : ink;
        LinearLayout row = detailRow(group, title, description, color); row.setTag(tag); row.setFocusable(true);
        row.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), null, new android.graphics.drawable.ColorDrawable(Color.WHITE)));
        row.setContentDescription(description.isEmpty() ? title : title + ", " + description); row.setOnClickListener(view -> action.run());
        for (int index = 0; index < row.getChildCount(); index++) row.getChildAt(index).setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        ImageView arrow = new ImageView(context); arrow.setImageDrawable(new LineIcon("right", secondary)); arrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(18), dp(18)); params.setMarginStart(dp(8)); row.addView(arrow, params);
    }

    android.widget.Switch toggle(LinearLayout group, String title, String description, String tag, boolean checked,
            android.widget.CompoundButton.OnCheckedChangeListener listener) {
        android.widget.Switch toggle = new SettingsToggle(context); toggle.setTag(tag);
        LinearLayout row = detailRow(group, title, description, ink, new LinearLayout(context) {
            @Override public void setPressed(boolean pressed) {
                super.setPressed(pressed);
                toggle.setPressed(pressed && toggle.isEnabled());
            }
        });
        toggle.setContentDescription(title + ", " + description); toggle.setChecked(checked); toggle.setMinimumHeight(dp(48));
        toggle.setOnCheckedChangeListener(listener);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2); params.setMarginStart(dp(16)); row.addView(toggle, params);
        row.setSoundEffectsEnabled(false); // performClick on the switch supplies the single click feedback.
        row.setOnClickListener(view -> { if (toggle.isEnabled()) toggle.performClick(); }); return toggle;
    }
}
