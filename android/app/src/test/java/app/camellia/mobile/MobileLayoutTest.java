package app.camellia.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class MobileLayoutTest {
    @Test public void railUsesTabletWindowWidthAndDoesNotCollapseWithKeyboardHeight() {
        android.content.res.Configuration tablet = new android.content.res.Configuration();
        tablet.smallestScreenWidthDp = 800; tablet.screenWidthDp = 1280; tablet.screenHeightDp = 800;
        assertTrue(MobileLayout.useTabletRail(tablet));
        tablet.screenHeightDp = 350;
        assertTrue(MobileLayout.useTabletRail(tablet));
        tablet.screenWidthDp = 800; tablet.screenHeightDp = 1280;
        assertFalse(MobileLayout.useTabletRail(tablet));
    }

    @Test public void aWidePhoneNeverAcquiresTheTabletNavigation() {
        android.content.res.Configuration phone = new android.content.res.Configuration();
        phone.smallestScreenWidthDp = 411; phone.screenWidthDp = 960; phone.screenHeightDp = 411;
        assertFalse(MobileLayout.useTabletRail(phone));
    }

    @Test public void detailSplitNeedsLandscapeWidthAndHeight() {
        assertTrue(MobileLayout.useDetailSplit(840, 600));
        assertTrue(MobileLayout.useDetailSplit(1280, 800));
        assertFalse(MobileLayout.useDetailSplit(839, 700));
        assertFalse(MobileLayout.useDetailSplit(1280, 599));
        assertFalse(MobileLayout.useDetailSplit(800, 1280));
        assertFalse(MobileLayout.useDetailSplit(850, 390));
    }

    @Test public void sidebarStaysWithinReadableBounds() {
        assertEquals(300, MobileLayout.detailSidebarWidthDp(840));
        assertEquals(336, MobileLayout.detailSidebarWidthDp(1200));
        assertEquals(360, MobileLayout.detailSidebarWidthDp(1600));
    }

    @Test public void composerPermissionExpandsOnlyAtTabletWidth() {
        android.content.res.Configuration phone = new android.content.res.Configuration();
        phone.screenWidthDp = 411;
        android.content.res.Configuration tablet = new android.content.res.Configuration();
        tablet.screenWidthDp = 600;
        assertFalse(MobileLayout.useExpandedComposerControls(phone));
        assertTrue(MobileLayout.useExpandedComposerControls(tablet));
    }

    @Test public void modelSelectorWidthUsesEditorFractionButNeverOverflowsTools() {
        assertEquals(580, ChatComposer.modelWidthLimit(1000, 900, 200, 48));
        assertEquals(260, ChatComposer.modelWidthLimit(1000, 500, 240, 48));
        assertEquals(48, ChatComposer.modelWidthLimit(80, 100, 90, 48));
    }
}
