package app.camellia.mobile;

import android.content.Context;
import android.graphics.Rect;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.Locale;
import java.util.function.IntConsumer;

/** Anchored single selection; filtering always retains each option's original index. */
final class ChoiceDropdown {
    final PopupSurface panel;
    private final PopupWindow popup;
    private final SettingsStyle style;
    private final View anchor;
    private final String[] labels;
    private int selected;
    private final boolean chinese;
    private final IntConsumer choose;
    private final LinearLayout rows, options;
    private final int alignment;
    private EditText search;
    private final ViewTreeObserver.OnGlobalLayoutListener layout = this::position;
    private ViewTreeObserver anchorObserver, panelObserver;
    private final View.OnAttachStateChangeListener attachment = new View.OnAttachStateChangeListener() {
        public void onViewAttachedToWindow(View view) {}
        public void onViewDetachedFromWindow(View view) { dismiss(); }
    };
    private Runnable dismissed = () -> {};
    private int width, lastXOffset, lastYOffset, lastHeight;

    ChoiceDropdown(View anchor, String title, String[] labels, int selected, boolean searchable, IntConsumer choose) {
        this(anchor, title, labels, selected, searchable, Gravity.END, choose);
    }

    ChoiceDropdown(View anchor, String title, String[] labels, int selected, boolean searchable, int alignment, IntConsumer choose) {
        this(anchor, title, labels, selected, searchable, alignment, null, choose);
    }

    ChoiceDropdown(View anchor, String title, String[] labels, int selected, boolean searchable, int alignment, View footer, IntConsumer choose) {
        this.anchor = anchor; this.labels = labels.clone(); this.selected = selected; this.choose = choose;
        this.alignment = alignment;
        Context context = anchor.getContext(); style = new SettingsStyle(context);
        chinese = context.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        panel = new PopupSurface(context, style.card); panel.setTag("choiceDropdown"); panel.setContentDescription(title);
        LinearLayout content = new LinearLayout(context); content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(6), dp(6), dp(6), dp(6)); content.setFocusableInTouchMode(true);
        panel.addView(content, new FrameLayout.LayoutParams(-1, -2));
        rows = new LinearLayout(context); rows.setOrientation(LinearLayout.VERTICAL);
        if (searchable) {
            search = new EditText(context); search.setTag("dropdownSearch"); search.setSingleLine(true);
            search.setTextSize(Palette.TEXT_BODY); search.setTextColor(style.ink); search.setHintTextColor(style.secondary);
            search.setHint(chinese ? "搜索" : "Search"); search.setContentDescription((chinese ? "搜索" : "Search ") + title);
            search.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
            search.setBackground(style.fieldBackground(style.fieldBorder)); search.setPadding(dp(12), dp(8), dp(12), dp(8));
            search.setSaveEnabled(false); search.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(44)); params.bottomMargin = dp(6);
            content.addView(search, params);
            search.addTextChangedListener(new TextWatcher() {
                public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
                public void onTextChanged(CharSequence text, int start, int before, int count) { filter(text.toString()); position(); }
                public void afterTextChanged(Editable text) {}
            });
        }
        ScrollView scroll = ScrollViews.plain(context); scroll.setTag("dropdownScroll"); scroll.setVerticalScrollBarEnabled(false);
        options = new LinearLayout(context); options.setOrientation(LinearLayout.VERTICAL);
        options.addView(rows, new LinearLayout.LayoutParams(-1, -2));
        if (footer != null) options.addView(footer, new LinearLayout.LayoutParams(-1, -2));
        scroll.addView(options); content.addView(scroll, new LinearLayout.LayoutParams(-1, -2, 1));
        popup = new PopupWindow(panel, -2, -2, true); popup.setBackgroundDrawable(style.round(style.card, Palette.RADIUS_GROUP));
        popup.setElevation(dp(8)); popup.setOutsideTouchable(true);
        popup.setInputMethodMode(searchable ? PopupWindow.INPUT_METHOD_NEEDED : PopupWindow.INPUT_METHOD_NOT_NEEDED);
        popup.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        popup.setOnDismissListener(() -> {
            if (anchorObserver != null && anchorObserver.isAlive()) anchorObserver.removeOnGlobalLayoutListener(layout);
            if (panelObserver != null && panelObserver.isAlive()) panelObserver.removeOnGlobalLayoutListener(layout);
            anchorObserver = null; panelObserver = null;
            anchor.removeOnAttachStateChangeListener(attachment);
            indicator(anchor, false); dismissed.run();
        });
        filter("");
        int preferred = dp(footer == null ? 180 : 232);
        for (int i = 0; i < rows.getChildCount(); i++) if (rows.getChildAt(i) instanceof ChatChoiceRow row)
            preferred = Math.max(preferred, row.preferredWidth() + dp(12));
        width = Math.min(preferred, PopupSurface.menuWidth(context, PopupSurface.visibleFrame(anchor), PopupSurface.MODEL_MENU_MAX_WIDTH_DP));
        content.requestFocus(); position(); indicator(anchor, true);
        anchorObserver = anchor.getViewTreeObserver(); panelObserver = panel.getViewTreeObserver();
        anchorObserver.addOnGlobalLayoutListener(layout);
        panelObserver.addOnGlobalLayoutListener(layout);
        anchor.addOnAttachStateChangeListener(attachment);
    }

    private void filter(String query) {
        rows.removeAllViews(); String normalized = query.trim().toLowerCase(Locale.ROOT);
        for (int i = 0; i < labels.length; i++) {
            if (!labels[i].toLowerCase(Locale.ROOT).contains(normalized)) continue;
            final int index = i;
            ChatChoiceRow row = new ChatChoiceRow(anchor.getContext(), chinese, style.ink, style.secondary, labels[i], "", null,
                i == selected, "dropdownChoice:" + i, () -> { dismiss(); if (index != selected) choose.accept(index); });
            row.setAccessibilityDelegate(new View.AccessibilityDelegate() {
                @Override public void onInitializeAccessibilityNodeInfo(View view, android.view.accessibility.AccessibilityNodeInfo info) {
                    super.onInitializeAccessibilityNodeInfo(view, info); info.setClassName("android.widget.RadioButton");
                    info.setCheckable(true); info.setChecked(index == selected);
                }
            });
            rows.addView(row);
        }
        if (rows.getChildCount() == 0) {
            TextView empty = style.label(chinese ? "没有匹配项" : "No matches", Palette.TEXT_NOTE, style.secondary);
            empty.setTag("dropdownEmpty"); empty.setPadding(dp(12), dp(14), dp(12), dp(14)); rows.addView(empty);
        }
    }

    @android.annotation.SuppressLint("RtlHardcoded")
    private void position() {
        if (popup == null) return;
        if (!anchor.isAttachedToWindow()) { dismiss(); return; }
        Rect visible = PopupSurface.visibleFrame(anchor); int[] origin = new int[2]; anchor.getLocationOnScreen(origin);
        int belowTop = origin[1] + anchor.getHeight() + dp(6), aboveBottom = origin[1] - dp(6);
        int belowSpace = Math.max(0, visible.bottom - dp(8) - belowTop), aboveSpace = Math.max(0, aboveBottom - visible.top - dp(8));
        boolean below = belowSpace >= dp(160) || belowSpace >= aboveSpace;
        int limit = Math.max(1, Math.min(dp(420), below ? belowSpace : aboveSpace));
        // Glass backdrop layers fill their parent. Measure the options themselves
        // so a short menu, or a filtered result, never expands to the height cap.
        options.measure(View.MeasureSpec.makeMeasureSpec(Math.max(1, width - dp(12)), View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        int nextHeight = Math.max(1, Math.min(limit, options.getMeasuredHeight() + dp(search == null ? 12 : 62)));
        panel.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(nextHeight, View.MeasureSpec.EXACTLY));
        int edge = Gravity.getAbsoluteGravity(alignment, anchor.getLayoutDirection());
        int alignedLeft = origin[0];
        if (edge == Gravity.RIGHT) alignedLeft += anchor.getWidth() - width;
        if (edge == Gravity.CENTER_HORIZONTAL) alignedLeft += (anchor.getWidth() - width) / 2;
        int nextLeft = Math.max(visible.left + dp(12), Math.min(alignedLeft, visible.right - width - dp(12)));
        int nextTop = below ? belowTop : aboveBottom - nextHeight;
        // The glass samples screen coordinates. The popup is attached to the
        // anchor so Android can place it in the correct activity or dialog.
        int xOffset = nextLeft - origin[0];
        int yOffset = nextTop - origin[1] - anchor.getHeight();
        if (popup.isShowing()) {
            if (lastXOffset != xOffset || lastYOffset != yOffset || lastHeight != nextHeight)
                popup.update(anchor, xOffset, yOffset, width, nextHeight);
        } else {
            popup.setWidth(width); popup.setHeight(nextHeight);
            panel.capture(anchor.getRootView(), nextLeft, nextTop, width, nextHeight);
            popup.showAsDropDown(anchor, xOffset, yOffset, Gravity.LEFT);
        }
        lastXOffset = xOffset; lastYOffset = yOffset; lastHeight = nextHeight;
    }

    /** Use one line chevron for a field or a preference/filter row. */
    static void indicator(View anchor, boolean expanded) {
        SettingsStyle style = new SettingsStyle(anchor.getContext());
        LineIcon arrow = new LineIcon(expanded ? "up" : "down", style.secondary);
        if (anchor instanceof TextView text) {
            arrow.setBounds(0, 0, style.dp(14), style.dp(14)); text.setCompoundDrawablePadding(style.dp(10));
            text.setCompoundDrawablesRelative(null, null, arrow, null);
        } else if (anchor instanceof android.view.ViewGroup group && group.getChildCount() > 0
                && group.getChildAt(group.getChildCount() - 1) instanceof ImageView image) image.setImageDrawable(arrow);
        anchor.setSelected(expanded);
    }
    void onDismiss(Runnable action) { dismissed = action; }
    boolean isShowing() { return popup.isShowing(); }
    void setSelected(int value) {
        if (selected == value) return;
        selected = value;
        filter(search == null ? "" : search.getText().toString());
        position();
    }

    void dismiss() { popup.dismiss(); }
    private int dp(int value) { return style.dp(value); }
}
