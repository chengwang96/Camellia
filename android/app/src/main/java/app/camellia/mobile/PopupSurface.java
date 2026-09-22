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
import android.widget.FrameLayout;
import android.widget.ImageView;

final class PopupSurface extends FrameLayout {
    private Bitmap snapshot;
    private ImageView backdrop;
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
        int[] origin = new int[2]; source.getLocationOnScreen(origin);
        snapshot = Bitmap.createBitmap(Math.max(1, width / 3), Math.max(1, height / 3), Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(snapshot); canvas.drawColor(color);
        canvas.scale(snapshot.getWidth() / (float) width, snapshot.getHeight() / (float) height);
        canvas.translate(origin[0] - left, origin[1] - top); source.draw(canvas);
        backdrop = new ImageView(getContext()); backdrop.setImageBitmap(snapshot);
        backdrop.setScaleType(ImageView.ScaleType.FIT_XY);
        backdrop.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        if (Build.VERSION.SDK_INT >= 31) backdrop.setRenderEffect(RenderEffect.createBlurEffect(dp(18), dp(18), Shader.TileMode.CLAMP));
        addView(backdrop, 0, new FrameLayout.LayoutParams(-1, -1));
        View milk = new View(getContext()); milk.setBackgroundColor((color & 0x00ffffff) | 0xE6000000);
        milk.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        addView(milk, 1, new FrameLayout.LayoutParams(-1, -1));
    }

    @Override protected void onDetachedFromWindow() {
        if (backdrop != null) backdrop.setImageDrawable(null);
        if (snapshot != null) { snapshot.recycle(); snapshot = null; }
        super.onDetachedFromWindow();
    }
}
