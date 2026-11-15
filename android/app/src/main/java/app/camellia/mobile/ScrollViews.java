package app.camellia.mobile;

import android.content.Context;
import android.widget.ScrollView;

/** Native scrolling without platform scrollbar chrome on Camellia surfaces. */
final class ScrollViews {
    private ScrollViews() {}
    static ScrollView plain(Context context) {
        return quiet(new ScrollView(context));
    }
    static ScrollView capped(Context context, java.util.function.IntSupplier limit) {
        return quiet(new ScrollView(context) {
            @Override protected void onMeasure(int widthSpec, int heightSpec) {
                int height = limit.getAsInt();
                if (MeasureSpec.getMode(heightSpec) != MeasureSpec.UNSPECIFIED) height = Math.min(height, MeasureSpec.getSize(heightSpec));
                super.onMeasure(widthSpec, MeasureSpec.makeMeasureSpec(height, MeasureSpec.AT_MOST));
            }
        });
    }
    private static ScrollView quiet(ScrollView view) {
        view.setVerticalScrollBarEnabled(false); view.setHorizontalScrollBarEnabled(false);
        return view;
    }
}
