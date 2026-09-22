package app.camellia.mobile;

import android.test.InstrumentationTestCase;
import android.view.View;
import android.widget.TextView;

public class DisclosureHeaderTest extends InstrumentationTestCase {
    public void testArrowFollowsTitleAndStaysCentered() {
        getInstrumentation().runOnMainSync(() -> {
            for (boolean collapsed : new boolean[] {false, true}) {
                DisclosureHeader header = header("DSH", collapsed, 280);
                TextView title = (TextView) header.getChildAt(0);
                View arrow = header.getChildAt(1);
                assertEquals("DSH", title.getText().toString());
                assertEquals(dp(6), arrow.getLeft() - title.getRight());
                assertEquals(dp(18), arrow.getWidth());
                assertTrue(Math.abs(arrow.getTop() + arrow.getHeight() / 2f - header.getHeight() / 2f) <= 1);
                assertTrue(header.getHeight() >= dp(48));
                assertTrue(arrow.getRight() < header.getWidth() / 2);
                boolean[] clicked = {false};
                header.setOnClickListener(view -> clicked[0] = true);
                header.performClick();
                assertTrue(clicked[0]);
                assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO, arrow.getImportantForAccessibility());
            }
        });
    }

    public void testLongTitleReservesArrowSpace() {
        getInstrumentation().runOnMainSync(() -> {
            DisclosureHeader header = header("A very long workspace name 工作区名称 that must be truncated", false, 160);
            TextView title = (TextView) header.getChildAt(0);
            View arrow = header.getChildAt(1);
            assertTrue(title.getLayout().getEllipsisCount(0) > 0);
            assertEquals(dp(6), arrow.getLeft() - title.getRight());
            assertTrue(arrow.getRight() <= header.getWidth());
            assertEquals(dp(18), arrow.getWidth());
        });
    }

    private DisclosureHeader header(String name, boolean collapsed, int width) {
        DisclosureHeader header = new DisclosureHeader(getInstrumentation().getTargetContext(), name, 0xff222222, 0xff888888, collapsed);
        header.measure(View.MeasureSpec.makeMeasureSpec(dp(width), View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        header.layout(0, 0, header.getMeasuredWidth(), header.getMeasuredHeight());
        return header;
    }

    private int dp(int value) { return Math.round(value * getInstrumentation().getTargetContext().getResources().getDisplayMetrics().density); }
}
