package app.camellia.mobile;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class MobileOrientationTest {
    @Test public void phonesStayPortraitInEitherCurrentOrientation() {
        assertTrue(MobileOrientation.isPhoneSize(1080, 2400, 3f));
        assertTrue(MobileOrientation.isPhoneSize(2400, 1080, 3f));
    }

    @Test public void tabletsRemainRotatable() {
        assertFalse(MobileOrientation.isPhoneSize(1600, 2560, 2f));
        assertFalse(MobileOrientation.isPhoneSize(2560, 1600, 2f));
    }

    @Test public void smallestWidthAtLeastSixHundredDpIsTablet() {
        assertTrue(MobileOrientation.isPhoneSize(599, 900, 1f));
        assertFalse(MobileOrientation.isPhoneSize(600, 900, 1f));
    }
}
