package app.camellia.mobile;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * CommonMark Java only recognizes a GFM table at a block boundary. The desktop
 * renderer also lets a table follow a paragraph without a blank line, and model
 * replies commonly omit that line. Insert the missing parser-only boundary.
 */
final class MarkdownTables {
    private static final Pattern FENCE = Pattern.compile("^ {0,3}(`{3,}|~{3,})(.*)$");
    private static final Pattern LIST_ITEM = Pattern.compile("^ {0,3}(?:[-+*]|\\d{1,9}[.)])(?:[ \\t]+|$)");
    private static final Pattern HEADING = Pattern.compile("^ {0,3}#{1,6}(?:[ \\t]+|$)");
    private static final Pattern THEMATIC_BREAK = Pattern.compile("^ {0,3}(?:(?:\\*[ \\t]*){3,}|(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,})$");
    private static final Pattern SETEXT = Pattern.compile("^ {0,3}(?:=+|-+)[ \\t]*$");
    private static final Pattern SEPARATOR = Pattern.compile("[| :\\-]+");
    private static final Pattern ALIGNMENT = Pattern.compile(":?-+:?");

    private MarkdownTables() {}

    static String normalize(String source) {
        if (source == null || source.isEmpty() || source.indexOf('|') < 0) return source;
        StringBuilder output = null;
        int copied = 0, lineStart = 0, previousLineEnd = -1;
        String previous = null, fence = null;
        boolean table = false;
        while (lineStart < source.length()) {
            int lineEnd = lineEnd(source, lineStart);
            int nextStart = nextLineStart(source, lineEnd);
            String line = source.substring(lineStart, lineEnd);

            if (fence != null) {
                if (closesFence(line, fence.charAt(0), fence.length())) fence = null;
                table = false;
                previous = line;
                previousLineEnd = lineEnd;
                lineStart = nextStart;
                continue;
            }
            Matcher opening = FENCE.matcher(line);
            if (opening.matches() && (opening.group(1).charAt(0) != '`' || opening.group(2).indexOf('`') < 0)) {
                fence = opening.group(1);
                table = false;
                previous = line;
                previousLineEnd = lineEnd;
                lineStart = nextStart;
                continue;
            }

            String next = nextStart < source.length()
                ? source.substring(nextStart, lineEnd(source, nextStart)) : null;
            if (table && (line.trim().isEmpty() || !hasPipe(line))) table = false;
            if (!table && previous != null && paragraphLine(previous) && tableHeader(line, next)) {
                if (output == null) output = new StringBuilder(source.length() + 16);
                output.append(source, copied, lineStart);
                output.append(source, previousLineEnd, lineStart);
                copied = lineStart;
                table = true;
            }
            previous = line;
            previousLineEnd = lineEnd;
            lineStart = nextStart;
        }
        if (output == null) return source;
        return output.append(source, copied, source.length()).toString();
    }

    private static boolean paragraphLine(String line) {
        if (line.isEmpty() || Character.isWhitespace(line.charAt(0)) || line.charAt(0) == '>') return false;
        if (LIST_ITEM.matcher(line).find() || HEADING.matcher(line).find()) return false;
        if (THEMATIC_BREAK.matcher(line).matches() || SETEXT.matcher(line).matches()) return false;
        if (line.charAt(0) == '<' || FENCE.matcher(line).matches()) return false;
        return true;
    }

    private static boolean tableHeader(String line, String next) {
        if (next == null || !paragraphLine(line) || !hasPipe(line) || !hasPipe(next)) return false;
        String separator = next.trim();
        if (separator.isEmpty() || !SEPARATOR.matcher(separator).matches()) return false;
        List<String> header = cells(line), columns = cells(next);
        if (columns.isEmpty() || header.size() != columns.size()) return false;
        for (String column : columns) if (!ALIGNMENT.matcher(column).matches()) return false;
        return true;
    }

    private static List<String> cells(String line) {
        String value = line.trim();
        if (value.startsWith("|")) value = value.substring(1);
        if (value.endsWith("|") && !escaped(value, value.length() - 1)) value = value.substring(0, value.length() - 1);
        List<String> result = new ArrayList<>();
        int start = 0;
        for (int i = 0; i < value.length(); i++) {
            if (value.charAt(i) != '|' || escaped(value, i)) continue;
            result.add(value.substring(start, i).trim());
            start = i + 1;
        }
        result.add(value.substring(start).trim());
        return result;
    }

    private static boolean hasPipe(String line) {
        for (int i = 0; i < line.length(); i++) if (line.charAt(i) == '|' && !escaped(line, i)) return true;
        return false;
    }

    private static boolean escaped(String value, int index) {
        int slashes = 0;
        while (index > slashes && value.charAt(index - slashes - 1) == '\\') slashes++;
        return slashes % 2 == 1;
    }

    private static boolean closesFence(String line, char marker, int length) {
        int i = 0, indent = 0;
        while (i < line.length() && line.charAt(i) == ' ' && indent < 3) { i++; indent++; }
        int start = i;
        while (i < line.length() && line.charAt(i) == marker) i++;
        if (i - start < length) return false;
        while (i < line.length() && (line.charAt(i) == ' ' || line.charAt(i) == '\t')) i++;
        return i == line.length();
    }

    private static int lineEnd(String source, int start) {
        int i = start;
        while (i < source.length() && source.charAt(i) != '\n' && source.charAt(i) != '\r') i++;
        return i;
    }

    private static int nextLineStart(String source, int lineEnd) {
        if (lineEnd >= source.length()) return source.length();
        return source.charAt(lineEnd) == '\r' && lineEnd + 1 < source.length() && source.charAt(lineEnd + 1) == '\n'
            ? lineEnd + 2 : lineEnd + 1;
    }
}
