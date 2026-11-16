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
                     Runnable rename, Runnable select, Runnable pin, Runnable archive, Runnable delete) {
        this(anchor, style, chinese, pinned, rename, select, pin, archive, delete, null);
    }
    @android.annotation.SuppressLint("RtlHardcoded")
    ConversationMenu(View anchor, ChatStyle style, boolean chinese, boolean pinned,
                     Runnable rename, Runnable select, Runnable pin, Runnable archive, Runnable delete, Runnable fork) {
        this(anchor, style, labels(chinese, pinned, fork != null), fork == null
            ? new String[]{"edit", "select", "pin", "archive", "delete"}
            : new String[]{"edit", "select", "pin", "branch", "archive", "delete"}, fork == null
            ? new Runnable[]{rename, select, pin, archive, delete} : new Runnable[]{rename, select, pin, fork, archive, delete});
    }

    private static String[] labels(boolean chinese, boolean pinned, boolean fork) {
        if (fork) return chinese ? new String[]{"重命名", "多选", pinned ? "取消置顶" : "置顶", "分叉会话", "归档会话", "删除"}
            : new String[]{"Rename", "Select", pinned ? "Unpin" : "Pin", "Fork", "Archive", "Delete"};
        return chinese ? new String[]{"重命名", "多选", pinned ? "取消置顶" : "置顶", "归档会话", "删除"}
            : new String[]{"Rename", "Select", pinned ? "Unpin" : "Pin", "Archive", "Delete"};
    }

    @android.annotation.SuppressLint("RtlHardcoded")
    ConversationMenu(View anchor, ChatStyle style, String[] names, String[] icons, Runnable[] actions) {
        if (names.length != icons.length || names.length != actions.length) throw new IllegalArgumentException("Menu entries must align");
        android.content.Context context = anchor.getContext();
        int color = style.background;
        if (Color.red(color) < 128) color = Color.rgb(
            Math.round(Color.red(color) * .3f + Color.red(style.surface) * .7f),
            Math.round(Color.green(color) * .3f + Color.green(style.surface) * .7f),
            Math.round(Color.blue(color) * .3f + Color.blue(style.surface) * .7f));
        panel = new PopupSurface(context, color); panel.setTag("conversationMenu");
        LinearLayout rows = new LinearLayout(context); rows.setOrientation(LinearLayout.VERTICAL);
        rows.setPadding(dp(anchor, 8), dp(anchor, 8), dp(anchor, 8), dp(anchor, 8));
        ScrollView scroll = ScrollViews.plain(context); scroll.setFillViewport(true); scroll.setVerticalScrollBarEnabled(false);
        scroll.addView(rows); panel.addView(scroll);
        popup = new PopupWindow(panel, -2, -2, true);
        GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(anchor, 26));
        popup.setBackgroundDrawable(shape);
        popup.setElevation(dp(anchor, 8)); popup.setOutsideTouchable(true);
        popup.setInputMethodMode(PopupWindow.INPUT_METHOD_NOT_NEEDED);
        int preferredWidth = dp(anchor, 192);
        for (int index = 0; index < names.length; index++) {
            TextView row = new TextView(context); row.setText(names[index]); row.setTextSize(Palette.TEXT_DIALOG);
            int ink = icons[index].equals("delete") ? new SettingsStyle(context).error : style.ink;
            row.setTextColor(ink); row.setGravity(Gravity.CENTER_VERTICAL);
            row.setSingleLine(true); row.setEllipsize(android.text.TextUtils.TruncateAt.END); row.setTooltipText(names[index]);
            preferredWidth = Math.max(preferredWidth, (int) Math.ceil(row.getPaint().measureText(names[index])) + dp(anchor, 85));
            row.setPadding(dp(anchor, 16), 0, dp(anchor, 16), 0);
            LineIcon icon = new LineIcon(icons[index], ink); icon.setBounds(0, 0, dp(anchor, 23), dp(anchor, 23));
            row.setCompoundDrawablesRelative(icon, null, null, null); row.setCompoundDrawablePadding(dp(anchor, 14));
            row.setTag("conversationAction:" + icons[index]); row.setFocusable(true);
            row.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_PAGE), null, style.rounded(Color.WHITE)));
            Runnable action = actions[index]; row.setOnClickListener(view -> { dismiss(); action.run(); });
            rows.addView(row, new LinearLayout.LayoutParams(-1, dp(anchor, 56)));
        }
        Rect visible = PopupSurface.visibleFrame(anchor);
        int[] location = new int[2]; anchor.getLocationOnScreen(location);
        int width = Math.min(preferredWidth, PopupSurface.menuWidth(context, visible, PopupSurface.COMPACT_MENU_MAX_WIDTH_DP));
        int height = Math.min(dp(anchor, names.length * 56 + 16), visible.height() - dp(anchor, 16));
        int left = Math.max(visible.left + dp(anchor, 12), Math.min(location[0], visible.right - width - dp(anchor, 12)));
        int top = Math.max(visible.top + dp(anchor, 8), Math.min(location[1] + anchor.getHeight(), visible.bottom - height - dp(anchor, 8)));
        popup.setWidth(width); popup.setHeight(height);
        panel.capture(anchor.getRootView(), left, top, width, height);
        popup.showAtLocation(anchor, Gravity.TOP | Gravity.LEFT, left, top);
    }

    void dismiss() { popup.dismiss(); }
    boolean isShowing() { return popup.isShowing(); }
    private static int dp(View view, int value) { return Math.round(value * view.getResources().getDisplayMetrics().density); }
}
