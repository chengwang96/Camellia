package app.camellia.mobile;

import android.app.Activity;
import android.app.Instrumentation;

/** Finish persistence and lifecycle callbacks before the next fixture changes language or theme. */
final class NativeActivityCleanup {
    private NativeActivityCleanup() {}
    static void prepareTabletLandscape(Instrumentation instrumentation) {
        if (instrumentation.getTargetContext().getResources().getConfiguration().smallestScreenWidthDp >= 600
            && !instrumentation.getUiAutomation().setRotation(android.app.UiAutomation.ROTATION_FREEZE_90))
            throw new AssertionError("Freeze the tablet's user rotation before testing child Activity navigation");
    }
    static void finish(Instrumentation instrumentation, Activity activity) throws Exception {
        if (activity == null) return;
        if (!activity.isDestroyed()) instrumentation.runOnMainSync(activity::finish);
        long deadline = android.os.SystemClock.uptimeMillis() + 12000;
        while (!activity.isDestroyed() && android.os.SystemClock.uptimeMillis() < deadline) {
            instrumentation.waitForIdleSync(); android.os.SystemClock.sleep(30);
        }
        if (!activity.isDestroyed()) throw new AssertionError("Finish " + activity.getClass().getSimpleName()
            + " before changing fixture preferences; finishing=" + activity.isFinishing()
            + ", focused=" + activity.hasWindowFocus() + ", changingConfig=" + activity.isChangingConfigurations());
        if (activity instanceof MainActivity) {
            var field = MainActivity.class.getDeclaredField("worker"); field.setAccessible(true);
            var worker = (java.util.concurrent.ExecutorService) field.get(activity);
            if (!worker.awaitTermination(15, java.util.concurrent.TimeUnit.SECONDS)) throw new AssertionError("Drain the previous MainActivity's writes");
        }
    }
}
