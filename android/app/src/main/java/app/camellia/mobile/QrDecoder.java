package app.camellia.mobile;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
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

    private static String decode(PlanarYUVLuminanceSource source) {
        Map<DecodeHintType, Object> hints = Map.of(
            DecodeHintType.POSSIBLE_FORMATS, List.of(BarcodeFormat.QR_CODE),
            DecodeHintType.TRY_HARDER, Boolean.TRUE);
        try { return new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(source)), hints).getText(); }
        catch (NotFoundException error) { return null; }
    }
}
