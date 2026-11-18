package app.camellia.mobile;

import android.content.Context;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/** Trusted viewer code; the document receives no native object or host credentials. */
final class CardViewportScript {
    private static String cached;
    private CardViewportScript() {}

    static synchronized String read(Context context) {
        if (cached != null) return cached;
        try (var input = context.getAssets().open("card-viewport.js"); var output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            cached = output.toString(StandardCharsets.UTF_8.name());
            return cached;
        } catch (java.io.IOException error) { throw new IllegalStateException("Missing card viewer asset", error); }
    }
}
