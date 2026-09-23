package app.camellia.mobile;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.regex.Pattern;

final class ArtifactReferences {
    private static final Pattern REFERENCES = Pattern.compile("`([^`\\n]+)`|!?\\[[^\\]\\n]*\\]\\(<?([^\\n]+?)>?\\)");
    private static final Pattern EXTENSION = Pattern.compile("(?i).+\\.(apk|exe|msi|dmg|deb|rpm|pdf|docx?|pptx?|xlsx?|csv|tsv|txt|md|html?|png|jpe?g|gif|webp|svg|mp4|webm|mp3|wav)$");

    static List<String> names(String text) {
        LinkedHashSet<String> names = new LinkedHashSet<>();
        var matcher = REFERENCES.matcher(text.replaceAll("(?s)```.*?(?:```|$)", ""));
        while (matcher.find() && names.size() < 100) {
            String path = (matcher.group(1) == null ? matcher.group(2) : matcher.group(1)).trim();
            if (path.matches("(?i)^(https?|data|javascript|mailto):.*")) continue;
            if (!EXTENSION.matcher(path).matches()) continue;
            String name = path.replace('\\', '/'); name = name.substring(name.lastIndexOf('/') + 1);
            if (!name.isEmpty() && name.length() <= 200) names.add(name);
        }
        return new ArrayList<>(names);
    }
    private ArtifactReferences() {}
}
