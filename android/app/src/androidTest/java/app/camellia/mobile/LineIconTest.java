package app.camellia.mobile;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.test.InstrumentationTestCase;

public class LineIconTest extends InstrumentationTestCase {
    public void testFolderHasLowerCenteredProfile() {
        Bitmap bitmap = Bitmap.createBitmap(240, 240, Bitmap.Config.ARGB_8888);
        try {
            LineIcon icon = new LineIcon("folder", Color.BLACK);
            icon.setBounds(0, 0, 240, 240); icon.draw(new Canvas(bitmap));
            int left = 240, top = 240, right = -1, bottom = -1;
            for (int row = 0; row < 240; row++) for (int column = 0; column < 240; column++) {
                if (Color.alpha(bitmap.getPixel(column, row)) < 128) continue;
                left = Math.min(left, column); right = Math.max(right, column);
                top = Math.min(top, row); bottom = Math.max(bottom, row);
            }
            assertTrue("Folder width stays unchanged", right - left >= 204 && right - left <= 208);
            assertTrue("Folder is about 15 percent shorter", bottom - top >= 150 && bottom - top <= 155);
            assertTrue("Folder remains vertically centered", Math.abs((top + bottom) / 2f - 119.5f) <= 1);
        } finally { bitmap.recycle(); }
    }
}
