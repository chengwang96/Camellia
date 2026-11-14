package app.camellia.mobile;

import android.content.Context;
import android.content.res.Configuration;
import java.util.Locale;

final class MobilePreferences {
    static String get(Context context, String key) {
        return context.getSharedPreferences("mobile-preferences", Context.MODE_PRIVATE).getString(key, "system");
    }

    static void set(Context context, String key, String value) {
        context.getSharedPreferences("mobile-preferences", Context.MODE_PRIVATE).edit().putString(key, value).apply();
    }

    static String enterMode(Context context) {
        String value = get(context, "enterMode");
        return value.equals("newline") || value.equals("button") ? value : "send";
    }

    static String deviceName(Context context) {
        String value = context.getSharedPreferences("mobile-preferences", Context.MODE_PRIVATE).getString("deviceName", null);
        if (value != null && !value.trim().isEmpty()) return value.trim();
        String model = android.os.Build.MODEL;
        return model == null || model.trim().isEmpty() ? "Android" : model.trim();
    }

    static String signature(Context context) { return get(context, "language") + ":" + get(context, "theme"); }

    static Context wrap(Context context) {
        // Override only preferences. Copying the current configuration also pins
        // orientation, window bounds and dp sizes to the values at launch, so a
        // handled rotation keeps rebuilding the portrait layout on a tablet.
        Configuration config = new Configuration();
        String language = get(context, "language"), theme = get(context, "theme");
        if (!language.equals("system")) config.setLocale(Locale.forLanguageTag(language));
        if (!theme.equals("system")) config.uiMode = (config.uiMode & ~Configuration.UI_MODE_NIGHT_MASK)
            | (theme.equals("dark") ? Configuration.UI_MODE_NIGHT_YES : Configuration.UI_MODE_NIGHT_NO);
        return context.createConfigurationContext(config);
    }
}
