package app.camellia.mobile;

import android.content.Context;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.function.Supplier;

/** Keeps unchanged Workbench cards attached across desktop list snapshots. */
final class WorkbenchList extends LinearLayout {
    static final class Item {
        final String key, presentation;
        final Supplier<View> create;

        Item(String key, String presentation, Supplier<View> create) {
            this.key = key; this.presentation = presentation; this.create = create;
        }
    }

    private static final class Binding {
        final String presentation;
        final View view;

        Binding(String presentation, View view) { this.presentation = presentation; this.view = view; }
    }

    private final ScrollView scroll;
    private LinkedHashMap<String, Binding> bindings = new LinkedHashMap<>();
    private String anchorKey;
    private int anchorOffset;

    WorkbenchList(Context context, ScrollView scroll) {
        super(context);
        this.scroll = scroll;
        setOrientation(VERTICAL);
        setTag("homeConversations");
    }

    void show(List<Item> items) {
        LinkedHashMap<String, Binding> next = new LinkedHashMap<>();
        for (Item item : items) {
            Binding previous = bindings.get(item.key);
            next.put(item.key, previous != null && previous.presentation.equals(item.presentation)
                ? previous : new Binding(item.presentation, item.create.get()));
        }
        // Use a surviving visible card as the anchor when rows are inserted,
        // removed or moved above it. Leave a page at the top pinned to the top.
        if (anchorKey == null && scroll.getScrollY() > getTop()) {
            for (var entry : bindings.entrySet()) {
                View view = entry.getValue().view;
                if (getTop() + view.getBottom() <= scroll.getScrollY() || !next.containsKey(entry.getKey())) continue;
                anchorKey = entry.getKey();
                anchorOffset = getTop() + view.getTop() - scroll.getScrollY();
                break;
            }
        }
        java.util.Set<View> retained = new java.util.HashSet<>();
        for (Binding binding : next.values()) retained.add(binding.view);
        for (int index = getChildCount() - 1; index >= 0; index--)
            if (!retained.contains(getChildAt(index))) removeViewAt(index);
        int index = 0;
        for (Binding binding : next.values()) {
            View view = binding.view;
            if (getChildAt(index) != view) {
                if (view.getParent() == this) removeView(view);
                addView(view, index);
            }
            index++;
        }
        bindings = next;
        // No layout is requested for an unchanged presentation.
        if (!isLayoutRequested()) anchorKey = null;
    }

    @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        super.onLayout(changed, left, top, right, bottom);
        if (anchorKey != null) {
            Binding anchor = bindings.get(anchorKey);
            if (anchor != null) scroll.scrollTo(0, getTop() + anchor.view.getTop() - anchorOffset);
            anchorKey = null;
        }
    }
}
