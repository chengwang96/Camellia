package app.camellia.mobile;

import android.app.Activity;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.test.InstrumentationTestCase;
import android.text.Selection;
import android.text.Spannable;
import android.text.Spanned;
import android.text.style.StyleSpan;
import android.text.style.URLSpan;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.concurrent.atomic.AtomicReference;

public class StreamingMarkdownTest extends InstrumentationTestCase {
    private Activity activity;
    private MarkdownView renderer;
    private StreamingMarkdownView body;
    private ScrollView scroll;
    interface Checked { void run() throws Exception; }
    interface Check { boolean ready() throws Exception; }
    private void ui(Checked action) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }
    private void waitFor(Check check) throws Exception {
        long end = android.os.SystemClock.uptimeMillis() + 15000;
        while (android.os.SystemClock.uptimeMillis() < end) {
            AtomicReference<Boolean> ready = new AtomicReference<>(false); ui(() -> ready.set(check.ready()));
            if (ready.get()) return; Thread.sleep(30);
        }
        AtomicReference<String> details = new AtomicReference<>();
        ui(() -> details.set(" scroll=" + scroll.getScrollY() + " height=" + scroll.getHeight() + " content=" + scroll.getChildAt(0).getHeight() + " attached=" + scroll.isAttachedToWindow()));
        fail("Timed out waiting for Markdown update" + details.get());
    }
    @Override protected void setUp() throws Exception {
        super.setUp(); Context context = getInstrumentation().getTargetContext();
        activity = getInstrumentation().startActivitySync(new Intent(context, MarkdownTestActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        ui(() -> {
            renderer = new MarkdownView(activity, Color.BLACK, Color.GRAY, Color.LTGRAY, Color.BLUE);
            scroll = new ScrollView(activity); LinearLayout content = new LinearLayout(activity); content.setOrientation(LinearLayout.VERTICAL); scroll.addView(content);
            body = new StreamingMarkdownView(activity, renderer, new MarkdownScrollAnchor(scroll, () -> !activity.isFinishing())); content.addView(body); activity.setContentView(scroll);
        });
    }
    @Override protected void tearDown() throws Exception {
        if (activity != null) ui(() -> { body.dispose(); activity.finish(); });
        super.tearDown();
    }
    private void update(String value, boolean finished) throws Exception { ui(() -> body.update(value, finished)); waitFor(() -> body.idle()); }
    private TextView findText(View view, String value) {
        if (view instanceof TextView && ((TextView) view).getText().toString().equals(value)) return (TextView) view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) { TextView found = findText(((ViewGroup) view).getChildAt(i), value); if (found != null) return found; }
        return null;
    }
    private View description(View view, String first, String second) {
        if (first.contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription()) || second.contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())) return view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) { View found = description(((ViewGroup) view).getChildAt(i), first, second); if (found != null) return found; }
        return null;
    }
    private String formatting(View view) {
        StringBuilder value = new StringBuilder();
        if (view instanceof TextView && !(view instanceof Button)) {
            TextView text = (TextView) view; value.append(text.getText()).append('|').append(text.getTextSize()).append('|').append(text.getTypeface().getStyle()).append('|').append(text.getGravity());
            if (text.getText() instanceof Spanned) {
                Spanned spans = (Spanned) text.getText();
                for (StyleSpan span : spans.getSpans(0, spans.length(), StyleSpan.class)) value.append("style:").append(span.getStyle()).append(':').append(spans.getSpanStart(span)).append(':').append(spans.getSpanEnd(span));
                for (URLSpan span : spans.getSpans(0, spans.length(), URLSpan.class)) value.append("link:").append(span.getURL()).append(':').append(spans.getSpanStart(span)).append(':').append(spans.getSpanEnd(span));
            }
            value.append('\n');
        }
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) value.append(formatting(((ViewGroup) view).getChildAt(i)));
        return value.toString();
    }

    public void testCodeAndStableParagraphViewsSurviveCompletion() throws Exception {
        String prefix = "## Header\n\nA **bold** paragraph.\n\n```java\nfirst line\n";
        update(prefix, false);
        AtomicReference<View> heading = new AtomicReference<>(), paragraph = new AtomicReference<>(), code = new AtomicReference<>(), wrap = new AtomicReference<>();
        ui(() -> {
            heading.set(findText(body, "Header")); paragraph.set(findText(body, "A bold paragraph.")); code.set(body.findViewWithTag("markdownCodeText")); wrap.set(body.findViewWithTag("markdownCodeWrap"));
            if (!wrap.get().isSelected()) wrap.get().performClick();
            Selection.setSelection((Spannable) ((TextView) paragraph.get()).getText(), 2, 6);
        });
        String more = prefix + "second line\nthird line\n"; update(more, false);
        ui(() -> {
            assertSame(heading.get(), findText(body, "Header")); assertSame(paragraph.get(), findText(body, "A bold paragraph.")); assertSame(code.get(), body.findViewWithTag("markdownCodeText"));
            assertEquals(2, ((TextView) paragraph.get()).getSelectionStart()); assertTrue(wrap.get().isSelected());
            description(body.findViewWithTag("markdownCode"), "Copy code", "复制代码").performClick();
            ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            assertEquals("first line\nsecond line\nthird line\n", clipboard.getPrimaryClip().getItemAt(0).getText().toString());
        });
        String finished = more + "```\n\n**Done**"; update(finished, true);
        ui(() -> {
            assertSame(heading.get(), findText(body, "Header")); assertSame(code.get(), body.findViewWithTag("markdownCodeText")); assertSame(wrap.get(), body.findViewWithTag("markdownCodeWrap")); assertTrue(wrap.get().isSelected());
            assertFalse(body.hasStreamState()); assertEquals(formatting(renderer.render(finished)), formatting(body)); assertTrue(body.createdRoots() <= 4);
        });
    }

    public void testTableRowsCellsAndHorizontalPositionAreReused() throws Exception {
        String prefix = "| A | B | C | D |\n| :--- | ---: | --- | --- |\n| **first** | second | third | fourth |\n";
        update(prefix, false);
        AtomicReference<View> first = new AtomicReference<>(), grid = new AtomicReference<>(); AtomicReference<Integer> x = new AtomicReference<>();
        ui(() -> {
            first.set(findText(body, "first")); grid.set(body.findViewWithTag("markdownTable"));
            HorizontalScrollView horizontal = body.findViewWithTag("markdownTableScroll"); horizontal.scrollTo(80, 0); x.set(horizontal.getScrollX()); assertTrue(x.get() > 0);
            Selection.setSelection((Spannable) ((TextView) first.get()).getText(), 0, 3);
        });
        update(prefix + "| next | value | cell | row |\n", false);
        String finished = prefix + "| next | value | cell | row |\n\nAfter"; update(finished, true);
        ui(() -> {
            assertSame(first.get(), findText(body, "first")); assertSame(grid.get(), body.findViewWithTag("markdownTable"));
            assertEquals(3, ((TextView) first.get()).getSelectionEnd()); assertEquals(x.get().intValue(), ((HorizontalScrollView) body.findViewWithTag("markdownTableScroll")).getScrollX());
            assertEquals(formatting(renderer.render(finished)), formatting(body));
        });
    }

    public void testLatestUpdateCoalescesAndOldRunCannotPaint() throws Exception {
        ui(() -> { for (int i = 1; i <= 500; i++) body.update("latest " + i, false); body.update("latest **500**", true); });
        waitFor(() -> body.idle()); ui(() -> { assertEquals(1, body.parseCalls); assertNotNull(findText(body, "latest 500")); assertFalse(body.hasStreamState()); });
        ui(() -> {
            body.restart(); body.update("Stale **reply**", true);
            var dispatch = StreamingMarkdownView.class.getDeclaredMethod("dispatch"); dispatch.setAccessible(true); dispatch.invoke(body);
            body.restart(); body.update("Fresh **reply**", true);
        });
        waitFor(() -> body.idle()); ui(() -> { assertNotNull(findText(body, "Fresh reply")); assertNull(findText(body, "Stale reply")); });
        AtomicReference<StreamingMarkdownView> disposed = new AtomicReference<>();
        ui(() -> {
            StreamingMarkdownView old = new StreamingMarkdownView(activity, renderer, null); disposed.set(old); old.update("Do not paint", true);
            var dispatch = StreamingMarkdownView.class.getDeclaredMethod("dispatch"); dispatch.setAccessible(true); dispatch.invoke(old); old.dispose();
        });
        Thread.sleep(100); getInstrumentation().waitForIdleSync(); ui(() -> { assertEquals(0, disposed.get().getChildCount()); assertFalse(disposed.get().hasStreamState()); assertEquals("", disposed.get().source()); });
    }

    public void testLargeTailShowsNewTextWithoutParsingEveryUpdate() throws Exception {
        String prefix = "A **formatted** long paragraph ".repeat(350);
        update(prefix, false); AtomicReference<Integer> calls = new AtomicReference<>(); ui(() -> calls.set(body.parseCalls));
        String source = prefix + "new text now"; update(source, false);
        ui(() -> { assertEquals(calls.get().intValue(), body.parseCalls); assertNotNull(findText(body, "new text now")); });
        update(source, true); ui(() -> { assertEquals(formatting(renderer.render(source)), formatting(body)); assertFalse(body.hasStreamState()); });
        String deep = ">".repeat(25) + "\n"; update(deep, true); ui(() -> assertNotNull(findText(body, deep)));
        update("Restored **format**", true); ui(() -> assertNotNull(findText(body, "Restored format")));
    }

    public void testReadingPositionAndFollowingBottomSurviveAsyncLayout() throws Exception {
        String prefix = "Paragraph with several words and **formatting**.\n\n".repeat(70);
        update(prefix, false); waitFor(() -> !scroll.isLayoutRequested() && scroll.getChildAt(0).getHeight() > scroll.getHeight() * 2);
        ui(() -> scroll.scrollTo(0, 200));
        String more = prefix + "New paragraph.\n\n".repeat(20); update(more, false); Thread.sleep(100);
        ui(() -> assertEquals(200, scroll.getScrollY()));
        ui(() -> scroll.scrollTo(0, scroll.getChildAt(0).getHeight()));
        update(more + "More at the bottom.\n\n".repeat(20), false);
        waitFor(() -> Math.abs(scroll.getScrollY() - (scroll.getChildAt(0).getHeight() - scroll.getHeight())) < 3);
    }

    public void testNestedListsAndQuotesKeepCodeControlsAndCompletedItems() throws Exception {
        String prefix = "- first **item**\n- second item\n\n  ```java\n  code one\n";
        update(prefix, false);
        AtomicReference<View> first = new AtomicReference<>(), code = new AtomicReference<>(), wrap = new AtomicReference<>();
        ui(() -> {
            first.set(findText(body, "first item")); code.set(body.findViewWithTag("markdownCodeText")); wrap.set(body.findViewWithTag("markdownCodeWrap"));
            if (!wrap.get().isSelected()) wrap.get().performClick(); Selection.setSelection((Spannable) ((TextView) first.get()).getText(), 0, 5);
        });
        String more = prefix + "  code two\n"; update(more, false);
        ui(() -> { assertSame(first.get(), findText(body, "first item")); assertSame(code.get(), body.findViewWithTag("markdownCodeText")); assertSame(wrap.get(), body.findViewWithTag("markdownCodeWrap")); assertEquals(5, ((TextView) first.get()).getSelectionEnd()); });
        String quoted = more + "  ```\n\nAfter list\n\n> quote **one**\n>\n> ```text\n> quote code\n";
        update(quoted, false); AtomicReference<View> quote = new AtomicReference<>(), quoteText = new AtomicReference<>(), quoteCode = new AtomicReference<>();
        ui(() -> { quote.set(body.findViewWithTag("markdownQuote")); quoteText.set(findText(quote.get(), "quote one")); quoteCode.set(quote.get().findViewWithTag("markdownCodeText")); });
        String finished = quoted + "> more code\n> ```\n\nEnd"; update(finished, true);
        ui(() -> {
            assertSame(first.get(), findText(body, "first item")); assertSame(code.get(), body.findViewWithTag("markdownCodeText")); assertTrue(wrap.get().isSelected());
            assertSame(quote.get(), body.findViewWithTag("markdownQuote")); assertSame(quoteText.get(), findText(quote.get(), "quote one")); assertSame(quoteCode.get(), quote.get().findViewWithTag("markdownCodeText"));
            assertEquals(formatting(renderer.render(finished)), formatting(body)); assertFalse(body.hasStreamState());
        });
    }
}
