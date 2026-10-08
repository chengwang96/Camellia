package app.camellia.mobile;

import android.content.Context;
import android.app.Activity;
import android.os.Build;
import android.view.HapticFeedbackConstants;
import android.view.View;
import org.json.JSONArray;

final class MobileHaptics {
    static boolean enabled(Context context) {
        return !MobilePreferences.get(context, "hapticFeedback").equals("disabled");
    }

    private static boolean apply(View view) {
        boolean enabled = enabled(view.getContext());
        view.setHapticFeedbackEnabled(enabled);
        return enabled;
    }

    static boolean perform(View view, int feedback) {
        return apply(view) && view.performHapticFeedback(feedback);
    }

    static boolean success(View view) {
        return perform(view, Build.VERSION.SDK_INT >= 30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.CLOCK_TICK);
    }

    static boolean pendingRequests(Activity activity, View view, String scope, JSONArray requests) {
        if (view == null || requests == null || requests.length() == 0 || activity.isFinishing()
                || !activity.hasWindowFocus() || !view.isAttachedToWindow() || !view.isShown()) return false;
        var preferences = activity.getSharedPreferences("mobile-haptic-notices", Context.MODE_PRIVATE);
        RemoteApprovalNotices notices = new RemoteApprovalNotices(preferences.getString("approvals", "[]"));
        if (!notices.observe(scope, requests)) return false;
        // Also acknowledge notices while disabled, so enabling feedback does not replay them.
        preferences.edit().putString("approvals", notices.serialize()).apply();
        return perform(view, HapticFeedbackConstants.CONTEXT_CLICK);
    }

    static void setOnLongClickListener(View view, View.OnLongClickListener listener) {
        apply(view);
        view.setOnLongClickListener(selected -> {
            // Android supplies the long-press feedback after a handled callback.
            // Read the preference here so existing views respond immediately.
            apply(selected);
            return listener.onLongClick(selected);
        });
    }
}
