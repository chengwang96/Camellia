package app.camellia.mobile;

import android.content.Context;
import android.graphics.Rect;
import android.view.Gravity;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;

/** Full-width fading frost behind the floating destinations, through the bottom inset. */
@android.annotation.SuppressLint("ViewConstructor")
final class NavigationDockLayout extends FrameLayout {
    static final int FADE_HEIGHT_DP = 64;
    static final int BOTTOM_GAP_DP = 8 + WorkbenchNavigation.SHADOW_GAP_DP;
    private final ScrollView scroll;
    private final PopupSurface veil;
    private WorkbenchNavigation navigation;
    private int leftInset, rightInset, bottomInset;
    private int capturedWidth, capturedHeight;
    private boolean keyboardVisible;
    private final ViewTreeObserver.OnGlobalLayoutListener legacyKeyboardObserver = () -> {
        Rect visible = new Rect(); getWindowVisibleDisplayFrame(visible);
        View window = getRootView(); int[] origin = new int[2]; window.getLocationOnScreen(origin);
        setKeyboardVisible(origin[1] + window.getHeight() - visible.bottom > dp(120));
    };

    NavigationDockLayout(Context context, ScrollView scroll) {
        super(context);
        this.scroll = scroll;
        setClipChildren(true);
        setClipToPadding(true);
        addView(scroll, new FrameLayout.LayoutParams(-1, -1));
        scroll.setClipToPadding(false);
        veil = PopupSurface.navigationVeil(context, Palette.of(context).background);
        veil.setTag("navigationVeil");
        veil.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        addView(veil, new FrameLayout.LayoutParams(-1, dp(FADE_HEIGHT_DP + WorkbenchNavigation.HEIGHT_DP + BOTTOM_GAP_DP), Gravity.BOTTOM));
    }

    void setNavigation(WorkbenchNavigation navigation) {
        this.navigation = navigation;
        addView(navigation, new FrameLayout.LayoutParams(-1, dp(WorkbenchNavigation.HEIGHT_DP), Gravity.BOTTOM | Gravity.LEFT));
        // The capsule sits on this material, not on the unfiltered page.
        // Sampling the sibling veil also keeps the two live captures from
        // consuming the same scrolling view's dirty flag in one frame.
        navigation.setBackdropSource(veil);
        updateGeometry();
    }

    void setInsets(int left, int right, int bottom) {
        leftInset = left; rightInset = right; bottomInset = bottom;
        // The header retains its page gutter; only the scrolling/dock stage
        // extends across that gutter and down to the physical screen edge.
        LinearLayout.LayoutParams placement = (LinearLayout.LayoutParams) getLayoutParams();
        if (placement.leftMargin != -left || placement.rightMargin != -right) {
            placement.leftMargin = -left; placement.rightMargin = -right;
            setLayoutParams(placement);
        }
        updateScrollPadding();
        FrameLayout.LayoutParams material = (FrameLayout.LayoutParams) veil.getLayoutParams();
        int height = dp(FADE_HEIGHT_DP + WorkbenchNavigation.HEIGHT_DP + BOTTOM_GAP_DP) + bottom;
        if (material.height != height) { material.height = height; veil.setLayoutParams(material); }
        updateGeometry();
    }

    private static final int CONTENT_CLEARANCE_DP = BOTTOM_GAP_DP + WorkbenchNavigation.CONTENT_GAP_DP;

    private void updateScrollPadding() {
        // Edge-to-edge windows include the IME in this inset; resized windows
        // already stop at the keyboard. Preserve that clearance in both cases.
        scroll.setPadding(leftInset, 0, rightInset, bottomInset + (keyboardVisible ? dp(8)
            : dp(WorkbenchNavigation.HEIGHT_DP + CONTENT_CLEARANCE_DP)));
    }

    private void setKeyboardVisible(boolean visible) {
        if (keyboardVisible == visible) return;
        keyboardVisible = visible;
        // adjustResize keeps search results above the IME. Destination navigation
        // and its frost belong at the screen bottom, not on top of the keyboard.
        if (navigation != null) navigation.setVisibility(visible ? INVISIBLE : VISIBLE);
        veil.setVisibility(visible ? INVISIBLE : VISIBLE);
        capturedWidth = capturedHeight = 0;
        updateScrollPadding();
    }

    @Override public WindowInsets onApplyWindowInsets(WindowInsets insets) {
        if (android.os.Build.VERSION.SDK_INT >= 30) setKeyboardVisible(insets.isVisible(WindowInsets.Type.ime()));
        return super.onApplyWindowInsets(insets);
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (android.os.Build.VERSION.SDK_INT < 30) getViewTreeObserver().addOnGlobalLayoutListener(legacyKeyboardObserver);
    }

    @Override protected void onDetachedFromWindow() {
        if (android.os.Build.VERSION.SDK_INT < 30 && getViewTreeObserver().isAlive())
            getViewTreeObserver().removeOnGlobalLayoutListener(legacyKeyboardObserver);
        super.onDetachedFromWindow();
    }

    void updateGeometry() {
        if (navigation == null) return;
        int screen = getResources().getDisplayMetrics().widthPixels;
        int available = Math.max(1, (getWidth() > 0 ? getWidth() : screen) - leftInset - rightInset);
        int width = Math.min(available, Math.min(dp(440), Math.max(dp(300), Math.round(screen * .78f))));
        FrameLayout.LayoutParams placement = (FrameLayout.LayoutParams) navigation.getLayoutParams();
        int left = leftInset + (available - width) / 2;
        int bottom = bottomInset + dp(BOTTOM_GAP_DP);
        if (placement.width != width || placement.leftMargin != left || placement.bottomMargin != bottom) {
            placement.width = width; placement.leftMargin = left; placement.bottomMargin = bottom;
            navigation.setLayoutParams(placement);
        }
    }

    @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        updateGeometry();
        super.onLayout(changed, left, top, right, bottom);
        if (veil.getVisibility() == VISIBLE && veil.getWidth() > 0 && veil.getHeight() > 0
            && (capturedWidth != veil.getWidth() || capturedHeight != veil.getHeight())) {
            capturedWidth = veil.getWidth(); capturedHeight = veil.getHeight();
            int[] origin = new int[2]; veil.getLocationOnScreen(origin);
            veil.capture(scroll, origin[0], origin[1], capturedWidth, capturedHeight);
        }
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
