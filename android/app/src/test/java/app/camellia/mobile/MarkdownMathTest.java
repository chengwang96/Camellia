package app.camellia.mobile;

import java.util.ArrayList;
import java.util.List;
import org.commonmark.node.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class MarkdownMathTest {
    private List<MarkdownMath.Formula> formulas(Node parent) {
        List<MarkdownMath.Formula> result = new ArrayList<>();
        for (Node node = parent.getFirstChild(); node != null; node = node.getNext()) {
            if (node instanceof MarkdownMath.Formula) result.add((MarkdownMath.Formula) node);
            result.addAll(formulas(node));
        }
        return result;
    }
    private Node parse(String source) { return MarkdownStream.newParser().parse(source); }

    @Test public void allDelimitersKeepTexSyntaxAndMarkdownStructure() {
        Node document = parse("**Energy** $E=mc^2$ and \\(x_{i}=\\frac{a}{b}\\).\n\n"
            + "$$\n\\sum_{i=1}^{n}x_i\n$$\n\n\\[\n\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}\n\\]\n\nAfter");
        List<MarkdownMath.Formula> math = formulas(document); assertEquals(4, math.size());
        assertEquals("E=mc^2", math.get(0).literal()); assertFalse(math.get(0).display());
        assertEquals("x_{i}=\\frac{a}{b}", math.get(1).literal());
        assertEquals("\\sum_{i=1}^{n}x_i", math.get(2).literal()); assertTrue(math.get(2).display());
        assertTrue(math.get(3).literal().contains("b \\\\ c"));
        for (MarkdownMath.Formula formula : math) assertTrue(formula.closed());
        assertTrue(document.getFirstChild().getFirstChild() instanceof StrongEmphasis);
        assertTrue(document.getLastChild() instanceof Paragraph);
    }

    @Test public void codeEscapedDollarsAndCurrencyStayLiteral() {
        Node document = parse("`$x_i$` and `\\(x\\)`; escaped \\$x\\$; costs $5 and $10.\n\n```latex\n$$\\frac{1}{2}$$\n\\[x\\]\n```\n\n    $$x$$");
        assertTrue(formulas(document).isEmpty());
        assertTrue(document.getLastChild() instanceof IndentedCodeBlock);
        assertEquals("$$x$$\n", ((IndentedCodeBlock) document.getLastChild()).getLiteral());
        List<MarkdownMath.Formula> mixed = formulas(parse("Costs $5, with $x^2$ calculated separately, and $10 shipping."));
        assertEquals(1, mixed.size()); assertEquals("x^2", mixed.get(0).literal());
    }

    @Test public void blockMathKeepsBlankLinesAndSourceSpans() {
        String original = "\\[\na_i = b_i\n\n+ c_i\n\\]";
        Node document = parse("Before\n\n" + original + "\n\nAfter");
        MarkdownMath.Block block = (MarkdownMath.Block) document.getFirstChild().getNext();
        assertEquals(original, block.source()); assertTrue(block.closed());
        assertEquals(2, block.getSourceSpans().get(0).getLineIndex());
        assertEquals("a_i = b_i\n\n+ c_i", block.literal());
        assertEquals(1, formulas(parse("> $$\n> x_i\n> $$")).size());
        assertEquals(1, formulas(parse("- \\(x_i\\)")).size());
        assertEquals(1, formulas(parse("| Formula |\n| --- |\n| $x_i$ |")).size());
    }

    @Test public void partialFormulasPreserveOriginalUntilClosing() {
        for (String source : new String[] {"$\\frac{a_1}{", "\\(x_i", "$$\nx_i\n\n+ y_i", "\\[\n\\frac{a}{b}"}) {
            List<MarkdownMath.Formula> math = formulas(parse(source)); assertEquals(source, 1, math.size());
            assertFalse(source, math.get(0).closed()); assertEquals(source, math.get(0).source());
        }
        assertEquals(1, formulas(parse("Before $$x^2$$ after")).size());
        assertEquals("a\\$b", formulas(parse("$a\\$b$")).get(0).literal());
    }

    @Test public void changedFormulaHasANewFingerprint() {
        assertNotEquals(MarkdownStream.fingerprint(parse("$$x_1$$")), MarkdownStream.fingerprint(parse("$$x_2$$")));
        assertNotEquals(MarkdownStream.fingerprint(parse("\\(x")), MarkdownStream.fingerprint(parse("\\(x\\)")));
    }
}
