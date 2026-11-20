package app.camellia.mobile;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class ModelLabel {
    private ModelLabel() {}

    static String compact(String name) {
        if (name == null) return "";
        // Account models arrive as `kimi-code/k3.1-pro` while shared routes use
        // the bare family (`deepseek-v4.1-flash:1017`). Drop the Kimi provider
        // prefix and the registry tag so both sides shorten the same way.
        String value = name.trim().replaceFirst("(?i)^(?:kimi-code|moonshot)[/:]", "");
        int tag = value.indexOf(':');
        if (tag > 0) value = value.substring(0, tag).trim();
        Matcher kimi = Pattern.compile("(?i)^(?:kimi[- ]+)?(k\\d+(?:\\.\\d+)*)(?:[- ]+(pro[- ]+highspeed|pro|highspeed|thinking|preview|\\d+k))?$").matcher(value);
        if (kimi.matches()) return kimi.group(1).toUpperCase(Locale.ROOT) + (kimi.group(2) == null ? "" : " " + titleWords(kimi.group(2)));
        Matcher gpt = Pattern.compile("(?i)^gpt-(?:6-astra|5\\.6-(?:sol|terra|luna))$").matcher(value);
        if (gpt.matches()) return title(value.substring(value.lastIndexOf('-') + 1));
        Matcher deepseek = Pattern.compile("(?i)^deepseek[- ]+([vr]\\d+(?:\\.\\d+)*)(?:[- ]+(pro|flash|lite))?$").matcher(value);
        if (deepseek.matches()) return deepseek.group(1).toUpperCase(Locale.ROOT) + (deepseek.group(2) == null ? "" : " " + title(deepseek.group(2)));
        Matcher mimo = Pattern.compile("(?i)^mimo[- ]+v?(\\d+(?:\\.\\d+)*)(?:[- ]+(pro|flash|base))?$").matcher(value);
        if (mimo.matches()) return "MiMo " + mimo.group(1) + (mimo.group(2) == null ? "" : " " + title(mimo.group(2)));
        if (value.equalsIgnoreCase("deepseek-chat")) return "DS Chat";
        if (value.equalsIgnoreCase("deepseek-reasoner")) return "DS Reasoner";
        return value;
    }

    private static String titleWords(String value) {
        StringBuilder result = new StringBuilder();
        for (String word : value.split("[- ]+")) {
            if (word.isEmpty()) continue;
            if (result.length() > 0) result.append(' ');
            result.append(word.matches("(?i)\\d+k") ? word.toUpperCase(Locale.ROOT) : title(word));
        }
        return result.toString();
    }

    private static String title(String value) { return value.substring(0, 1).toUpperCase(Locale.ROOT) + value.substring(1).toLowerCase(Locale.ROOT); }
}
