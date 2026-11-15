package app.camellia.mobile;

import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;

/** Shared viewport clipping and composer clearance for all conversation types. */
final class ChatDockLayout {
    private ChatDockLayout() {}
    static void attach(LinearLayout root, ScrollView scroll, LinearLayout content,
                       LinearLayout dock, ChatStyle style, String tag) {
        int index = root.indexOfChild(scroll);
        LinearLayout.LayoutParams placement = (LinearLayout.LayoutParams) scroll.getLayoutParams();
        root.removeView(scroll);
        FrameLayout stage = new FrameLayout(root.getContext()); stage.setTag(tag + "Stage");
        stage.setClipChildren(false); stage.setClipToPadding(false);
        FrameLayout viewport = new FrameLayout(root.getContext()); viewport.setTag(tag + "Viewport");
        viewport.setClipChildren(true); viewport.setClipToPadding(true);
        viewport.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
        stage.addView(viewport, new FrameLayout.LayoutParams(-1, -1));
        dock.setTag(tag + "Dock"); dock.setClipChildren(false); dock.setClipToPadding(false);
        style.reserveDockSpace(dock, content);
        stage.addView(dock, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
        root.addView(stage, index, placement);
    }
}
