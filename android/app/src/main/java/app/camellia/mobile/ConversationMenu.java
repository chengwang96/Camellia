package app.camellia.mobile;

import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ScrollView;
import android.widget.TextView;

final class ConversationMenu {
    private final PopupWindow popup;
    final PopupSurface panel;

    @android.annotation.SuppressLint("RtlHardcoded")
    ConversationMenu(View anchor, ChatStyle style, boolean chinese, boolean pinned,
                     Runnable rename, Runnable select, Runnable pin, Runnable delete) {
        android.content.Context context = anchor.getContext();
        int color = style.background;
        if (Color.red(color) < 128) color = Color.rgb(
            Math.round(Color.red(color) * .3f + Color.red(style.surface) * .7f),
            Math.round(Color.green(color) * .3f + Color.green(style.surface) * .7f),
            Math.round(Color.blue(color) * .3f + Color.blue(style.surface) * .7f));
        panel = new PopupSurface(context, color); panel.setTag("conversationMenu");
        LinearLayout rows = new LinearLayout(context); rows.setOrientation(LinearLayout.VERTICAL);
        rows.setPadding(dp(anchor, 8), dp(anchor, 8), dp(anchor, 8), dp(anchor, 8));
        ScrollView scroll = new ScrollView(context); scroll.setFillViewport(true); scroll.setVerticalScrollBarEnabled(false);
        scroll.addView(rows); panel.addView(scroll);
        popup = new PopupWindow(panel, -2, -2, true);
        GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(anchor, 26));
        popup.setBackgroundDrawable(shape);
        popup.setElevation(dp(anchor, 8)); popup.setOutsideTouchable(true);
        popup.setInputMethodMode(PopupWindow.INPUT_METHOD_NOT_NEEDED);
        String[] names = chinese ? new String[] { "重命名", "多选", pinned ? "取消置顶" : "置顶", "删除" }
            : new String[] { "Rename", "Select", pinned ? "Unpin" : "Pin", "Delete" };
        String[] icons = { "edit", "select", "pin", "delete" };
        Runnable[] actions = { rename, select, pin, delete };
        for (int index = 0; index < names.length; index++) {
            TextView row = new TextView(context); row.setText(names[index]); row.setTextSize(18);
            int ink = index == 3 ? new SettingsStyle(context).error : style.ink;
            row.setTextColor(ink); row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(anchor, 16), 0, dp(anchor, 16), 0);
            LineIcon icon = new LineIcon(icons[index], ink); icon.setBounds(0, 0, dp(anchor, 23), dp(anchor, 23));
            row.setCompoundDrawablesRelative(icon, null, null, null); row.setCompoundDrawablePadding(dp(anchor, 14));
            row.setTag("conversationAction:" + icons[index]); row.setFocusable(true);
            row.setBackground(new RippleDrawable(ColorStateList.valueOf(0x224176e6), null, style.rounded(Color.WHITE)));
            Runnable action = actions[index]; row.setOnClickListener(view -> { dismiss(); action.run(); });
            rows.addView(row, new LinearLayout.LayoutParams(-1, dp(anchor, 56)));
        }
        Rect visible = new Rect(); anchor.getWindowVisibleDisplayFrame(visible);
        int[] location = new int[2]; anchor.getLocationOnScreen(location);
        int width = Math.min(dp(anchor, 224), visible.width() - dp(anchor, 24));
        int height = Math.min(dp(anchor, 240), visible.height() - dp(anchor, 16));
        int left = Math.max(visible.left + dp(anchor, 12), Math.min(location[0], visible.right - width - dp(anchor, 12)));
        int top = Math.max(visible.top + dp(anchor, 8), Math.min(location[1] + anchor.getHeight(), visible.bottom - height - dp(anchor, 8)));
        popup.setWidth(width); popup.setHeight(height);
        panel.capture(anchor.getRootView(), left, top, width, height);
        popup.showAtLocation(anchor, Gravity.TOP | Gravity.LEFT, left, top);
    }

    void dismiss() { popup.dismiss(); }
    private static int dp(View view, int value) { return Math.round(value * view.getResources().getDisplayMetrics().density); }
}
