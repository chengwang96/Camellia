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

    static String signature(Context context) { return get(context, "language") + ":" + get(context, "theme"); }

    static Context wrap(Context context) {
        Configuration config = new Configuration(context.getResources().getConfiguration());
        String language = get(context, "language"), theme = get(context, "theme");
        if (!language.equals("system")) config.setLocale(Locale.forLanguageTag(language));
        if (!theme.equals("system")) config.uiMode = (config.uiMode & ~Configuration.UI_MODE_NIGHT_MASK)
            | (theme.equals("dark") ? Configuration.UI_MODE_NIGHT_YES : Configuration.UI_MODE_NIGHT_NO);
        return context.createConfigurationContext(config);
    }
}
