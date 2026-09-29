package app.camellia.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.SurfaceTexture;
import android.hardware.Camera;
import android.hardware.display.DisplayManager;
import android.os.Bundle;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.IOException;
import java.util.List;

/** A small Camera/ZXing scanner; no Play Services or device-wide network dependencies. */
public final class QrScanActivity extends Activity implements TextureView.SurfaceTextureListener, Camera.PreviewCallback {
    static final String EXTRA_TEXT = "app.camellia.mobile.qr";
    static final String EXTRA_ADDRESS = "address";
    static final String EXTRA_CODE = "code";
    private static final int CAMERA_PERMISSION = 91;

    private TextureView preview;
    private TextView status;
    private Camera camera;
    private Camera.CameraInfo cameraInfo;
    private boolean delivered, resumed, surfaceReady;
    private int previewWidth, previewHeight;
    private DisplayManager displays;
    private final DisplayManager.DisplayListener displayListener = new DisplayManager.DisplayListener() {
        @Override public void onDisplayAdded(int id) {}
        @Override public void onDisplayRemoved(int id) {}
        @Override public void onDisplayChanged(int id) { updatePreview(); }
    };

    @Override protected void attachBaseContext(Context context) { super.attachBaseContext(MobilePreferences.wrap(context)); }

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        SettingsStyle style = new SettingsStyle(this);
        displays = (DisplayManager) getSystemService(DISPLAY_SERVICE);
        getWindow().setStatusBarColor(style.background); getWindow().setNavigationBarColor(style.background);
        boolean dark = (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        getWindow().getDecorView().setSystemUiVisibility(!dark ? View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0);

        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(style.background); root.setPadding(dp(18), dp(12), dp(18), dp(24));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(dp(18) + insets.getSystemWindowInsetLeft(), dp(12) + insets.getSystemWindowInsetTop(),
                dp(18) + insets.getSystemWindowInsetRight(), dp(24) + insets.getSystemWindowInsetBottom());
            return insets;
        });
        root.addView(style.header(getString(R.string.qr_scan_title), getString(R.string.qr_scan_cancel), () -> { setResult(RESULT_CANCELED); finish(); }));

        FrameLayout viewfinder = new FrameLayout(this); viewfinder.setTag("qrViewfinder");
        android.graphics.drawable.GradientDrawable backdrop = style.cardBackground(); backdrop.setColor(0xff0f1115);
        viewfinder.setBackground(backdrop); viewfinder.setClipToOutline(true);
        preview = new TextureView(this); preview.setTag("qrPreview"); preview.setSurfaceTextureListener(this);
        preview.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        viewfinder.addView(preview, new FrameLayout.LayoutParams(-1, -1));
        View guide = new ScanGuide(this); guide.setTag("qrGuide");
        guide.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        viewfinder.addView(guide, new FrameLayout.LayoutParams(-1, -1));
        root.addView(viewfinder, new LinearLayout.LayoutParams(-1, 0, 1));

        status = new TextView(this); status.setTag("qrStatus"); status.setText(R.string.qr_scan_hint);
        status.setTextColor(style.secondary); status.setTextSize(14); status.setGravity(Gravity.CENTER);
        status.setLineSpacing(dp(3), 1); status.setPadding(dp(12), dp(20), dp(12), 0);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        root.addView(status, new LinearLayout.LayoutParams(-1, -2));
        setContentView(root); root.requestApplyInsets();
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION);
        }
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants);
        if (request != CAMERA_PERMISSION) return;
        if (grants.length == 0 || grants[0] != PackageManager.PERMISSION_GRANTED) { status.setText(R.string.qr_scan_denied); return; }
        openCamera();
    }

    @Override public void onSurfaceTextureAvailable(SurfaceTexture texture, int width, int height) {
        surfaceReady = true;
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) openCamera();
    }

    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture texture, int width, int height) { updatePreview(); }
    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture texture) { surfaceReady = false; releaseCamera(); return true; }
    @Override public void onSurfaceTextureUpdated(SurfaceTexture texture) {}

    private void openCamera() {
        if (camera != null || !surfaceReady || !resumed || delivered) return;
        Camera opened = null;
        try {
            int cameraId = 0;
            cameraInfo = new Camera.CameraInfo();
            for (int index = 0; index < Camera.getNumberOfCameras(); index++) {
                Camera.getCameraInfo(index, cameraInfo);
                if (cameraInfo.facing == Camera.CameraInfo.CAMERA_FACING_BACK) { cameraId = index; break; }
            }
            Camera.getCameraInfo(cameraId, cameraInfo);
            opened = Camera.open(cameraId);
            Camera.Parameters parameters = opened.getParameters();
            List<Integer> formats = parameters.getSupportedPreviewFormats();
            if (formats != null && formats.contains(android.graphics.ImageFormat.NV21)) parameters.setPreviewFormat(android.graphics.ImageFormat.NV21);
            List<String> focusModes = parameters.getSupportedFocusModes();
            if (focusModes != null && focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) parameters.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            opened.setParameters(parameters);
            Camera.Size size = opened.getParameters().getPreviewSize();
            if (size == null || size.width <= 0 || size.height <= 0) throw new IOException("Camera has no preview size");
            previewWidth = size.width; previewHeight = size.height;
            opened.setPreviewTexture(preview.getSurfaceTexture());
            camera = opened;
            updatePreview();
            int buffer = size.width * size.height * android.graphics.ImageFormat.getBitsPerPixel(parameters.getPreviewFormat()) / 8;
            opened.addCallbackBuffer(new byte[buffer]); opened.addCallbackBuffer(new byte[buffer]);
            opened.setPreviewCallbackWithBuffer(this); opened.startPreview();
            status.setText(R.string.qr_scan_hint);
        } catch (RuntimeException | IOException error) {
            camera = null;
            if (opened != null) { try { opened.release(); } catch (RuntimeException ignored) {} }
            status.setText(R.string.qr_scan_failed);
        }
    }

    private void updatePreview() {
        if (camera == null || cameraInfo == null || preview.getWidth() <= 0 || preview.getHeight() <= 0) return;
        int degrees = switch (getWindowManager().getDefaultDisplay().getRotation()) {
            case Surface.ROTATION_0 -> 0;
            case Surface.ROTATION_90 -> 90;
            case Surface.ROTATION_180 -> 180;
            case Surface.ROTATION_270 -> 270;
            default -> 0;
        };
        int rotation = CameraPreviewGeometry.rotation(cameraInfo.orientation, degrees, cameraInfo.facing == Camera.CameraInfo.CAMERA_FACING_FRONT);
        camera.setDisplayOrientation(rotation);
        float[] scale = CameraPreviewGeometry.centerCrop(previewWidth, previewHeight, rotation, preview.getWidth(), preview.getHeight());
        Matrix transform = new Matrix(); transform.setScale(scale[0], scale[1], preview.getWidth() / 2f, preview.getHeight() / 2f);
        preview.setTransform(transform);
    }

    @Override public void onPreviewFrame(byte[] data, Camera source) {
        if (data == null || source == null || source != camera || delivered) return;
        String text = QrDecoder.decodeYuv(data, previewWidth, previewHeight);
        source.addCallbackBuffer(data);
        if (text == null) return;
        try {
            PairingPayload payload = PairingPayload.parse(text);
            delivered = true;
            setResult(RESULT_OK, new android.content.Intent().putExtra(EXTRA_TEXT, text)
                .putExtra(EXTRA_ADDRESS, payload.address).putExtra(EXTRA_CODE, payload.code));
            finish();
        } catch (IllegalArgumentException error) { status.setText(R.string.qr_scan_unrecognized); }
    }

    @Override protected void onPause() {
        resumed = false; displays.unregisterDisplayListener(displayListener); releaseCamera(); super.onPause();
    }

    @Override protected void onResume() {
        super.onResume(); resumed = true; displays.registerDisplayListener(displayListener, null);
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) openCamera();
    }

    private void releaseCamera() {
        if (camera == null) return;
        try { camera.setPreviewCallbackWithBuffer(null); camera.stopPreview(); } catch (RuntimeException ignored) {}
        camera.release(); camera = null; previewWidth = 0; previewHeight = 0;
    }

    private final class ScanGuide extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path mask = new Path(), corners = new Path();
        private final RectF frame = new RectF();
        ScanGuide(Context context) { super(context); }

        @Override protected void onDraw(Canvas canvas) {
            float side = Math.min(dp(280), Math.min(getWidth(), getHeight()) * .76f);
            float left = (getWidth() - side) / 2, top = (getHeight() - side) / 2;
            frame.set(left, top, left + side, top + side);
            mask.reset(); mask.setFillType(Path.FillType.EVEN_ODD); mask.addRect(0, 0, getWidth(), getHeight(), Path.Direction.CW);
            mask.addRoundRect(frame, dp(20), dp(20), Path.Direction.CW);
            paint.setStyle(Paint.Style.FILL); paint.setColor(0x66000000); canvas.drawPath(mask, paint);
            paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(1)); paint.setColor(0x80ffffff);
            canvas.drawRoundRect(frame, dp(20), dp(20), paint);
            paint.setStrokeWidth(dp(3)); paint.setColor(0xffffffff); paint.setStrokeCap(Paint.Cap.ROUND);
            for (int index = 0; index < 4; index++) {
                canvas.save(); canvas.rotate(index * 90, frame.centerX(), frame.centerY()); corners.reset();
                corners.moveTo(left, top + dp(36)); corners.lineTo(left, top + dp(20));
                corners.quadTo(left, top, left + dp(20), top); corners.lineTo(left + dp(36), top);
                canvas.drawPath(corners, paint); canvas.restore();
            }
        }
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
