package app.camellia.mobile;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

final class ArtifactReferences {
    private static final Pattern REFERENCES = Pattern.compile("!?\\[[^\\]\\n]*\\]\\(<?((?:[^()\\n]|\\([^()\\n]*\\))+?)>?\\)|`([^`\\n]+)`");
    static final List<String> PACKAGE_EXTENSIONS = List.of(
        "APK", "AAB", "IPA", "EXE", "MSI", "DMG", "PKG", "DEB", "RPM", "APPIMAGE");
    private static final Pattern EXTENSION = Pattern.compile("(?i).+\\.("
        + String.join("|", PACKAGE_EXTENSIONS).toLowerCase(Locale.ROOT)
        + "|pdf|docx?|pptx?|xlsx?|csv|tsv|txt|md|html?|png|jpe?g|gif|webp|svg|mp4|m4v|mov|webm|mp3|wav)$");

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

    static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 || dot == name.length() - 1 ? "" : name.substring(dot + 1).toUpperCase(Locale.ROOT);
    }

    static String kind(String name) {
        String extension = extension(name);
        if (PACKAGE_EXTENSIONS.contains(extension)) return "package";
        if (extension.equals("PDF")) return "pdf";
        if (List.of("DOC", "DOCX").contains(extension)) return "word";
        if (List.of("XLS", "XLSX", "CSV", "TSV").contains(extension)) return "spreadsheet";
        if (List.of("PPT", "PPTX").contains(extension)) return "presentation";
        if (List.of("PNG", "JPG", "JPEG", "GIF", "WEBP", "SVG").contains(extension)) return "image";
        if (List.of("MP4", "M4V", "MOV", "WEBM").contains(extension)) return "video";
        if (List.of("MP3", "WAV").contains(extension)) return "audio";
        return "text";
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
