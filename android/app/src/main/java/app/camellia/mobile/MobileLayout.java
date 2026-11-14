package app.camellia.mobile;

import android.content.res.Configuration;

/** Width and height decisions shared by the native phone and tablet layouts. */
final class MobileLayout {
    static final int DETAIL_SPLIT_MIN_WIDTH_DP = 840;
    static final int DETAIL_SPLIT_MIN_HEIGHT_DP = 600;
    static final int DETAIL_SIDEBAR_MIN_WIDTH_DP = 300;
    static final int DETAIL_SIDEBAR_MAX_WIDTH_DP = 360;

    private MobileLayout() {}

    static boolean useDetailSplit(int widthDp, int heightDp) {
        return widthDp >= DETAIL_SPLIT_MIN_WIDTH_DP
            && heightDp >= DETAIL_SPLIT_MIN_HEIGHT_DP
            && widthDp > heightDp;
    }

    static boolean useDetailSplit(Configuration configuration) {
        return configuration != null
            && useDetailSplit(configuration.screenWidthDp, configuration.screenHeightDp);
    }

    static int detailSidebarWidthDp(int widthDp) {
        return Math.max(DETAIL_SIDEBAR_MIN_WIDTH_DP,
            Math.min(DETAIL_SIDEBAR_MAX_WIDTH_DP, Math.round(widthDp * 0.28f)));
    }

    static boolean useExpandedComposerControls(Configuration configuration) {
        return configuration != null && configuration.screenWidthDp >= MobileOrientation.TABLET_MIN_WIDTH_DP;
    }
}
