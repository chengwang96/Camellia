package app.camellia.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.SurfaceTexture;
import android.hardware.Camera;
import android.os.Bundle;
import android.view.Gravity;
import android.view.TextureView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.io.IOException;
import java.util.List;

/**
 * A single-purpose scanner for the desktop pairing QR. It deliberately avoids
 * CameraX, ML Kit and Play Services so the client keeps its small dependency
 * set and still runs on a plain AOSP build; ZXing decodes the luminance frames
 * that the legacy Camera API already hands out as NV21.
 */
public final class QrScanActivity extends Activity implements TextureView.SurfaceTextureListener, Camera.PreviewCallback {
    static final String EXTRA_TEXT = "app.camellia.mobile.qr";
    static final String EXTRA_ADDRESS = "address";
    static final String EXTRA_CODE = "code";
    private static final int CAMERA_PERMISSION = 91;

    private TextureView preview;
    private TextView status;
    private Camera camera;
    private boolean delivered;
    private boolean surfaceReady;
    // Cached once when the preview starts; getParameters() on every frame is slow
    // and allocates, and the size cannot change while this preview is running.
    private int previewWidth;
    private int previewHeight;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xff000000);

        preview = new TextureView(this);
        preview.setSurfaceTextureListener(this);
        root.addView(preview, new FrameLayout.LayoutParams(-1, -1));

        TextView heading = new TextView(this);
        heading.setText(R.string.qr_scan_title);
        heading.setTextColor(0xffffffff); heading.setTextSize(18);
        heading.setGravity(Gravity.CENTER); heading.setPadding(0, dp(28), 0, dp(6));
        root.addView(heading, new FrameLayout.LayoutParams(-1, -2, Gravity.TOP));

        status = new TextView(this);
        status.setText(R.string.qr_scan_hint);
        status.setTextColor(0xffd9d9d9); status.setTextSize(14); status.setGravity(Gravity.CENTER);
        status.setPadding(dp(24), 0, dp(24), dp(24));
        FrameLayout.LayoutParams statusParams = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        statusParams.bottomMargin = dp(24);
        root.addView(status, statusParams);

        Button cancel = new Button(this);
        cancel.setText(R.string.qr_scan_cancel);
        cancel.setOnClickListener(view -> { setResult(RESULT_CANCELED); finish(); });
        FrameLayout.LayoutParams cancelParams = new FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM | Gravity.END);
        cancelParams.setMargins(0, 0, dp(16), dp(16));
        root.addView(cancel, cancelParams);

        setContentView(root);
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION);
        }
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants);
        if (request != CAMERA_PERMISSION) return;
        if (grants.length == 0 || grants[0] != PackageManager.PERMISSION_GRANTED) {
            status.setText(R.string.qr_scan_denied);
            return;
        }
        openCamera();
    }

    @Override public void onSurfaceTextureAvailable(SurfaceTexture texture, int width, int height) {
        surfaceReady = true;
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) openCamera();
    }

    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture texture, int width, int height) {}
    @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture texture) { releaseCamera(); return true; }
    @Override public void onSurfaceTextureUpdated(SurfaceTexture texture) {}

    private void openCamera() {
        if (camera != null || !surfaceReady) return;
        Camera opened = null;
        try {
            opened = Camera.open();
            Camera.Parameters parameters = opened.getParameters();
            List<Integer> formats = parameters.getSupportedPreviewFormats();
            if (formats != null && formats.contains(android.graphics.ImageFormat.NV21)) parameters.setPreviewFormat(android.graphics.ImageFormat.NV21);
            List<String> focusModes = parameters.getSupportedFocusModes();
            if (focusModes != null && focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                parameters.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            }
            opened.setParameters(parameters);
            Camera.Size size = parameters.getPreviewSize();
            if (size == null || size.width <= 0 || size.height <= 0) throw new IOException("Camera has no preview size");
            previewWidth = size.width; previewHeight = size.height;
            opened.setPreviewTexture(preview.getSurfaceTexture());
            int buffer = size.width * size.height * android.graphics.ImageFormat.getBitsPerPixel(parameters.getPreviewFormat()) / 8;
            opened.addCallbackBuffer(new byte[buffer]);
            opened.addCallbackBuffer(new byte[buffer]);
            opened.setPreviewCallbackWithBuffer(this);
            opened.startPreview();
            camera = opened;
        } catch (RuntimeException | IOException error) {
            if (opened != null) opened.release();
            camera = null;
            status.setText(R.string.qr_scan_failed);
        }
    }

    @Override public void onPreviewFrame(byte[] data, Camera source) {
        if (data == null || source == null) return;
        String text = QrDecoder.decodeYuv(data, previewWidth, previewHeight);
        source.addCallbackBuffer(data);
        if (text == null || delivered) return;
        try {
            PairingPayload payload = PairingPayload.parse(text);
            delivered = true;
            setResult(RESULT_OK, new android.content.Intent().putExtra(EXTRA_TEXT, text)
                .putExtra(EXTRA_ADDRESS, payload.address).putExtra(EXTRA_CODE, payload.code));
            finish();
        } catch (IllegalArgumentException error) {
            status.setText(R.string.qr_scan_unrecognized);
        }
    }

    @Override protected void onPause() {
        super.onPause();
        releaseCamera();
    }

    // Releasing on pause frees the camera for other apps (and is required while the
    // permission dialog is up), so resuming must start it again. onSurfaceTexture
    // -Available is not called again for a retained surface.
    @Override protected void onResume() {
        super.onResume();
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) openCamera();
    }

    private void releaseCamera() {
        if (camera == null) return;
        try { camera.setPreviewCallbackWithBuffer(null); camera.stopPreview(); } catch (RuntimeException ignored) { }
        camera.release();
        camera = null;
        previewWidth = 0; previewHeight = 0;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
