package app.camellia.mobile;

import android.graphics.Bitmap;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import java.util.List;
import java.util.Map;

final class QrDecoder {
    private QrDecoder() {}

    static String decodeYuv(byte[] luminance, int width, int height) {
        if (luminance == null || width <= 0 || height <= 0) return null;
        PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(luminance, width, height, 0, 0, width, height, false);
        return decode(source);
    }

    static String decodeBitmap(Bitmap bitmap) {
        if (bitmap == null) return null;
        int width = bitmap.getWidth(), height = bitmap.getHeight();
        if (width <= 0 || height <= 0) return null;
        int[] pixels = new int[width * height];
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height);
        byte[] luminance = new byte[width * height];
        for (int index = 0; index < pixels.length; index++) {
            int pixel = pixels[index];
            luminance[index] = (byte) ((77 * (pixel >> 16 & 0xff) + 150 * (pixel >> 8 & 0xff) + 29 * (pixel & 0xff)) >> 8);
        }
        return decodeYuv(luminance, width, height);
    }

    private static String decode(PlanarYUVLuminanceSource source) {
        Map<DecodeHintType, Object> hints = Map.of(
            DecodeHintType.POSSIBLE_FORMATS, List.of(BarcodeFormat.QR_CODE),
            DecodeHintType.TRY_HARDER, Boolean.TRUE);
        try { return new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(source)), hints).getText(); }
        catch (NotFoundException error) { return null; }
    }
}
