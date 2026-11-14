package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.test.InstrumentationTestCase;
import android.view.View;

public class PermissionToolTest extends InstrumentationTestCase {
    private Activity activity;

    @Override protected void setUp() throws Exception {
        super.setUp();
        activity = getInstrumentation().startActivitySync(new Intent(
            getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    @Override protected void tearDown() throws Exception {
        if (activity != null) getInstrumentation().runOnMainSync(activity::finish);
        super.tearDown();
    }

    public void testPhoneUsesIconOnlyAndTabletShowsTheLevelLabel() {
        getInstrumentation().runOnMainSync(() -> {
            ChatStyle style = new ChatStyle(activity);
            PermissionTool compact = new PermissionTool(activity, style, false, false, () -> {});
            compact.level("auto", true);
            assertEquals("", compact.labelView().getText().toString());
            assertEquals(android.view.View.GONE, compact.labelView().getVisibility());
            assertEquals("permissionIcon", compact.iconView().getTag());
            assertTrue("The compact permission control must actually paint its shield",
                paintedPixels(compact.iconView(), 32) > 12);
            assertEquals("Safety level: Default", compact.getContentDescription().toString());
            assertTrue(compact.isEnabled());

            PermissionTool expanded = new PermissionTool(activity, style, false, true, () -> {});
            expanded.level("full", true);
            assertEquals("Full", expanded.labelView().getText().toString());
            assertEquals(android.view.View.VISIBLE, expanded.labelView().getVisibility());
            assertTrue(paintedPixels(expanded.iconView(), 32) > 12);

            expanded.level("ask", false);
            assertEquals("Ask", expanded.labelView().getText().toString());
            assertFalse(expanded.isEnabled());
            assertEquals("需确认", PermissionTool.shortLabel("ask", true));
            assertEquals("默认", PermissionTool.shortLabel("auto", true));
            assertEquals("全自动", PermissionTool.shortLabel("full", true));
        });
    }

    private int paintedPixels(View view, int sizeDp) {
        int size = Math.round(sizeDp * activity.getResources().getDisplayMetrics().density);
        view.measure(View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY));
        view.layout(0, 0, size, size);
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        try {
            view.draw(new Canvas(bitmap));
            int[] pixels = new int[size * size];
            bitmap.getPixels(pixels, 0, size, 0, 0, size, size);
            int painted = 0;
            for (int pixel : pixels) if ((pixel >>> 24) != 0) painted++;
            return painted;
        } finally {
            bitmap.recycle();
        }
    }
}
