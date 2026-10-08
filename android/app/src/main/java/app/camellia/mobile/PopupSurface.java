package app.camellia.mobile;

import android.content.Context;
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
    private Bitmap snapshot;
    private Bitmap scratch;
    private ImageView backdrop;
    private View source;
    private ViewTreeObserver sourceObserver;
    private ViewTreeObserver.OnPreDrawListener refresh;
    private int sampleLeft, sampleTop, sampleWidth, sampleHeight;
    private boolean hardwareBlur;
    private final int color;

    PopupSurface(Context context, int color) {
        super(context);
        this.color = color;
        GradientDrawable shape = new GradientDrawable(); shape.setColor(color);
        shape.setCornerRadius(dp(Palette.RADIUS_GROUP)); setBackground(shape); setClipToOutline(true);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    static boolean supportsBlur(Context context) {
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return Build.VERSION.SDK_INT >= 31 && (power == null || !power.isPowerSaveMode());
    }

    void capture(View source, int left, int top, int width, int height) {
        // RenderEffect needs Android 12+ and is skipped in battery saver. Instead of
        // dropping the frosted layer entirely on those devices and showing a flat
        // card, still sample the page and blur it on the CPU.
        if (width <= 0 || height <= 0) return;
        this.source = source;
        sampleLeft = left; sampleTop = top; sampleWidth = width; sampleHeight = height;
        snapshot = Bitmap.createBitmap(Math.max(1, width / 3), Math.max(1, height / 3), Bitmap.Config.ARGB_8888);
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
        GradientDrawable tint = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, dark
            ? new int[] { (color & 0x00ffffff) | 0x66000000, (color & 0x00ffffff) | 0x80000000 }
            : new int[] { 0x66e6eaef, 0x80dde1e7 });
        milk.setBackground(tint);
        milk.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        addView(milk, 1, new FrameLayout.LayoutParams(-1, -1));
        GradientDrawable edge = new GradientDrawable(); edge.setColor(Color.TRANSPARENT);
        // A white rim disappeared on the white page, so the glass outline vanished
        // with it. Use a faint neutral hairline in the light theme.
        edge.setCornerRadius(dp(Palette.RADIUS_GROUP)); edge.setStroke(dp(1), dark ? 0x18ffffff : 0x1a000000);
        setForeground(edge);
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

    @Override protected void onDetachedFromWindow() {
        if (sourceObserver != null && sourceObserver.isAlive()) sourceObserver.removeOnPreDrawListener(refresh);
        sourceObserver = null; refresh = null; source = null;
        if (backdrop != null) backdrop.setImageDrawable(null);
        if (snapshot != null) { snapshot.recycle(); snapshot = null; }
        if (scratch != null) { scratch.recycle(); scratch = null; }
        super.onDetachedFromWindow();
    }
}
