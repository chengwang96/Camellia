package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.test.InstrumentationTestCase;
import android.text.Spanned;
import android.view.View;
import android.view.ViewGroup;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

public class MarkdownMathRenderingTest extends InstrumentationTestCase {
    private Activity activity;
    private interface Check { void run() throws Exception; }
    private void ui(Check check) {
        AtomicReference<Throwable> error = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { check.run(); } catch (Throwable failure) { error.set(failure); } });
        if (error.get() != null) throw new AssertionError(error.get());
    }
    @Override protected void setUp() throws Exception {
        super.setUp(); activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MarkdownTestActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }
    @Override protected void tearDown() throws Exception { ui(activity::finish); super.tearDown(); }
    private List<TextView> texts(View view) {
        List<TextView> result = new ArrayList<>();
        if (view instanceof TextView) result.add((TextView) view);
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) result.addAll(texts(((ViewGroup) view).getChildAt(i)));
        return result;
    }
    private MathSpan[] spans(TextView view) { return view.getText() instanceof Spanned ? ((Spanned) view.getText()).getSpans(0, view.length(), MathSpan.class) : new MathSpan[0]; }
    private void attach(View view, boolean dark) {
        ScrollView page = new ScrollView(activity); page.setPadding(28, 55, 28, 32); page.setBackgroundColor(dark ? 0xff151517 : Color.WHITE);
        page.addView(view); activity.setContentView(page);
    }
    private void screenshot(String filename) throws Exception {
        getInstrumentation().getUiAutomation().waitForIdle(200, 3000);
        android.graphics.Bitmap bitmap = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(bitmap);
        try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), filename))) { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output); }
        bitmap.recycle();
    }
    private void formatting(boolean dark) throws Exception {
        View[] rendered = new View[1];
        String source = "## 公式 / Mathematics\n\n质能关系 $E=mc^2$，行内分数 \\(x_i=\\frac{a_i}{b_i}\\)。\n\n"
            + "$$\\sum_{i=1}^{n} x_i^2 = \\frac{n(n+1)(2n+1)}{6}$$\n\n"
            + "\\[\n\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} \\begin{bmatrix} x \\\\ y \\end{bmatrix}\n\\]\n\n"
            + "- 概率 $\\alpha + \\beta = 1$\n\n| 指标 | 公式 |\n| --- | --- |\n| 标准差 | $\\sigma=\\sqrt{\\frac{1}{N}\\sum x_i^2}$ |\n\n"
            + "```latex\n$E=mc^2$\n\\[x_i\\]\n```";
        ui(() -> { rendered[0] = new MarkdownView(activity, dark ? Color.WHITE : Color.BLACK, Color.GRAY, dark ? 0xff232324 : 0xfff5f6f7, Color.BLUE).render(source); attach(rendered[0], dark); });
        getInstrumentation().waitForIdleSync();
        ui(() -> {
            int count = 0;
            for (TextView text : texts(rendered[0])) for (MathSpan span : spans(text)) {
                assertTrue("TeX failed: " + span.source, span.rendered()); assertTrue(text.isTextSelectable()); count++;
                assertTrue(text.getLineHeight() >= text.getTextSize());
            }
            assertEquals(6, count);
            TextView code = rendered[0].findViewWithTag("markdownCodeText"); assertEquals("$E=mc^2$\n\\[x_i\\]", code.getText().toString()); assertEquals(0, spans(code).length);
            for (TextView text : texts(rendered[0])) if (text.getText().toString().contains("begin{pmatrix}")) {
                String copied = MathSpan.copy((Spanned) text.getText(), 0, text.length()); assertTrue(copied.startsWith("\\[\n")); assertTrue(copied.endsWith("\n\\]"));
            }
        });
        screenshot(dark ? "math-dark.png" : "math-light.png");
    }
    public void testLightFormulaFormatting() throws Exception { formatting(false); }
    public void testDarkFormulaFormatting() throws Exception { formatting(true); }

    public void testWideDisplayFormulaScrollsWithoutClipping() {
        View[] rendered = new View[1];
        ui(() -> { rendered[0] = new MarkdownView(activity, Color.BLACK, Color.GRAY, Color.LTGRAY, Color.BLUE).render("$$" + "x_1 + x_2 + ".repeat(35) + "x_n$$"); attach(rendered[0], false); });
        getInstrumentation().waitForIdleSync();
        ui(() -> {
            HorizontalScrollView scroll = rendered[0].findViewWithTag("markdownMathScroll"); assertNotNull(scroll);
            assertTrue(scroll.getChildAt(0).getWidth() > scroll.getWidth()); scroll.scrollTo(200, 0); assertTrue(scroll.getScrollX() > 0);
            assertTrue(spans((TextView) scroll.getChildAt(0))[0].rendered());
        });
    }

    public void testStreamingCloseReusesTheFormulaView() {
        LinearLayout[] body = new LinearLayout[1]; MarkdownView.Session[] session = new MarkdownView.Session[1];
        MarkdownStream stream = new MarkdownStream(); View[] root = new View[1];
        ui(() -> {
            body[0] = new LinearLayout(activity); body[0].setOrientation(LinearLayout.VERTICAL);
            session[0] = new MarkdownView(activity, Color.BLACK, Color.GRAY, Color.LTGRAY, Color.BLUE).session(body[0]); attach(body[0], false);
            session[0].apply(stream.update("Before\n\n\\[\n\\frac{x_1}{", false)); root[0] = body[0].getChildAt(1);
            TextView incomplete = root[0].findViewWithTag("markdownMathText"); assertTrue(incomplete.getText().toString().contains("\\frac{x_1}{")); assertEquals(0, spans(incomplete).length);
            session[0].apply(stream.update("Before\n\n\\[\n\\frac{x_1}{y_2}\n\\]", false)); assertSame(root[0], body[0].getChildAt(1));
            session[0].apply(stream.update("Before\n\n\\[\n\\frac{x_1}{y_2}\n\\]\n\nAfter $a^2$", true)); assertSame(root[0], body[0].getChildAt(1));
        });
        getInstrumentation().waitForIdleSync();
        ui(() -> { TextView complete = root[0].findViewWithTag("markdownMathText"); assertEquals(1, spans(complete).length); assertTrue(spans(complete)[0].rendered()); assertEquals("\\[\n\\frac{x_1}{y_2}\n\\]", MathSpan.copy((Spanned) complete.getText(), 0, complete.length())); });
    }

    public void testInvalidTexFallsBackToReadableSource() {
        View[] rendered = new View[1];
        ui(() -> { rendered[0] = new MarkdownView(activity, Color.BLACK, Color.GRAY, Color.LTGRAY, Color.BLUE).render("Unknown $\\camelliaUnknown{x}$ and unfinished \\(x_i"); attach(rendered[0], false); });
        getInstrumentation().waitForIdleSync();
        ui(() -> { TextView text = texts(rendered[0]).get(0); assertTrue(text.getText().toString().contains("\\(x_i")); assertEquals(1, spans(text).length); assertFalse(spans(text)[0].rendered()); });
    }
}
