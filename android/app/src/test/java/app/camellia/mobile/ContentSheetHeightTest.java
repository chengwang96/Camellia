package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class ContentSheetHeightTest {
    @Test public void keepsBothAttachmentSheetsOnOneStableHeight() {
        assertEquals(1329, SettingsStyle.contentSheetHeight(2292, 3f));
        assertEquals(1329, SettingsStyle.contentSheetHeight(2292, 3f));
    }

    @Test public void clampsShortScreensAndRespectsTheVisibleArea() {
        assertEquals(840, SettingsStyle.contentSheetHeight(1000, 2f));
        assertEquals(1329, SettingsStyle.contentSheetHeight(2292, 2f));
        assertEquals(420, SettingsStyle.contentSheetHeight(640, 1f));
    }

    @Test public void neverOverflowsTheAvailableWindow() {
        for (int available : new int[]{0, 200, 480, 900, 1600, 2292, 3200}) {
            for (float density : new float[]{1f, 1.5f, 2f, 3f}) {
                int height = SettingsStyle.contentSheetHeight(available, density);
                assertTrue(height >= 0);
                assertTrue("height " + height + " for " + available + "/" + density,
                    height <= Math.max(160, available - Math.round(32 * density)));
            }
        }
    }
}
