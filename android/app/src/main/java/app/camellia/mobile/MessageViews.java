package app.camellia.mobile;

import android.view.View;
import android.widget.LinearLayout;
import java.util.List;

final class MessageViews {
    private MessageViews() { }
    static void reconcile(LinearLayout parent, List<View> desired) {
        for (int index = 0; index < desired.size(); index++) {
            View view = desired.get(index);
            if (parent.getChildCount() > index && parent.getChildAt(index) == view) continue;
            if (view.getParent() == parent) parent.removeView(view);
            if (parent.getChildCount() > index) parent.removeViewAt(index);
            parent.addView(view, index);
        }
        while (parent.getChildCount() > desired.size()) parent.removeViewAt(parent.getChildCount() - 1);
    }
}
