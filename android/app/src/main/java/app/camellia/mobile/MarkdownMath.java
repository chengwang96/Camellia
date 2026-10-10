package app.camellia.mobile;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import org.commonmark.node.CustomBlock;
import org.commonmark.node.CustomNode;
import org.commonmark.parser.Parser;
import org.commonmark.parser.SourceLine;
import org.commonmark.parser.beta.InlineContentParser;
import org.commonmark.parser.beta.InlineContentParserFactory;
import org.commonmark.parser.beta.InlineParserState;
import org.commonmark.parser.beta.ParsedInline;
import org.commonmark.parser.beta.Position;
import org.commonmark.parser.beta.Scanner;
import org.commonmark.parser.block.AbstractBlockParser;
import org.commonmark.parser.block.AbstractBlockParserFactory;
import org.commonmark.parser.block.BlockContinue;
import org.commonmark.parser.block.BlockStart;
import org.commonmark.parser.block.MatchedBlockParser;
import org.commonmark.parser.block.ParserState;

/** Parse TeX before Markdown escapes/emphasis, without touching code or stored messages. */
final class MarkdownMath implements Parser.ParserExtension {
    interface Formula {
        String literal();
        String source();
        boolean closed();
        boolean display();
    }

    static final class Inline extends CustomNode implements Formula {
        private final String literal, source;
        private final boolean closed, display;
        Inline(String literal, String source, boolean closed, boolean display) {
            this.literal = literal; this.source = source; this.closed = closed; this.display = display;
        }
        public String literal() { return literal; }
        public String source() { return source; }
        public boolean closed() { return closed; }
        public boolean display() { return display; }
    }

    static final class Block extends CustomBlock implements Formula {
        private String literal = "", source = "";
        private boolean closed;
        public String literal() { return literal; }
        public String source() { return source; }
        public boolean closed() { return closed; }
        public boolean display() { return true; }
    }

    @Override public void extend(Parser.Builder builder) {
        builder.customBlockParserFactory(new BlockFactory());
        builder.customInlineContentParserFactory(new InlineContentParserFactory() {
            public Set<Character> getTriggerCharacters() { return new HashSet<>(Arrays.asList('$', '\\')); }
            public InlineContentParser create() { return MarkdownMath::inline; }
        });
    }

    private static ParsedInline inline(InlineParserState state) {
        Scanner scanner = state.scanner(); Position start = scanner.position();
        String opening, closing; boolean display;
        if (scanner.next("$$")) { opening = closing = "$$"; display = true; }
        else if (scanner.next("\\(")) { opening = "\\("; closing = "\\)"; display = false; }
        else if (scanner.next("\\[")) { opening = "\\["; closing = "\\]"; display = true; }
        else if (scanner.next('$')) { opening = closing = "$"; display = false; }
        else return ParsedInline.none();
        Position content = scanner.position();
        if (opening.equals("$") && (Character.isWhitespace(scanner.peek()) || scanner.peek() == Scanner.END)) return ParsedInline.none();
        int count = 0; boolean escaped = false;
        while (scanner.peek() != Scanner.END && count++ < 16384) {
            Position end = scanner.position(); char c = scanner.peek();
            if (!escaped && scanner.next(closing)) {
                String literal = scanner.getSource(content, end).getContent();
                if (!opening.equals("$") || (!literal.isEmpty() && !Character.isWhitespace(literal.charAt(literal.length() - 1)) && !Character.isDigit(scanner.peek()))) {
                    return ParsedInline.of(new Inline(literal, scanner.getSource(start, scanner.position()).getContent(), true, display), scanner.position());
                }
                return ParsedInline.none();
            }
            if (!display && c == '\n') break;
            scanner.next(); escaped = c == '\\' && !escaped;
        }
        // Preserve backslashes in an unfinished streamed formula. A lone currency dollar stays Markdown text.
        String literal = scanner.getSource(content, scanner.position()).getContent();
        if (opening.equals("$") && (literal.isEmpty() || Character.isDigit(literal.charAt(0)))) return ParsedInline.none();
        return ParsedInline.of(new Inline(literal, scanner.getSource(start, scanner.position()).getContent(), false, display), scanner.position());
    }

    private static final class BlockFactory extends AbstractBlockParserFactory {
        @Override public BlockStart tryStart(ParserState state, MatchedBlockParser matched) {
            if (state.getIndent() >= 4) return BlockStart.none();
            String line = state.getLine().getContent().toString(); int index = state.getNextNonSpaceIndex();
            String opening = line.startsWith("$$", index) ? "$$" : line.startsWith("\\[", index) ? "\\[" : null;
            if (opening == null) return BlockStart.none();
            String closing = opening.equals("$$") ? "$$" : "\\]";
            // A display delimiter followed by prose belongs to the inline parser.
            int end = closing(line, index + opening.length(), closing);
            if (end >= 0 && !line.substring(end + closing.length()).trim().isEmpty()) return BlockStart.none();
            return BlockStart.of(new MathBlockParser(opening, closing)).atIndex(index + opening.length());
        }
    }

    private static final class MathBlockParser extends AbstractBlockParser {
        private final Block block = new Block();
        private final String opening, closing;
        private final StringBuilder content = new StringBuilder(), raw = new StringBuilder();
        private boolean first = true;
        MathBlockParser(String opening, String closing) { this.opening = opening; this.closing = closing; }
        @Override public org.commonmark.node.Block getBlock() { return block; }
        @Override public BlockContinue tryContinue(ParserState state) {
            return block.closed ? BlockContinue.none() : BlockContinue.atIndex(state.getIndex());
        }
        @Override public void addLine(SourceLine source) {
            String line = source.getContent().toString();
            if (first) { raw.append(opening); first = false; }
            else { raw.append('\n'); content.append('\n'); }
            raw.append(line);
            int end = closing(line, 0, closing);
            if (end >= 0 && line.substring(end + closing.length()).trim().isEmpty()) {
                content.append(line, 0, end); block.closed = true;
            } else content.append(line);
        }
        @Override public void closeBlock() { block.literal = content.toString().trim(); block.source = raw.toString(); }
    }

    private static int closing(String line, int start, String delimiter) {
        for (int index = line.indexOf(delimiter, start); index >= 0; index = line.indexOf(delimiter, index + delimiter.length())) {
            int slashes = 0;
            for (int i = index - 1; i >= 0 && line.charAt(i) == '\\'; i--) slashes++;
            if ((slashes & 1) == 0) return index;
        }
        return -1;
    }
}
