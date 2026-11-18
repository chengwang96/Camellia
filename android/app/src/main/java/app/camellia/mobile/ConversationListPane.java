package app.camellia.mobile;

import android.content.Context;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** The same full list stays mounted beside the empty preview and an opened chat. */
final class ConversationListPane {
    static final int WIDTH_DP = 320;
    final String scope;
    final LinearLayout root, content;
    final ScrollView scroll;
    final TextView status;
    TextView connection;
    boolean initialized;

    ConversationListPane(String scope, LinearLayout root, ScrollView scroll, LinearLayout content, TextView status) {
        this.scope = scope; this.root = root; this.scroll = scroll; this.content = content; this.status = status;
        root.setTag("conversationListPane");
    }

    static ConversationListPane create(Context context, ChatStyle style, String scope, int sideDp) {
        float density = context.getResources().getDisplayMetrics().density;
        LinearLayout root = new LinearLayout(context); root.setOrientation(LinearLayout.VERTICAL);
        root.setBackground(style.pageBackground());
        root.setPadding(Math.round(sideDp * density), Math.round(10 * density), Math.round(sideDp * density), 0);
        root.setFocusableInTouchMode(true); root.requestFocus();
        RefreshScrollView scroll = new RefreshScrollView(context); scroll.setFillViewport(true);
        scroll.setTag("conversationListScroll");
        scroll.setVerticalScrollBarEnabled(false); scroll.setRefreshIndicatorVisible(false);
        LinearLayout content = new LinearLayout(context); content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(0, 0, 0, Math.round(16 * density)); scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        TextView status = new TextView(context); status.setTextSize(Palette.TEXT_TINY);
        status.setTextColor(style.muted); status.setVisibility(View.GONE);
        return new ConversationListPane(scope, root, scroll, content, status);
    }

    View takeView() {
        if (root.getParent() instanceof ViewGroup) ((ViewGroup) root.getParent()).removeView(root);
        return root;
    }

    void select(String prefix, String id) { select(content, prefix, id); }

    private void select(View view, String prefix, String id) {
        if (view instanceof ConversationRow && view.getTag() instanceof String) {
            String tag = (String) view.getTag();
            if (tag.startsWith(prefix)) ((ConversationRow) view).activeConversation(tag.equals(prefix + id));
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) select(group.getChildAt(index), prefix, id);
        }
    }
}
