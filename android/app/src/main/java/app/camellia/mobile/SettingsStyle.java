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
        GradientDrawable shape = new GradientDrawable(); shape.setColor(field); shape.setCornerRadius(dp(Palette.RADIUS_FIELD));
        shape.setStroke(dp(1), border); return shape;
    }

    void sheetPanel(LinearLayout panel) {
        panel.setOrientation(LinearLayout.VERTICAL); panel.setPadding(dp(18), dp(14), dp(18), dp(18));
        GradientDrawable shape = new GradientDrawable(); shape.setColor(background); shape.setCornerRadius(dp(Palette.RADIUS_SHEET)); panel.setBackground(shape);
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
        GradientDrawable shape = new GradientDrawable(); shape.setColor(card); shape.setCornerRadius(dp(Palette.RADIUS_GROUP)); return shape;
    }

    LinearLayout header(String title, String backLabel, Runnable back) {
        LinearLayout header = new LinearLayout(context); header.setGravity(Gravity.CENTER_VERTICAL);
        header.setClipChildren(false); header.setClipToPadding(false);
        header.setPadding(0, dp(4), 0, dp(16));
        ImageButton button = new ChatStyle(context).backButton(backLabel, back); button.setTag("settingsBack");
        header.addView(button, new LinearLayout.LayoutParams(dp(48), dp(48)));
        TextView heading = new TextView(context); heading.setText(title); heading.setTextSize(Palette.TEXT_TITLE); heading.setTextColor(ink);
        heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); heading.setGravity(Gravity.CENTER);
        heading.setPadding(dp(6), dp(8), dp(6), dp(8)); heading.setTag("settingsTitle");
        if (android.os.Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        View balance = new View(context); header.addView(balance, new LinearLayout.LayoutParams(dp(48), 1));
        return header;
    }

    LinearLayout group(LinearLayout parent, String label) {
        if (!label.isEmpty()) {
            TextView title = new TextView(context); title.setText(label); title.setTextSize(Palette.TEXT_NOTE); title.setTextColor(secondary);
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
        row.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), null, new android.graphics.drawable.ColorDrawable(Color.WHITE)));
        row.setContentDescription(value.isEmpty() ? title : title + ", " + value);
        row.setOnClickListener(view -> action.run());
        ImageView icon = new ImageView(context); icon.setImageDrawable(new LineIcon(iconName, ink)); icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        row.addView(icon, new LinearLayout.LayoutParams(dp(23), dp(23)));
        TextView label = new TextView(context); label.setText(title); label.setTextColor(ink); label.setTextSize(Palette.TEXT_ROW_STRONG);
        label.setPadding(dp(13), 0, dp(8), 0); label.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
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
        current.setTextSize(Palette.TEXT_BODY); current.setTextColor(secondary);
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
        params.setMargins(dp(18), 0, dp(18), 0); group.addView(line, params);
    }

    private LinearLayout detailRow(LinearLayout group, String title, String description, int titleColor) {
        separator(group);
        LinearLayout row = new LinearLayout(context); row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(62)); row.setPadding(dp(18), dp(16), dp(18), dp(16));
        LinearLayout copy = new LinearLayout(context); copy.setOrientation(LinearLayout.VERTICAL);
        TextView heading = new TextView(context); heading.setText(title); heading.setTextSize(Palette.TEXT_ROW_STRONG); heading.setTextColor(titleColor); copy.addView(heading);
        if (!description.isEmpty()) {
            TextView note = new TextView(context); note.setText(description); note.setTextSize(Palette.TEXT_BODY); note.setTextColor(secondary);
            note.setPadding(0, dp(7), 0, 0); note.setLineSpacing(dp(3), 1); copy.addView(note);
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
        row.setMinimumHeight(dp(64)); row.setPadding(dp(16), dp(14), dp(14), dp(14));
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
            TextView button = new TextView(context); button.setText(actionLabel); button.setTextColor(ink);
            button.setTextSize(Palette.TEXT_INPUT); button.setGravity(Gravity.CENTER);
            button.setMinHeight(dp(48)); button.setPadding(dp(20), dp(10), dp(20), dp(10));
            // `capsule()` belongs to ChatStyle, which carries a different
            // palette. The button on these pages is a filled field, so it is
            // built from this class's own field colour rather than borrowed.
            GradientDrawable face = new GradientDrawable();
            face.setColor(field); face.setCornerRadius(dp(Palette.RADIUS_FIELD));
            button.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_PAGE), face, face));
            button.setFocusable(true); button.setTag("settingsEmptyAction");
            button.setOnClickListener(view -> action.run());
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
            TextView button = new TextView(context); button.setText(actionLabel); button.setTextColor(ink);
            button.setTextSize(Palette.TEXT_INPUT); button.setGravity(Gravity.CENTER);
            button.setMinHeight(dp(48)); button.setPadding(dp(20), dp(10), dp(20), dp(10));
            GradientDrawable face = new GradientDrawable();
            face.setColor(field); face.setCornerRadius(dp(Palette.RADIUS_FIELD));
            button.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), face, face));
            button.setFocusable(true); button.setTag("settingsBlockedAction");
            button.setOnClickListener(view -> action.run());
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2);
            params.topMargin = dp(20); block.addView(button, params);
        }
        parent.addView(block, new LinearLayout.LayoutParams(-1, -2));
    }

    void note(LinearLayout parent, String value) {
        TextView note = new TextView(context); note.setText(value); note.setTextSize(Palette.TEXT_NOTE); note.setTextColor(secondary);
        note.setPadding(dp(16), 0, dp(16), dp(18)); note.setLineSpacing(dp(3), 1); parent.addView(note);
    }

    android.widget.ProgressBar progressBar() {
        android.widget.ProgressBar bar = new android.widget.ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal);
        GradientDrawable track = new GradientDrawable(); track.setColor(divider); track.setCornerRadius(dp(Palette.RADIUS_GRIP));
        GradientDrawable fill = new GradientDrawable(); fill.setColor(ink); fill.setCornerRadius(dp(Palette.RADIUS_GRIP));
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
        row.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), null, new android.graphics.drawable.ColorDrawable(Color.WHITE)));
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
        GradientDrawable on = new GradientDrawable(); on.setColor(accent); on.setCornerRadius(dp(Palette.RADIUS_TRACK)); on.setSize(dp(48), dp(28));
        GradientDrawable off = new GradientDrawable(); off.setColor(palette.trackOff); off.setCornerRadius(dp(Palette.RADIUS_TRACK)); off.setSize(dp(48), dp(28));
        track.addState(new int[]{android.R.attr.state_checked}, on); track.addState(new int[]{}, off);
        toggle.setTrackDrawable(track); toggle.setThumbTintList(null); toggle.setTrackTintList(null);
        toggle.setSplitTrack(false); toggle.setSwitchMinWidth(dp(48)); toggle.setOnCheckedChangeListener(listener);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-2, -2); params.setMarginStart(dp(16)); row.addView(toggle, params);
        row.setOnClickListener(view -> toggle.setChecked(!toggle.isChecked())); return toggle;
    }
}
