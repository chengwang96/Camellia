package app.camellia.mobile;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.view.Display;
import android.view.Window;
import android.view.WindowManager;

/**
 * Asks every Camellia window to use the highest refresh mode the display
 * offers for the current resolution.
 *
 * Android does not guarantee that an app receives the panel's maximum refresh
 * rate. Both preferences are hints, so devices and system power policies may
 * still choose a lower rate; this class only avoids Camellia itself asking for
 * or inheriting a lower one.
 */
final class DisplayRefreshRate {
    private DisplayRefreshRate() {}

    static void install(Application application) {
        application.registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
            @Override public void onActivityCreated(Activity activity, Bundle saved) { request(activity); }
            @Override public void onActivityStarted(Activity activity) {}
            @Override public void onActivityResumed(Activity activity) { request(activity); }
            @Override public void onActivityPaused(Activity activity) {}
            @Override public void onActivityStopped(Activity activity) {}
            @Override public void onActivitySaveInstanceState(Activity activity, Bundle saved) {}
            @Override public void onActivityDestroyed(Activity activity) {}
        });
    }

    static void request(Activity activity) {
        if (activity == null) return;
        request(activity.getWindow());
    }

    static void request(Window window) {
        if (window == null) return;
        Context context = window.getContext();
        if (context == null) return;
        WindowManager windows = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        Display display = Build.VERSION.SDK_INT >= 30 ? context.getDisplay() : null;
        if (display == null && windows != null) display = windows.getDefaultDisplay();
        if (display == null) return;

        Display.Mode[] modes = display.getSupportedModes();
        Display.Mode current = display.getMode();
        if (modes == null || modes.length == 0 || current == null) return;

        int best = highestModeId(
            new Mode(current.getModeId(), current.getPhysicalWidth(), current.getPhysicalHeight(), current.getRefreshRate()),
            java.util.Arrays.stream(modes)
                .map(mode -> new Mode(mode.getModeId(), mode.getPhysicalWidth(), mode.getPhysicalHeight(), mode.getRefreshRate()))
                .toArray(Mode[]::new));
        if (best == current.getModeId()) return;

        WindowManager.LayoutParams attributes = window.getAttributes();
        attributes.preferredDisplayModeId = best;
        window.setAttributes(attributes);
    }

    static final class Mode {
        final int id, width, height;
        final float refreshRate;

        Mode(int id, int width, int height, float refreshRate) {
            this.id = id; this.width = width; this.height = height; this.refreshRate = refreshRate;
        }
    }

    /** Returns the current id when it is already the fastest same-resolution mode. */
    static int highestModeId(Mode current, Mode[] modes) {
        if (current == null || modes == null) return current == null ? 0 : current.id;
        Mode best = current;
        for (Mode mode : modes) {
            if (mode == null || mode.width != current.width || mode.height != current.height) continue;
            if (mode.refreshRate > best.refreshRate) best = mode;
        }
        return best.id;
    }
}
