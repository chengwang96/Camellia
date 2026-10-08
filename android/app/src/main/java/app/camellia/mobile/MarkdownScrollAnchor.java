package app.camellia.mobile;

import android.view.View;
import android.widget.ScrollView;
import android.view.ViewTreeObserver;
import java.util.function.BooleanSupplier;

/** Capture at actual patch time, rather than when a background parse was requested. */
final class MarkdownScrollAnchor implements StreamingMarkdownView.Listener {
    private final ScrollView scroll;
    private final BooleanSupplier current;
    private final int threshold;
    private int position;
    private boolean following;
    private ViewTreeObserver.OnPreDrawListener pending;
    MarkdownScrollAnchor(ScrollView scroll, BooleanSupplier current) {
        this.scroll = scroll; this.current = current;
        threshold = Math.round(120 * scroll.getResources().getDisplayMetrics().density);
    }
    @Override public void before() {
        close();
        position = scroll.getScrollY(); View content = scroll.getChildAt(0);
        following = content == null || content.getHeight() - position - scroll.getHeight() < threshold;
    }
    @Override public void after() {
        int captured = position; boolean bottom = following;
        pending = () -> {
            View content = scroll.getChildAt(0);
            if (current.getAsBoolean() && (scroll.isLayoutRequested() || content != null && content.isLayoutRequested())) return true;
            close();
            // Layout/focus restoration can itself change scrollY. Use the position
            // captured immediately before this patch, after any background parsing.
            if (current.getAsBoolean()) scroll.scrollTo(0, bottom && content != null ? content.getHeight() : captured);
            return true;
        };
        scroll.getViewTreeObserver().addOnPreDrawListener(pending); scroll.invalidate();
    }
    @Override public void close() {
        if (pending != null && scroll.getViewTreeObserver().isAlive()) scroll.getViewTreeObserver().removeOnPreDrawListener(pending);
        pending = null;
    }
}
