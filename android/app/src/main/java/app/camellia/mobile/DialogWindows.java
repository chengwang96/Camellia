package app.camellia.mobile;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.ContextWrapper;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.WeakHashMap;

/** Visible dialog order, including forms opened above another sheet. Main thread only. */
final class DialogWindows {
    private static final WeakHashMap<Activity, ArrayList<WeakReference<Dialog>>> windows = new WeakHashMap<>();
    private DialogWindows() {}

    private static Activity owner(Context context) {
        while (context instanceof ContextWrapper && !(context instanceof Activity)) {
            Context base = ((ContextWrapper) context).getBaseContext();
            if (base == context) return null;
            context = base;
        }
        return context instanceof Activity ? (Activity) context : null;
    }

    static void shown(Context context, Dialog dialog) {
        Activity activity = owner(context); if (activity == null) return;
        DisplayRefreshRate.request(dialog.getWindow());
        var shown = windows.computeIfAbsent(activity, ignored -> new ArrayList<>());
        shown.removeIf(reference -> reference.get() == null || reference.get() == dialog);
        shown.add(new WeakReference<>(dialog));
    }

    static void hidden(Context context, Dialog dialog) {
        Activity activity = owner(context); var shown = windows.get(activity); if (shown == null) return;
        shown.removeIf(reference -> reference.get() == null || reference.get() == dialog);
        if (shown.isEmpty()) windows.remove(activity);
    }

    static Dialog focused(Activity activity) {
        var shown = windows.get(activity); if (shown == null) return null;
        Dialog top = null;
        for (int i = shown.size() - 1; i >= 0; i--) {
            Dialog dialog = shown.get(i).get();
            if (dialog == null || !dialog.isShowing() || dialog.getWindow() == null) continue;
            if (dialog.getWindow().getDecorView().hasWindowFocus()) return dialog;
            if (top == null) top = dialog;
        }
        return top;
    }

    static void requestLayout(Activity activity) {
        var shown = windows.get(activity); if (shown == null) return;
        for (var reference : new ArrayList<>(shown)) {
            Dialog dialog = reference.get();
            if (dialog == null || !dialog.isShowing() || dialog.getWindow() == null) continue;
            var decor = dialog.getWindow().getDecorView(); decor.requestApplyInsets(); decor.requestLayout();
        }
    }

    static void dismiss(Activity activity) {
        var shown = windows.get(activity); if (shown == null) return;
        for (var reference : new ArrayList<>(shown)) {
            Dialog dialog = reference.get(); if (dialog != null && dialog.isShowing()) dialog.dismiss();
        }
    }
}
