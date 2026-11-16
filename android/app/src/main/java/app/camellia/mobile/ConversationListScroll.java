package app.camellia.mobile;

import android.graphics.Rect;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.widget.ScrollView;

/** Keeps a conversation list's visible row through page rebuilds and list refreshes. */
final class ConversationListScroll {
    private Bundle positions = new Bundle();
    private String scope;
    private ScrollView scroll;
    private ViewGroup content;
    private Bundle context, pending;
    private ViewTreeObserver.OnPreDrawListener restore;

    void attach(String key, ScrollView viewport, ViewGroup rows) {
        detach();
        scope = key; scroll = viewport; content = rows;
        Bundle saved = positions.getBundle(key);
        Bundle savedContext = saved == null ? null : saved.getBundle("context");
        context = savedContext == null ? new Bundle() : new Bundle(savedContext);
        pending = saved == null ? null : new Bundle(saved);
    }

    Bundle context() { return context; }

    void beforeRender() {
        if (scroll != null && pending == null) pending = capture();
        cancelRestore();
    }

    void afterRender(boolean placeholder) {
        if (scroll == null) return;
        cancelRestore();
        // Apply after measurement, before the first visible frame. Keep the
        // destination across a temporary loading/error placeholder and across
        // several cached/live renders arriving in the same frame.
        restore = () -> {
            cancelRestore();
            if (placeholder) { scroll.scrollTo(0, 0); return true; }
            int y = pending == null ? 0 : pending.getInt("y");
            String anchor = pending == null ? null : pending.getString("anchor");
            View row = anchor == null ? null : content.findViewWithTag(anchor);
            if (row != null) y = bounds(row).top - pending.getInt("offset");
            scroll.scrollTo(0, Math.max(0, y));
            pending = null;
            return true;
        };
        scroll.getViewTreeObserver().addOnPreDrawListener(restore);
        scroll.invalidate();
    }

    void detach() {
        remember(); cancelRestore();
        scope = null; scroll = null; content = null; context = null; pending = null;
    }

    Bundle save() { remember(); return new Bundle(positions); }

    void load(Bundle saved) { if (saved != null) positions = new Bundle(saved); }

    private void remember() {
        if (scroll == null) return;
        Bundle position = pending == null ? capture() : new Bundle(pending);
        position.putBundle("context", new Bundle(context));
        positions.putBundle(scope, position);
    }

    private Bundle capture() {
        Bundle position = new Bundle();
        int y = scroll.getScrollY();
        position.putInt("y", y);
        if (y > 0) {
            View anchor = firstVisible(content, y);
            if (anchor != null) {
                position.putString("anchor", (String) anchor.getTag());
                position.putInt("offset", bounds(anchor).top - y);
            }
        }
        return position;
    }

    private View firstVisible(ViewGroup parent, int y) {
        for (int i = 0; i < parent.getChildCount(); i++) {
            View child = parent.getChildAt(i);
            if (child.getVisibility() != View.VISIBLE) continue;
            Object tag = child.getTag();
            if (tag instanceof String && (((String) tag).startsWith("conversation:")
                    || ((String) tag).startsWith("localConversation:")
                    || ((String) tag).startsWith("group:") || ((String) tag).startsWith("localGroup:"))) {
                Rect rect = bounds(child);
                if (rect.bottom > y && rect.top < y + scroll.getHeight()) return child;
            }
            if (child instanceof ViewGroup) {
                View found = firstVisible((ViewGroup) child, y);
                if (found != null) return found;
            }
        }
        return null;
    }

    private Rect bounds(View row) {
        Rect rect = new Rect(); row.getDrawingRect(rect);
        content.offsetDescendantRectToMyCoords(row, rect);
        return rect;
    }

    private void cancelRestore() {
        if (restore != null && scroll != null && scroll.getViewTreeObserver().isAlive())
            scroll.getViewTreeObserver().removeOnPreDrawListener(restore);
        restore = null;
    }
}
