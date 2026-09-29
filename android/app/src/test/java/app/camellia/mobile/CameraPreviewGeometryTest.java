package app.camellia.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class CameraPreviewGeometryTest {
    @Test public void backCameraFollowsAllDisplayRotations() {
        assertEquals(90, CameraPreviewGeometry.rotation(90, 0, false));
        assertEquals(0, CameraPreviewGeometry.rotation(90, 90, false));
        assertEquals(270, CameraPreviewGeometry.rotation(90, 180, false));
        assertEquals(180, CameraPreviewGeometry.rotation(90, 270, false));
        assertEquals(270, CameraPreviewGeometry.rotation(0, 90, false));
    }

    @Test public void frontCameraCompensatesForMirroring() {
        assertEquals(90, CameraPreviewGeometry.rotation(270, 0, true));
        assertEquals(0, CameraPreviewGeometry.rotation(270, 90, true));
        assertEquals(270, CameraPreviewGeometry.rotation(270, 180, true));
        assertEquals(180, CameraPreviewGeometry.rotation(270, 270, true));
    }

    @Test public void previewPreservesSquarePixelsAndCoversEveryViewport() {
        for (int[] frame : new int[][]{{640, 480}, {1280, 720}, {1920, 1080}}) {
            for (int[] view : new int[][]{{720, 1300}, {1300, 600}, {700, 700}, {320, 480}}) {
                for (int rotation : new int[]{0, 90, 180, 270}) {
                    float[] scale = CameraPreviewGeometry.centerCrop(frame[0], frame[1], rotation, view[0], view[1]);
                    float width = view[0] * scale[0], height = view[1] * scale[1];
                    float sensorWidth = rotation % 180 == 0 ? frame[0] : frame[1];
                    float sensorHeight = rotation % 180 == 0 ? frame[1] : frame[0];
                    assertEquals(width / sensorWidth, height / sensorHeight, .00001f);
                    assertTrue(width >= view[0] - .001f); assertTrue(height >= view[1] - .001f);
                    assertTrue(Math.abs(width - view[0]) < .001f || Math.abs(height - view[1]) < .001f);
                }
            }
        }
    }

    @Test public void layoutBeforeMeasurementIsSafe() {
        assertArrayEquals(new float[]{1, 1}, CameraPreviewGeometry.centerCrop(640, 480, 90, 0, 0), 0);
    }
}
