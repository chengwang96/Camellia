package app.camellia.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
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
    private ImageView backdrop;
    private View source;
    private ViewTreeObserver sourceObserver;
    private ViewTreeObserver.OnPreDrawListener refresh;
    private int sampleLeft, sampleTop, sampleWidth, sampleHeight;
    private final int color;

    PopupSurface(Context context, int color) {
        super(context);
        this.color = color;
        GradientDrawable shape = new GradientDrawable(); shape.setColor(color);
        shape.setCornerRadius(dp(26)); setBackground(shape); setClipToOutline(true);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    static boolean supportsBlur(Context context) {
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return Build.VERSION.SDK_INT >= 31 && (power == null || !power.isPowerSaveMode());
    }

    void capture(View source, int left, int top, int width, int height) {
        if (!supportsBlur(getContext()) || !source.isHardwareAccelerated() || width <= 0 || height <= 0) return;
        this.source = source;
        sampleLeft = left; sampleTop = top; sampleWidth = width; sampleHeight = height;
        snapshot = Bitmap.createBitmap(Math.max(1, width / 3), Math.max(1, height / 3), Bitmap.Config.ARGB_8888);
        backdrop = new ImageView(getContext()); backdrop.setImageBitmap(snapshot);
        backdrop.setScaleType(ImageView.ScaleType.FIT_XY);
        backdrop.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        backdrop.setTag("glassBackdrop");
        if (Build.VERSION.SDK_INT >= 31) backdrop.setRenderEffect(RenderEffect.createBlurEffect(dp(12), dp(12), Shader.TileMode.CLAMP));
        addView(backdrop, 0, new FrameLayout.LayoutParams(-1, -1));
        boolean dark = Color.red(color) < 128;
        View milk = new View(getContext()); milk.setTag("glassTint");
        GradientDrawable tint = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
            new int[] { (color & 0x00ffffff) | (dark ? 0x66000000 : 0x42000000),
                (color & 0x00ffffff) | (dark ? 0x80000000 : 0x66000000) });
        milk.setBackground(tint);
        milk.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        addView(milk, 1, new FrameLayout.LayoutParams(-1, -1));
        GradientDrawable edge = new GradientDrawable(); edge.setColor(Color.TRANSPARENT);
        edge.setCornerRadius(dp(26)); edge.setStroke(dp(1), dark ? 0x18ffffff : 0x99ffffff);
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
        source.draw(canvas); backdrop.invalidate();
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
        super.onDetachedFromWindow();
    }
}
