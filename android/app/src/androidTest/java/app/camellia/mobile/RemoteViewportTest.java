package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import org.json.JSONObject;

public class RemoteViewportTest extends InstrumentationTestCase {
    private Object field(Activity activity, String name) throws Exception {
        var field = MainActivity.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(activity);
    }

    public void testListContentStaysBelowHeader() throws Exception {
        assertContentStaysBelowHeader("listScreen");
    }

    public void testConversationContentStaysBelowHeader() throws Exception {
        assertContentStaysBelowHeader("detailScreen");
    }

    private void assertContentStaysBelowHeader(String screen) throws Exception {
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        try {
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var credentials = MainActivity.class.getDeclaredField("credentials");
                    credentials.setAccessible(true); credentials.set(activity, new JSONObject());
                    var method = MainActivity.class.getDeclaredMethod(screen);
                    method.setAccessible(true); method.invoke(activity);
                    ((PageTransitions) field(activity, "pages")).finishTransition();
                    LinearLayout content = (LinearLayout) field(activity, "content");
                    content.removeAllViews();
                    View marker = new View(activity); marker.setBackgroundColor(Color.MAGENTA);
                    content.addView(marker, new LinearLayout.LayoutParams(-1, activity.getResources().getDisplayMetrics().heightPixels * 3));
                } catch (Exception error) { throw new AssertionError(error); }
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                try {
                    LinearLayout root = (LinearLayout) field(activity, "root");
                    ScrollView scroll = (ScrollView) field(activity, "scroll");
                    View header = root.getChildAt(0);
                    int[] rootPosition = new int[2], scrollPosition = new int[2];
                    root.getLocationOnScreen(rootPosition); scroll.getLocationOnScreen(scrollPosition);
                    int viewportTop = scrollPosition[1] - rootPosition[1];
                    assertTrue("The viewport must start below the entire header", viewportTop >= header.getBottom());
                    scroll.scrollTo(0, scroll.getHeight() / 2);
                    assertTrue("Exercise a scrolled, overflowing content view", scroll.getScrollY() > 0);
                    Bitmap image = Bitmap.createBitmap(root.getWidth(), root.getHeight(), Bitmap.Config.ARGB_8888);
                    try {
                        root.draw(new Canvas(image));
                        int center = root.getWidth() / 2;
                        assertEquals("The marker must be visible inside the viewport", Color.MAGENTA, image.getPixel(center, viewportTop + 8));
                        for (int vertical = header.getTop(); vertical < viewportTop; vertical++) {
                            assertTrue("Scrolled content must never draw in the header at " + vertical,
                                image.getPixel(center, vertical) != Color.MAGENTA);
                        }
                    } finally { image.recycle(); }
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally {
            getInstrumentation().runOnMainSync(activity::finish);
            getInstrumentation().waitForIdleSync();
        }
    }
}
