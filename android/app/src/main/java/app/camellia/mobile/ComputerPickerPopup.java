package app.camellia.mobile;

import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.LinkedHashMap;
import java.util.List;

final class ComputerPickerPopup {
    static final class Entry {
        final String address, name, state;
        final boolean selected;
        final Runnable open;
        Entry(String address, String name, String state, boolean selected, Runnable open) {
            this.address = address; this.name = name; this.state = state; this.selected = selected; this.open = open;
        }
    }

    final PopupSurface panel;
    private final PopupWindow popup;
    private final LinkedHashMap<String, TextView> states = new LinkedHashMap<>();
    private final ChatStyle style;

    @android.annotation.SuppressLint("RtlHardcoded")
    ComputerPickerPopup(View anchor, ChatStyle style, boolean chinese, List<Entry> entries, Runnable add, Runnable manage) {
        this.style = style;
        panel = new PopupSurface(anchor.getContext(), style.background); panel.setTag("computerPicker");
        LinearLayout rows = new LinearLayout(anchor.getContext()); rows.setOrientation(LinearLayout.VERTICAL);
        rows.setPadding(dp(8), dp(8), dp(8), dp(8));
        ScrollView scroll = ScrollViews.plain(anchor.getContext()); scroll.setVerticalScrollBarEnabled(false);
        scroll.setTag("computerPickerScroll");
        scroll.addView(rows); panel.addView(scroll);
        popup = new PopupWindow(panel, -2, -2, true);
        GradientDrawable face = new GradientDrawable(); face.setColor(style.background); face.setCornerRadius(dp(Palette.RADIUS_GROUP));
        popup.setBackgroundDrawable(face); popup.setElevation(dp(8)); popup.setOutsideTouchable(true);
        popup.setInputMethodMode(PopupWindow.INPUT_METHOD_NOT_NEEDED);
        for (Entry entry : entries) {
            LinearLayout row = row(rows, "computer", "switchComputer:" + entry.address, entry.open);
            LinearLayout copy = new LinearLayout(anchor.getContext()); copy.setOrientation(LinearLayout.VERTICAL);
            copy.setPadding(dp(14), 0, dp(8), 0);
            TextView name = label(entry.name, 17, style.ink); name.setSingleLine(true); name.setEllipsize(TextUtils.TruncateAt.END);
            copy.addView(name);
            TextView state = label(entry.state, 12, style.muted); state.setMaxLines(2); state.setEllipsize(TextUtils.TruncateAt.END);
            state.setPadding(0, dp(3), 0, 0); state.setTag("pickerState:" + entry.address);
            state.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
            if (!entry.state.isEmpty()) copy.addView(state);
            states.put(entry.address, state);
            row.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
            row.setSelected(entry.selected);
            row.setContentDescription(entry.name + (entry.selected ? (chinese ? "，当前电脑" : ", current computer") : ""));
            row.setTooltipText(entry.name);
            row.setAccessibilityDelegate(new View.AccessibilityDelegate() {
                @Override public void onInitializeAccessibilityNodeInfo(View view, android.view.accessibility.AccessibilityNodeInfo info) {
                    super.onInitializeAccessibilityNodeInfo(view, info); info.setClassName("android.widget.RadioButton");
                    info.setCheckable(true); info.setChecked(entry.selected);
                }
            });
            if (entry.selected) {
                ImageView check = new ImageView(anchor.getContext()); check.setImageDrawable(new LineIcon("check", style.accent));
                check.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
                row.addView(check, new LinearLayout.LayoutParams(dp(22), dp(22)));
            }
        }
        if (!entries.isEmpty() && (add != null || manage != null)) {
            View divider = new View(anchor.getContext()); divider.setBackgroundColor(new SettingsStyle(anchor.getContext()).divider);
            LinearLayout.LayoutParams space = new LinearLayout.LayoutParams(-1, dp(1)); space.setMargins(dp(14), dp(8), dp(14), dp(8));
            rows.addView(divider, space);
        }
        if (add != null) action(rows, "plus", chinese ? "添加电脑" : "Add computer", "pickerAddComputer", add);
        if (manage != null) action(rows, "settings", chinese ? "管理电脑" : "Manage computers", "pickerManageComputers", manage);
        Rect visible = new Rect(); anchor.getWindowVisibleDisplayFrame(visible);
        int width = PopupSurface.menuWidth(anchor.getContext(), visible, PopupSurface.COMPACT_MENU_MAX_WIDTH_DP);
        int[] position = new int[2]; anchor.getLocationOnScreen(position);
        int belowTop = position[1] + anchor.getHeight() + dp(8), aboveBottom = position[1] - dp(8);
        int belowSpace = Math.max(0, visible.bottom - dp(8) - belowTop);
        int aboveSpace = Math.max(0, aboveBottom - visible.top - dp(8));
        boolean below = belowSpace >= dp(96) || belowSpace >= aboveSpace;
        int limit = Math.max(1, Math.min(dp(520), below ? belowSpace : aboveSpace));
        panel.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(limit, View.MeasureSpec.AT_MOST));
        int height = Math.min(limit, panel.getMeasuredHeight());
        int left = Math.max(visible.left + dp(12), Math.min(position[0] + anchor.getWidth() - width, visible.right - width - dp(12)));
        int top = below ? belowTop : aboveBottom - height;
        popup.setWidth(width); popup.setHeight(height);
        panel.capture(anchor.getRootView(), left, top, width, height);
        popup.showAtLocation(anchor, Gravity.TOP | Gravity.LEFT, left, top);
    }

    private LinearLayout row(LinearLayout parent, String icon, String tag, Runnable action) {
        LinearLayout row = new LinearLayout(parent.getContext()); row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(56)); row.setPadding(dp(14), dp(12), dp(14), dp(12)); row.setTag(tag); row.setFocusable(true);
        row.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_PAGE), null, style.rounded(Color.WHITE)));
        row.setOnClickListener(view -> { dismiss(); action.run(); });
        ImageView image = new ImageView(parent.getContext()); image.setImageDrawable(new LineIcon(icon, style.ink));
        image.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        row.addView(image, new LinearLayout.LayoutParams(dp(24), dp(24)));
        parent.addView(row, new LinearLayout.LayoutParams(-1, -2)); return row;
    }

    private void action(LinearLayout parent, String icon, String title, String tag, Runnable action) {
        LinearLayout row = row(parent, icon, tag, action);
        TextView label = label(title, 17, style.ink); label.setPadding(dp(14), 0, 0, 0); row.addView(label);
    }

    private TextView label(String value, int size, int color) {
        TextView label = new TextView(panel.getContext()); label.setText(value); label.setTextSize(size); label.setTextColor(color); return label;
    }

    void state(String address, String value, boolean online) {
        TextView label = states.get(address);
        if (label != null) { label.setText(value); label.setTextColor(online ? style.accent : style.muted); }
    }

    boolean isShowing() { return popup.isShowing(); }
    void onDismiss(Runnable action) { popup.setOnDismissListener(action::run); }
    void dismiss() { popup.dismiss(); }
    private int dp(int value) { return style.dp(value); }
}
