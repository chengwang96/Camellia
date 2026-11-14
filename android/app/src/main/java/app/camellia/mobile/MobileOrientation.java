package app.camellia.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.graphics.Rect;
import android.os.Build;
import android.util.DisplayMetrics;
import android.view.WindowManager;

/** Keeps phones upright while leaving tablet orientation available for responsive layouts. */
final class MobileOrientation {
    static final int TABLET_MIN_WIDTH_DP = 600;

    private MobileOrientation() {}

    static void lockPhonePortrait(Activity activity) {
        if (isPhone(activity)) {
            if (activity.getRequestedOrientation() != ActivityInfo.SCREEN_ORIENTATION_PORTRAIT) {
                activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
            }
        } else if (activity.getRequestedOrientation() == ActivityInfo.SCREEN_ORIENTATION_PORTRAIT) {
            activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }
    }

    static boolean isPhoneSize(int widthPx, int heightPx, float density) {
        if (widthPx <= 0 || heightPx <= 0 || density <= 0f) return false;
        float widthDp = widthPx / density;
        float heightDp = heightPx / density;
        return Math.min(widthDp, heightDp) < TABLET_MIN_WIDTH_DP;
    }

    private static boolean isPhone(Context context) {
        WindowManager windows = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        if (windows == null) return true;
        float density = context.getResources().getDisplayMetrics().density;
        if (Build.VERSION.SDK_INT >= 30) {
            Rect bounds = windows.getMaximumWindowMetrics().getBounds();
            return isPhoneSize(bounds.width(), bounds.height(), density);
        }
        DisplayMetrics metrics = new DisplayMetrics();
        windows.getDefaultDisplay().getRealMetrics(metrics);
        return isPhoneSize(metrics.widthPixels, metrics.heightPixels, metrics.density);
    }
}
