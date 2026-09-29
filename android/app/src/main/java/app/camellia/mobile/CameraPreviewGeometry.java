package app.camellia.mobile;

/** Display-only geometry. The decoder continues to receive the sensor's NV21 frames. */
final class CameraPreviewGeometry {
    private CameraPreviewGeometry() {}

    static int rotation(int sensorDegrees, int displayDegrees, boolean frontFacing) {
        return frontFacing ? (360 - (sensorDegrees + displayDegrees) % 360) % 360
            : (sensorDegrees - displayDegrees + 360) % 360;
    }

    static float[] centerCrop(int frameWidth, int frameHeight, int rotation, int viewWidth, int viewHeight) {
        if (frameWidth <= 0 || frameHeight <= 0 || viewWidth <= 0 || viewHeight <= 0) return new float[]{1, 1};
        boolean swapped = rotation % 180 != 0;
        float width = swapped ? frameHeight : frameWidth, height = swapped ? frameWidth : frameHeight;
        float scale = Math.max(viewWidth / width, viewHeight / height);
        // TextureView initially fits the buffer to its bounds. Undo the unequal
        // X/Y stretch, retaining uniform scale and cropping at the center.
        return new float[]{width * scale / viewWidth, height * scale / viewHeight};
    }
}
