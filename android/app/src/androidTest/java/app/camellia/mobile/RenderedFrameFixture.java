package app.camellia.mobile;

import android.app.Instrumentation;
import android.graphics.Bitmap;
import android.view.View;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Main-thread idleness does not mean the hardware renderer has submitted its frame. */
final class RenderedFrameFixture {
    static Bitmap screenshot(Instrumentation instrumentation, View view) throws Exception {
        instrumentation.waitForIdleSync();
        // Submit a second frame so the first has advanced through the swap chain.
        // This also uploads mutable backdrop bitmaps before sampling screen pixels.
        for (int frame = 0; frame < 2; frame++) {
            CountDownLatch committed = new CountDownLatch(1);
            instrumentation.runOnMainSync(() -> {
                if (!view.isAttachedToWindow() || !view.isHardwareAccelerated())
                    throw new AssertionError("Screenshot fixture requires an attached hardware-rendered view");
                view.getViewTreeObserver().registerFrameCommitCallback(committed::countDown);
                view.invalidate();
            });
            if (!committed.await(5, TimeUnit.SECONDS))
                throw new AssertionError("Hardware renderer did not commit the screenshot frame");
        }
        Bitmap image = instrumentation.getUiAutomation().takeScreenshot();
        if (image == null) throw new AssertionError("Unable to capture the rendered screen");
        return image;
    }
}
