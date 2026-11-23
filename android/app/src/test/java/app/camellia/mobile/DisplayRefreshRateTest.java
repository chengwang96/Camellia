package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class DisplayRefreshRateTest {
    private static DisplayRefreshRate.Mode mode(int id, int width, int height, float rate) {
        return new DisplayRefreshRate.Mode(id, width, height, rate);
    }

    @Test public void choosesTheFastestModeAtTheCurrentResolution() {
        DisplayRefreshRate.Mode current = mode(1, 1080, 2400, 60);
        DisplayRefreshRate.Mode[] modes = {
            mode(1, 1080, 2400, 60), mode(2, 1080, 2400, 90), mode(3, 1080, 2400, 120),
        };
        assertEquals(3, DisplayRefreshRate.highestModeId(current, modes));
    }

    @Test public void ignoresHigherRatesAtOtherResolutions() {
        DisplayRefreshRate.Mode current = mode(1, 1080, 2400, 60);
        DisplayRefreshRate.Mode[] modes = {
            mode(1, 1080, 2400, 60), mode(4, 1440, 3120, 144),
        };
        assertEquals(1, DisplayRefreshRate.highestModeId(current, modes));
    }

    @Test public void keepsTheCurrentModeWhenItIsAlreadyFastest() {
        DisplayRefreshRate.Mode current = mode(7, 1440, 3200, 120);
        assertEquals(7, DisplayRefreshRate.highestModeId(current,
            new DisplayRefreshRate.Mode[] {mode(6, 1440, 3200, 120), mode(7, 1440, 3200, 120), mode(8, 1440, 3200, 90)}));
    }

    @Test public void keepsCurrentModeWhenNoSupportedModeIsFaster() {
        DisplayRefreshRate.Mode current = mode(9, 1080, 2400, 120);
        assertEquals(9, DisplayRefreshRate.highestModeId(current,
            new DisplayRefreshRate.Mode[] {mode(10, 1080, 2400, 60)}));
    }
}
