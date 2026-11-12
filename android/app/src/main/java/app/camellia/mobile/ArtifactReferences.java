package app.camellia.mobile;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.regex.Pattern;

final class ArtifactReferences {
    private static final Pattern REFERENCES = Pattern.compile("!?\\[[^\\]\\n]*\\]\\(<?((?:[^()\\n]|\\([^()\\n]*\\))+?)>?\\)|`([^`\\n]+)`");
    private static final Pattern EXTENSION = Pattern.compile("(?i).+\\.(apk|exe|msi|dmg|deb|rpm|pdf|docx?|pptx?|xlsx?|csv|tsv|txt|md|html?|png|jpe?g|gif|webp|svg|mp4|m4v|mov|webm|mp3|wav)$");

    static List<String> names(String text) {
        LinkedHashSet<String> names = new LinkedHashSet<>();
        for (String path : paths(text)) names.add(name(path));
        return new ArrayList<>(names);
    }

    static String name(String path) {
        String decoded = path;
        try { decoded = java.net.URLDecoder.decode(path.replace("+", "%2B"), "UTF-8"); }
        catch (java.io.UnsupportedEncodingException | IllegalArgumentException ignored) { }
        String slashed = decoded.replace('\\', '/'); return slashed.substring(slashed.lastIndexOf('/') + 1);
    }

    static String query(String reference) {
        try { return java.net.URLEncoder.encode(reference, "UTF-8"); }
        catch (java.io.UnsupportedEncodingException impossible) { throw new AssertionError(impossible); }
    }

    static List<String> paths(String text) {
        LinkedHashSet<String> paths = new LinkedHashSet<>();
        var matcher = REFERENCES.matcher(text.replaceAll("(?s)```.*?(?:```|$)", ""));
        while (matcher.find() && paths.size() < 100) {
            String path = (matcher.group(1) == null ? matcher.group(2) : matcher.group(1)).replaceAll("\\s+\"[^\"]*\"$", "").trim();
            if (path.matches("(?i)^(https?|data|javascript|mailto):.*")) continue;
            if (!EXTENSION.matcher(path).matches()) continue;
            String name = name(path);
            if (!name.isEmpty() && name.length() <= 200) paths.add(path);
        }
        return new ArrayList<>(paths);
    }
    private ArtifactReferences() {}
}
