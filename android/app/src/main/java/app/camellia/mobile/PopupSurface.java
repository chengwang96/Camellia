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
