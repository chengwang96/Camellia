package app.camellia.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.LinearGradient;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.ColorFilter;
import android.graphics.PixelFormat;
import android.graphics.RenderEffect;
import android.graphics.Shader;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.Drawable;
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
    static final int MODEL_MENU_MIN_WIDTH_DP = 220;
    static final int BOTTOM_SHEET_GUTTER_DP = 12;
    static final int BOTTOM_SHEET_BOTTOM_GAP_DP = 10;
    static final int PHONE_MENU_MAX_HEIGHT_DP = 420;
    static final int TABLET_MENU_MAX_HEIGHT_DP = 720;
    static final int MENU_MIN_HEIGHT_DP = 240;
    static final float PHONE_MENU_HEIGHT_FRACTION = .56f;
    static final float TABLET_MENU_HEIGHT_FRACTION = .72f;
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
    private final boolean navigation;
    private final boolean navigationVeil;
    private final Paint veilMask = new Paint();
    private boolean captured;
    private int capturedScrollX, capturedScrollY, capturedSourceLeft, capturedSourceTop;
    private final int[] sourceOrigin = new int[2], panelOrigin = new int[2];

    PopupSurface(Context context, int color) {
        this(context, color, false);
    }

    static PopupSurface navigation(Context context, int color) {
        return new PopupSurface(context, color, true);
    }

    static PopupSurface navigationVeil(Context context, int color) {
        return new PopupSurface(context, color, true, true);
    }

    private PopupSurface(Context context, int color, boolean navigation) {
        this(context, color, navigation, false);
    }

    private PopupSurface(Context context, int color, boolean navigation, boolean navigationVeil) {
        super(context);
        this.color = color | 0xff000000;
        this.navigation = navigation;
        this.navigationVeil = navigationVeil;
        int radius = navigationVeil ? 0 : dp(navigation ? Palette.RADIUS_NAVIGATION : Palette.RADIUS_GROUP);
        GradientDrawable shape = new GradientDrawable(); shape.setColor(this.color);
        shape.setCornerRadius(radius); setBackground(shape); setClipToOutline(true);
        GradientDrawable edge = new GradientDrawable(); edge.setColor(Color.TRANSPARENT);
        edge.setCornerRadius(radius);
        edge.setStroke(dp(1), navigation ? (Color.red(color) < 128 ? 0x30ffffff : 0xccffffff)
            : Color.red(color) < 128 ? 0x18ffffff : 0x1a000000);
        if (!navigationVeil) setForeground(navigation
            ? new NavigationEdge(context, Color.red(color) < 128, radius) : edge);
        veilMask.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.DST_IN));
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    /** The thin rim catches light at the crown and lower edge, not uniformly. */
    private static final class NavigationEdge extends Drawable {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF line = new RectF();
        private final boolean dark;
        private final float radius, stroke;
        NavigationEdge(Context context, boolean dark, float radius) {
            this.dark = dark; this.radius = radius;
            stroke = Math.max(1, context.getResources().getDisplayMetrics().density * .65f);
            paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(stroke);
        }
        @Override protected void onBoundsChange(Rect bounds) {
            line.set(bounds); line.inset(stroke / 2, stroke / 2);
            paint.setShader(new LinearGradient(0, bounds.top, 0, Math.max(bounds.top + 1, bounds.bottom),
                dark ? new int[] {0x66ffffff, 0x12ffffff, 0x3bffffff}
                     : new int[] {0xf5ffffff, 0x48ffffff, 0xb8ffffff},
                new float[] {0, .55f, 1}, Shader.TileMode.CLAMP));
        }
        @Override public void draw(Canvas canvas) { canvas.drawRoundRect(line, radius - stroke / 2, radius - stroke / 2, paint); }
        @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); invalidateSelf(); }
        @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); invalidateSelf(); }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }

    static int menuWidth(Context context, Rect visible, int maxWidthDp) {
        float density = context.getResources().getDisplayMetrics().density;
        int gutter = Math.round(12 * density);
        return Math.max(1, Math.min(Math.round(maxWidthDp * density), visible.width() - gutter * 2));
    }

    static int sheetWidth(Context context, Rect visible) {
        return menuWidth(context, visible, BOTTOM_SHEET_MAX_WIDTH_DP);
    }

    static int modelMenuWidth(Context context, Rect visible) {
        return menuWidth(context, visible, MODEL_MENU_MAX_WIDTH_DP);
    }

    static int modelMenuWidth(Context context, Rect visible, android.view.ViewGroup content, int outerPadding) {
        int limit = modelMenuWidth(context, visible);
        int preferred = Math.round(MODEL_MENU_MIN_WIDTH_DP * context.getResources().getDisplayMetrics().density);
        int padding = content.getPaddingLeft() + content.getPaddingRight() + outerPadding;
        for (int index = 0; index < content.getChildCount(); index++) {
            View row = content.getChildAt(index);
            if (row instanceof ChatChoiceRow choice) preferred = Math.max(preferred, choice.preferredWidth() + padding);
        }
        return Math.min(limit, preferred);
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
     * tablet uses up to 72% with a 720dp cap, so tall tablets expose more models.
     * The anchored overload also keeps the trigger and visible-frame gutter clear.
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

    static int menuBottom(Context context, Rect visible, int anchorTop) {
        int gap = Math.round(BOTTOM_SHEET_BOTTOM_GAP_DP * context.getResources().getDisplayMetrics().density);
        return Math.max(visible.top + 1, Math.min(visible.bottom - gap, anchorTop - gap));
    }

    static int menuHeightLimit(Context context, Rect visible, int bottom) {
        int gutter = Math.round(BOTTOM_SHEET_GUTTER_DP * context.getResources().getDisplayMetrics().density);
        return Math.max(1, Math.min(menuHeightLimit(context, visible), bottom - visible.top - gutter));
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
        int downsample = navigationVeil ? 6 : 3;
        snapshot = Bitmap.createBitmap(Math.max(1, sampleWidth / downsample), Math.max(1, sampleHeight / downsample), Bitmap.Config.ARGB_8888);
        backdrop = new ImageView(getContext()); backdrop.setImageBitmap(snapshot);
        backdrop.setScaleType(ImageView.ScaleType.FIT_XY);
        backdrop.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        backdrop.setTag("glassBackdrop");
        hardwareBlur = supportsBlur(getContext()) && source.isHardwareAccelerated();
        if (Build.VERSION.SDK_INT >= 31 && hardwareBlur)
            backdrop.setRenderEffect(RenderEffect.createBlurEffect(dp(navigationVeil ? 18 : navigation ? 10 : 12),
                dp(navigationVeil ? 18 : navigation ? 10 : 12), Shader.TileMode.CLAMP));
        else scratch = Bitmap.createBitmap(Math.max(1, snapshot.getWidth() / 2), Math.max(1, snapshot.getHeight() / 2), Bitmap.Config.ARGB_8888);
        addView(backdrop, 0, new FrameLayout.LayoutParams(-1, -1));
        boolean dark = Color.red(color) < 128;
        View milk = new View(getContext()); milk.setTag("glassTint");
        // A white wash over a white page made the frosted panel identical to the page
        // behind it, so the long-press menu looked like a plain card with no glass at
        // all. In the light theme use a translucent neutral wash instead, capped at
        // 50% so the blurred page still shows through while the pane stays a shade off
        // white. The dark theme keeps its deeper mask.
        // Navigation keeps a neutral wash but transmits the blurred page hue.
        // Heavy washes on both layers compound into an almost opaque white slab.
        GradientDrawable wash = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, navigationVeil
            ? new int[] { (color & 0x00ffffff) | 0x55000000, (color & 0x00ffffff) | 0x88000000 }
            : navigation
            ? (dark ? new int[] { 0x992c2d31, 0x80222326 } : new int[] { 0x99ffffff, 0x70f5f6f8 })
            : dark
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
        source.getLocationOnScreen(sourceOrigin);
        if (isLaidOut() && isAttachedToWindow()) {
            getLocationOnScreen(panelOrigin);
        } else {
            panelOrigin[0] = sampleLeft; panelOrigin[1] = sampleTop;
        }
        // A persistent navigation bar must go idle with its page. Scrolls,
        // content invalidations and geometry changes still refresh the frost.
        if (navigation && captured && !source.isDirty()
            && source.getScrollX() == capturedScrollX && source.getScrollY() == capturedScrollY
            && sourceOrigin[0] == capturedSourceLeft && sourceOrigin[1] == capturedSourceTop
            && panelOrigin[0] == sampleLeft && panelOrigin[1] == sampleTop) return;
        sampleLeft = panelOrigin[0]; sampleTop = panelOrigin[1];
        capturedSourceLeft = sourceOrigin[0]; capturedSourceTop = sourceOrigin[1];
        capturedScrollX = source.getScrollX(); capturedScrollY = source.getScrollY(); captured = true;
        Canvas canvas = new Canvas(snapshot); canvas.drawColor(color);
        canvas.scale(snapshot.getWidth() / (float) sampleWidth, snapshot.getHeight() / (float) sampleHeight);
        canvas.translate(sourceOrigin[0] - sampleLeft, sourceOrigin[1] - sampleTop);
        // View.draw() is local to the view's content; its parent's normal draw
        // would subtract the scroll offset. Mirror that transform for sampling.
        canvas.translate(-source.getScrollX(), -source.getScrollY());
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
        if (navigationVeil) veilMask.setShader(new LinearGradient(0, 0, 0,
            Math.max(1, Math.min(height, dp(NavigationDockLayout.FADE_HEIGHT_DP))),
            new int[] {0x00ffffff, 0x18ffffff, 0x80ffffff, Color.WHITE},
            new float[] {0, .35f, .75f, 1}, Shader.TileMode.CLAMP));
        refreshBackdrop();
    }

    @Override public void draw(Canvas canvas) {
        if (!navigationVeil) { super.draw(canvas); return; }
        // Fade the material itself, including its blurred sample. The sides,
        // bar gap and system gesture area all belong to this same surface.
        int layer = canvas.saveLayer(0, 0, getWidth(), getHeight(), null);
        super.draw(canvas);
        canvas.drawRect(0, 0, getWidth(), getHeight(), veilMask);
        canvas.restoreToCount(layer);
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
        captured = false;
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
