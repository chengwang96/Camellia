package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;

// The composer's "+" opens one attachment sheet in both local and remote chat.
// Its layout follows the Kimi reference: a row of square tiles for the picture
// sources, then the setting rows describing what the current mode can switch.
final class AttachSheet {
    static final class Tile {
        final String icon, label, tag;
        final Runnable action;
        final boolean enabled;

        Tile(String icon, String label, String tag, Runnable action) {
            this(icon, label, tag, true, action);
        }

        Tile(String icon, String label, String tag, boolean enabled, Runnable action) {
            this.icon = icon; this.label = label; this.tag = tag; this.enabled = enabled; this.action = action;
        }
    }

    private final Context context;
    private final SettingsStyle style;

    AttachSheet(Context context) {
        this.context = context; style = new SettingsStyle(context);
    }

    private int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }

    LinearLayout panel() {
        LinearLayout panel = new LinearLayout(context); panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(0, 0, 0, dp(8)); return panel;
    }

    void header(LinearLayout panel, String iconKind, String title, String closeLabel, Runnable close) {
        LinearLayout header = new LinearLayout(context); header.setGravity(Gravity.CENTER_VERTICAL);
        ImageView icon = new ImageView(context); icon.setImageDrawable(new LineIcon(iconKind, style.accent));
        icon.setPadding(dp(8), dp(8), dp(8), dp(8)); icon.setBackground(tileBackground());
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        header.addView(icon, new LinearLayout.LayoutParams(dp(40), dp(40)));
        TextView heading = new TextView(context); heading.setText(title); heading.setTextSize(20); heading.setTextColor(style.ink);
        heading.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
        heading.setPadding(dp(13), 0, 0, 0);
        if (android.os.Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        ImageView dismiss = new ImageView(context); dismiss.setImageDrawable(new LineIcon("close", style.secondary));
        dismiss.setTag("sheetClose"); dismiss.setFocusable(true); dismiss.setContentDescription(closeLabel);
        dismiss.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        dismiss.setBackground(new RippleDrawable(ColorStateList.valueOf(0x184176e6), null, new ColorDrawable(Color.WHITE)));
        dismiss.setOnClickListener(view -> close.run());
        header.addView(dismiss, new LinearLayout.LayoutParams(dp(40), dp(40)));
        panel.addView(header);
    }

    void subtitle(LinearLayout panel, String value) {
        TextView note = new TextView(context); note.setText(value); note.setTextSize(13); note.setTextColor(style.secondary);
        note.setPadding(0, dp(10), 0, dp(16)); panel.addView(note);
    }

    void tiles(LinearLayout panel, List<Tile> tiles) {
        LinearLayout row = new LinearLayout(context); row.setOrientation(LinearLayout.HORIZONTAL);
        row.setTag("attachTiles");
        for (Tile tile : tiles) {
            LinearLayout card = new LinearLayout(context); card.setOrientation(LinearLayout.VERTICAL);
            card.setGravity(Gravity.CENTER); card.setTag(tile.tag); card.setFocusable(true);
            card.setContentDescription(tile.label);
            card.setBackground(new RippleDrawable(ColorStateList.valueOf(0x184176e6), tileBackground(), new ColorDrawable(Color.WHITE)));
            card.setEnabled(tile.enabled); card.setAlpha(tile.enabled ? 1f : .45f);
            ImageView icon = new ImageView(context); icon.setImageDrawable(new LineIcon(tile.icon, style.ink));
            icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            card.addView(icon, new LinearLayout.LayoutParams(dp(26), dp(26)));
            TextView label = new TextView(context); label.setText(tile.label); label.setTextSize(14); label.setTextColor(style.ink);
            label.setGravity(Gravity.CENTER); label.setSingleLine(true);
            label.setEllipsize(android.text.TextUtils.TruncateAt.END);
            label.setPadding(0, dp(10), 0, 0); label.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            card.addView(label, new LinearLayout.LayoutParams(-1, -2));
            if (tile.enabled) card.setOnClickListener(view -> tile.action.run());
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(96), 1);
            if (row.getChildCount() > 0) params.setMarginStart(dp(12));
            row.addView(card, params);
        }
        // Keep the tiles visually separate from the capability card below them.
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(16);
        panel.addView(row, params);
    }

    // One capability row: icon, title, optional subtitle and right-hand value or
    // chevron, separated by a hairline like the settings groups.
    LinearLayout group(LinearLayout panel, String label) {
        return style.group(panel, label);
    }

    LinearLayout row(LinearLayout group, String iconName, String title, String subtitle, String value, String tag, Runnable action) {
        return row(group, iconName, title, subtitle, value, tag, true, action);
    }

    LinearLayout row(LinearLayout group, String iconName, String title, String subtitle, String value, String tag, boolean enabled, Runnable action) {
        if (group.getChildCount() > 0) {
            View line = new View(context); line.setBackgroundColor(style.divider);
            line.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, Math.max(1, dp(1) / 2));
            params.setMargins(dp(52), 0, dp(16), 0); group.addView(line, params);
        }
        LinearLayout row = new LinearLayout(context); row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(68)); row.setPadding(dp(16), dp(14), dp(14), dp(14));
        row.setTag(tag); row.setFocusable(true);
        row.setBackground(new RippleDrawable(ColorStateList.valueOf(0x184176e6), null, new ColorDrawable(Color.WHITE)));
        row.setContentDescription(subtitle.isEmpty() ? title : title + ", " + subtitle);
        row.setEnabled(enabled); row.setAlpha(enabled ? 1f : .45f);
        if (enabled) row.setOnClickListener(view -> action.run());
        ImageView icon = new ImageView(context); icon.setImageDrawable(new LineIcon(iconName, style.ink));
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        row.addView(icon, new LinearLayout.LayoutParams(dp(23), dp(23)));
        // Title and value share the first line; the subtitle always spans the
        // full width underneath. Keeping the value out of the subtitle's line is
        // what stops the two from being squeezed together on a narrow phone.
        LinearLayout copy = new LinearLayout(context); copy.setOrientation(LinearLayout.VERTICAL);
        copy.setPadding(dp(13), 0, dp(8), 0); copy.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        LinearLayout head = new LinearLayout(context); head.setGravity(Gravity.CENTER_VERTICAL);
        TextView heading = new TextView(context); heading.setText(title); heading.setTextSize(16); heading.setTextColor(style.ink);
        heading.setSingleLine(true); heading.setEllipsize(android.text.TextUtils.TruncateAt.END);
        head.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        if (!value.isEmpty()) {
            TextView current = new TextView(context); current.setText(value); current.setTextSize(14); current.setTextColor(style.secondary);
            current.setSingleLine(true); current.setEllipsize(android.text.TextUtils.TruncateAt.END);
            current.setMaxWidth(dp(96)); current.setGravity(Gravity.END);
            current.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            LinearLayout.LayoutParams valueParams = new LinearLayout.LayoutParams(-2, -2); valueParams.setMarginStart(dp(10));
            head.addView(current, valueParams);
        }
        copy.addView(head, new LinearLayout.LayoutParams(-1, -2));
        if (!subtitle.isEmpty()) {
            TextView note = new TextView(context); note.setText(subtitle); note.setTextSize(13); note.setTextColor(style.secondary);
            note.setPadding(0, dp(4), 0, 0); note.setLineSpacing(dp(2), 1); copy.addView(note);
        }
        row.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        ImageView arrow = new ImageView(context); arrow.setImageDrawable(new LineIcon("right", style.secondary));
        arrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams arrowParams = new LinearLayout.LayoutParams(dp(18), dp(18)); arrowParams.setMarginStart(dp(8));
        row.addView(arrow, arrowParams);
        group.addView(row, new LinearLayout.LayoutParams(-1, -2));
        return row;
    }

    void note(LinearLayout panel, String value) {
        TextView note = new TextView(context); note.setText(value); note.setTextSize(13); note.setTextColor(style.secondary);
        note.setPadding(dp(4), 0, dp(4), dp(14)); note.setLineSpacing(dp(3), 1); panel.addView(note);
    }

    private GradientDrawable tileBackground() {
        GradientDrawable shape = new GradientDrawable(); shape.setColor(style.card); shape.setCornerRadius(dp(18)); return shape;
    }
}
