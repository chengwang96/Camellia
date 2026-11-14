package app.camellia.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RenderEffect;
import android.graphics.Shader;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.PowerManager;
import android.view.View;
import android.view.ViewTreeObserver;
import android.widget.FrameLayout;
import android.widget.ImageView;

@android.annotation.SuppressLint("ViewConstructor")
final class PopupSurface extends FrameLayout {
    static final int COMPACT_MENU_MAX_WIDTH_DP = 264;
    static final int BOTTOM_SHEET_MAX_WIDTH_DP = 420;
    static final int MODEL_MENU_MAX_WIDTH_DP = 340;
    static final int MODEL_MENU_MIN_WIDTH_DP = 280;
    static final float MODEL_MENU_WIDTH_FRACTION = .82f;
    static final int BOTTOM_SHEET_GUTTER_DP = 12;
    static final int BOTTOM_SHEET_BOTTOM_GAP_DP = 10;
    static final int PHONE_MENU_MAX_HEIGHT_DP = 420;
    static final int TABLET_MENU_MAX_HEIGHT_DP = 400;
    static final int MENU_MIN_HEIGHT_DP = 240;
    static final float PHONE_MENU_HEIGHT_FRACTION = .56f;
    static final float TABLET_MENU_HEIGHT_FRACTION = .42f;
    private Bitmap snapshot;
    private Bitmap scratch;
    private ImageView backdrop;
    private View tint;
    private View source;
    private ViewTreeObserver sourceObserver;
    private ViewTreeObserver.OnPreDrawListener refresh;
    private BroadcastReceiver powerReceiver;
    private int sampleLeft, sampleTop, sampleWidth, sampleHeight;
    private boolean hardwareBlur;
    private final int color;

    PopupSurface(Context context, int color) {
        super(context);
        this.color = color | 0xff000000;
        GradientDrawable shape = new GradientDrawable(); shape.setColor(this.color);
        shape.setCornerRadius(dp(Palette.RADIUS_GROUP)); setBackground(shape); setClipToOutline(true);
        GradientDrawable edge = new GradientDrawable(); edge.setColor(Color.TRANSPARENT);
        edge.setCornerRadius(dp(Palette.RADIUS_GROUP)); edge.setStroke(dp(1), Color.red(color) < 128 ? 0x18ffffff : 0x1a000000);
        setForeground(edge);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    static int menuWidth(Context context, Rect visible, int maxWidthDp) {
        float density = context.getResources().getDisplayMetrics().density;
        int gutter = Math.round(12 * density);
        return Math.max(1, Math.min(Math.round(maxWidthDp * density), visible.width() - gutter * 2));
    }

    static int sheetWidth(Context context, Rect visible) {
        return menuWidth(context, visible, BOTTOM_SHEET_MAX_WIDTH_DP);
    }

    static int modelMenuWidth(Context context, Rect visible) {
        float density = context.getResources().getDisplayMetrics().density;
        int gutter = Math.round(BOTTOM_SHEET_GUTTER_DP * density);
        int available = Math.max(1, visible.width() - gutter * 2);
        int minimum = Math.min(Math.round(MODEL_MENU_MIN_WIDTH_DP * density), available);
        return Math.max(minimum, Math.min(available, Math.min(
            Math.round(MODEL_MENU_MAX_WIDTH_DP * density),
            Math.round(visible.width() * MODEL_MENU_WIDTH_FRACTION))));
    }

    /**
     * getWindowVisibleDisplayFrame normally excludes the IME. Some popup
     * anchors still report the pre-IME frame while the keyboard is animating,
     * so use the live IME inset as an additional ceiling when it is available.
     */
    static Rect visibleFrame(View anchor) {
        Rect visible = new Rect();
        anchor.getWindowVisibleDisplayFrame(visible);
        if (Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsets insets = anchor.getRootView().getRootWindowInsets();
            if (insets != null) {
                int keyboard = insets.getInsets(android.view.WindowInsets.Type.ime()).bottom;
                if (keyboard > 0) {
                    int[] root = new int[2];
                    anchor.getRootView().getLocationOnScreen(root);
                    int keyboardTop = root[1] + anchor.getRootView().getHeight() - keyboard;
                    if (keyboardTop > visible.top && keyboardTop < visible.bottom) visible.bottom = keyboardTop;
                }
            }
        }
        return visible;
    }

    /**
     * The model and settings menus scroll internally; they must not turn into a
     * near-full-screen sheet just because many models are configured.
     *
     * <p>Phones may use up to 56% of the visible frame, with a 420dp cap. A
     * tablet uses 42% and a 400dp cap, so portrait tablets keep most of the
     * conversation visible and landscape tablets still show a useful list.
     */
    static int menuHeightLimit(Context context, Rect visible) {
        float density = context.getResources().getDisplayMetrics().density;
        int available = Math.max(1, visible.height()
            - Math.round(BOTTOM_SHEET_BOTTOM_GAP_DP * density)
            - Math.round(BOTTOM_SHEET_GUTTER_DP * density));
        boolean tablet = visible.width() >= Math.round(600 * density);
        int cap = Math.round((tablet ? TABLET_MENU_MAX_HEIGHT_DP : PHONE_MENU_MAX_HEIGHT_DP) * density);
        int fraction = Math.round(visible.height()
            * (tablet ? TABLET_MENU_HEIGHT_FRACTION : PHONE_MENU_HEIGHT_FRACTION));
        int minimum = Math.min(available, Math.round(MENU_MIN_HEIGHT_DP * density));
        return Math.max(minimum, Math.min(available, Math.min(cap, fraction)));
    }

    static int sheetLeft(int anchorCenter, int width, int visibleLeft, int visibleRight, int gutter) {
        return Math.max(visibleLeft + gutter,
            Math.min(anchorCenter - width / 2, visibleRight - width - gutter));
    }

    static View grip(Context context) {
        View view = new View(context);
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(Palette.of(context).dark ? 0x40ffffff : 0x30000000);
        shape.setCornerRadius(99 * context.getResources().getDisplayMetrics().density);
        view.setBackground(shape);
        return view;
    }

    /**
     * A quiet bottom fade that only appears while a menu can still scroll down.
     * The compact menu cap intentionally clips its list; without this cue the
     * final visible row reads as if it were cut off by mistake.
     */
    static View scrollFade(Context context, int panelColor) {
        View fade = new View(context);
        fade.setTag("glassScrollFade");
        fade.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        int rgb = panelColor & 0x00ffffff;
        fade.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
            new int[] { rgb, rgb | 0xc0000000 }));
        return fade;
    }

    static boolean supportsBlur(Context context) {
        return Build.VERSION.SDK_INT >= 31 && !isPowerSaveMode(context);
    }

    private static boolean isPowerSaveMode(Context context) {
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return power != null && power.isPowerSaveMode();
    }

    void capture(View source, int left, int top, int width, int height) {
        if (width <= 0 || height <= 0) return;
        clearBackdrop();
        this.source = source;
        sampleLeft = left; sampleTop = top; sampleWidth = width; sampleHeight = height;
        updatePowerMode();
    }

    private void updatePowerMode() {
        if (isPowerSaveMode(getContext())) {
            // Power saver uses the opaque base, with no page capture or CPU/GPU blur.
            clearBackdrop();
            if (Build.VERSION.SDK_INT >= 31) setRenderEffect(null);
        } else if (source != null && snapshot == null) captureBackdrop();
    }

    private void captureBackdrop() {
        snapshot = Bitmap.createBitmap(Math.max(1, sampleWidth / 3), Math.max(1, sampleHeight / 3), Bitmap.Config.ARGB_8888);
        backdrop = new ImageView(getContext()); backdrop.setImageBitmap(snapshot);
        backdrop.setScaleType(ImageView.ScaleType.FIT_XY);
        backdrop.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        backdrop.setTag("glassBackdrop");
        hardwareBlur = supportsBlur(getContext()) && source.isHardwareAccelerated();
        if (Build.VERSION.SDK_INT >= 31 && hardwareBlur)
            backdrop.setRenderEffect(RenderEffect.createBlurEffect(dp(12), dp(12), Shader.TileMode.CLAMP));
        else scratch = Bitmap.createBitmap(Math.max(1, snapshot.getWidth() / 2), Math.max(1, snapshot.getHeight() / 2), Bitmap.Config.ARGB_8888);
        addView(backdrop, 0, new FrameLayout.LayoutParams(-1, -1));
        boolean dark = Color.red(color) < 128;
        View milk = new View(getContext()); milk.setTag("glassTint");
        // A white wash over a white page made the frosted panel identical to the page
        // behind it, so the long-press menu looked like a plain card with no glass at
        // all. In the light theme use a translucent neutral wash instead, capped at
        // 50% so the blurred page still shows through while the pane stays a shade off
        // white. The dark theme keeps its deeper mask.
        GradientDrawable wash = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, dark
            ? new int[] { (color & 0x00ffffff) | 0x66000000, (color & 0x00ffffff) | 0x80000000 }
            : new int[] { 0x66e6eaef, 0x80dde1e7 });
        milk.setBackground(wash);
        milk.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        tint = milk;
        addView(milk, 1, new FrameLayout.LayoutParams(-1, -1));
        refreshBackdrop();
        sourceObserver = source.getViewTreeObserver();
        refresh = () -> { refreshBackdrop(); return true; };
        sourceObserver.addOnPreDrawListener(refresh);
    }

    private void refreshBackdrop() {
        if (source == null || snapshot == null) return;
        int[] origin = new int[2]; source.getLocationOnScreen(origin);
        if (isLaidOut() && isAttachedToWindow()) {
            int[] position = new int[2]; getLocationOnScreen(position);
            sampleLeft = position[0]; sampleTop = position[1];
        }
        Canvas canvas = new Canvas(snapshot); canvas.drawColor(color);
        canvas.scale(snapshot.getWidth() / (float) sampleWidth, snapshot.getHeight() / (float) sampleHeight);
        canvas.translate(origin[0] - sampleLeft, origin[1] - sampleTop);
        source.draw(canvas);
        if (!hardwareBlur) soften();
        backdrop.invalidate();
    }

    // Downscale into the scratch buffer and scale back with filtering, twice. The
    // sample is already a third of the panel, so the cost stays low per frame while
    // still reading as frosted glass on devices without a GPU render effect.
    private void soften() {
        if (scratch == null || scratch.isRecycled()) return;
        Paint filter = new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG);
        Rect full = new Rect(0, 0, snapshot.getWidth(), snapshot.getHeight());
        Rect small = new Rect(0, 0, scratch.getWidth(), scratch.getHeight());
        for (int pass = 0; pass < 2; pass++) {
            new Canvas(scratch).drawBitmap(snapshot, full, small, filter);
            new Canvas(snapshot).drawBitmap(scratch, small, full, filter);
        }
    }

    @Override protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
        super.onSizeChanged(width, height, oldWidth, oldHeight);
        refreshBackdrop();
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        powerReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) { updatePowerMode(); }
        };
        IntentFilter filter = new IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) getContext().registerReceiver(powerReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else getContext().registerReceiver(powerReceiver, filter);
        updatePowerMode();
    }

    private void clearBackdrop() {
        if (sourceObserver != null && sourceObserver.isAlive()) sourceObserver.removeOnPreDrawListener(refresh);
        sourceObserver = null; refresh = null;
        if (backdrop != null) { backdrop.setImageDrawable(null); removeView(backdrop); backdrop = null; }
        if (tint != null) { removeView(tint); tint = null; }
        if (snapshot != null) { snapshot.recycle(); snapshot = null; }
        if (scratch != null) { scratch.recycle(); scratch = null; }
    }

    @Override protected void onDetachedFromWindow() {
        if (powerReceiver != null) { getContext().unregisterReceiver(powerReceiver); powerReceiver = null; }
        clearBackdrop(); source = null;
        super.onDetachedFromWindow();
    }
}
