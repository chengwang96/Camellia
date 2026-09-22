package app.camellia.mobile;

import android.app.Activity;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.test.InstrumentationTestCase;
import android.text.Spanned;
import android.text.style.StyleSpan;
import android.text.style.URLSpan;
import android.view.View;
import android.view.ViewGroup;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public class MarkdownTest extends InstrumentationTestCase {
    @Override protected void setUp() throws Exception {
        super.setUp(); EmbeddedNetwork.initialize(getInstrumentation().getTargetContext()); EmbeddedNetwork.setEnabled(false);
        new CredentialStore(getInstrumentation().getTargetContext()).clear();
        getInstrumentation().getTargetContext().getSharedPreferences("markdown", Context.MODE_PRIVATE).edit().clear().commit();
    }

    @Override protected void tearDown() throws Exception {
        getInstrumentation().getTargetContext().getSharedPreferences("markdown", Context.MODE_PRIVATE).edit().clear().commit();
        new CredentialStore(getInstrumentation().getTargetContext()).clear(); super.tearDown();
    }

    private Activity start() {
        return getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    public void testNativeFormattingTablesAndCodeCopy() throws Exception {
        Activity activity = start();
        boolean dark = (activity.getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        View[] rendered = new View[1];
        try {
            getInstrumentation().runOnMainSync(() -> {
                MarkdownView markdown = new MarkdownView(activity, dark ? Color.WHITE : Color.BLACK, Color.GRAY, dark ? 0xff232324 : 0xfff5f6f7, 0xff4176e6);
                String source = "## 实验结果 / Results\n\n**粗体**、*斜体*、~~删除线~~ 与 `inline_code`。\n\n"
                    + "- 支持中文列表\n- 第二项\n  1. 嵌套编号\n\n> 引用：保持原文结构。\n\n"
                    + "| 指标 / Metric | Baseline | Camellia | 备注 |\n| :--- | ---: | :---: | --- |\n"
                    + "| **准确率** | 92.5% | 97.2% | 支持多列横向滚动 |\n| 转义管道 | a\\|b | `value` | 选择复制 |\n\n"
                    + "```python\nprint('你好，Camellia')\nlong_variable_name = 'A very long line of code that must scroll without clipping on mobile screens'\n```\n\n"
                    + "[Documentation](https://example.com/docs)\n";
                rendered[0] = markdown.render(source);
                ScrollView page = new ScrollView(activity); page.setBackgroundColor(dark ? 0xff151517 : Color.WHITE); page.setPadding(32, 80, 32, 60); page.addView(rendered[0]); activity.setContentView(page);
                TextView formatted = findText(rendered[0], "粗体"); assertNotNull(formatted);
                assertFalse(formatted.getText().toString().contains("**"));
                assertTrue(((Spanned) formatted.getText()).getSpans(0, formatted.length(), StyleSpan.class).length >= 2);
                LinearLayout table = rendered[0].findViewWithTag("markdownTable"); assertEquals(3, table.getChildCount());
                assertEquals(4, ((ViewGroup) table.getChildAt(0)).getChildCount());
                assertNotNull(findText(table, "a|b"));
                View code = rendered[0].findViewWithTag("markdownCode"); assertNotNull(code);
                findDescription(code, "Copy code", "复制代码").performClick();
                ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                assertTrue(clipboard.getPrimaryClip().getItemAt(0).getText().toString().startsWith("print('你好，Camellia')"));
                assertEquals(1, ((Spanned) findText(rendered[0], "Documentation").getText()).getSpans(0, 13, URLSpan.class).length);
            });
            getInstrumentation().waitForIdleSync();
            getInstrumentation().runOnMainSync(() -> {
                HorizontalScrollView table = rendered[0].findViewWithTag("markdownTableScroll");
                assertTrue(table.getChildAt(0).getWidth() > table.getWidth());
                table.scrollTo(200, 0); assertTrue(table.getScrollX() > 0); table.scrollTo(0, 0);
                TextView cell = findText(table, "准确率"); assertTrue(cell.getHeight() > 0);
                HorizontalScrollView code = rendered[0].findViewWithTag("markdownCodeScroll");
                assertTrue(code.getChildAt(0).getWidth() > code.getWidth());
            });
            getInstrumentation().getUiAutomation().waitForIdle(300, 3000);
            android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot(); assertNotNull(screenshot);
            try (var output = new java.io.FileOutputStream(new java.io.File(activity.getExternalCacheDir(), "markdown.png"))) {
                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
            }
            screenshot.recycle();
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testUnsafeLinksHtmlAndIncompleteMarkdown() {
        Activity activity = start();
        try {
            getInstrumentation().runOnMainSync(() -> {
                MarkdownView renderer = new MarkdownView(activity, Color.BLACK, Color.GRAY, Color.LTGRAY, Color.BLUE);
                View rendered = renderer.render("[unsafe](javascript:alert) [file](file:///private) [intent](intent://open) ![remote](https://example.com/pixel.png)\n\n<script>alert(1)</script>\n\n```java\n**unfinished");
                List<TextView> views = new ArrayList<>(); collect(rendered, views);
                for (TextView view : views) if (view.getText() instanceof Spanned) assertEquals(0, ((Spanned) view.getText()).getSpans(0, view.length(), URLSpan.class).length);
                assertNotNull(findText(rendered, "<script>")); assertNotNull(findText(rendered, "remote"));
                assertNotNull(rendered.findViewWithTag("markdownCode"));
                assertFalse(MarkdownView.safeLink("https://user:secret@example.com"));
                assertFalse(MarkdownView.safeLink("data:text/html,test")); assertTrue(MarkdownView.safeLink("https://example.com/docs"));
                View complex = renderer.render("- item\n".repeat(1400)); assertNotNull(findText(complex, "- item"));
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testHistoryAndStreamingReplaceWithoutDuplicates() {
        Activity activity = start();
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    var id = MainActivity.class.getDeclaredField("conversationId"); id.setAccessible(true); id.set(activity, "12345678-1234-1234-1234-123456789abc");
                    var detail = MainActivity.class.getDeclaredMethod("detailScreen"); detail.setAccessible(true); detail.invoke(activity);
                    var apply = MainActivity.class.getDeclaredMethod("applySnapshot", JSONObject.class); apply.setAccessible(true);
                    JSONObject snapshot = new JSONObject().put("instanceId", "markdown-test").put("cursor", 1).put("permission", "read")
                        .put("conversation", new JSONObject().put("id", id.get(activity)).put("seq", 2)).put("nextBefore", JSONObject.NULL)
                        .put("messages", new JSONArray().put(new JSONObject().put("seq", 1).put("role", "user").put("at", 1790056800000L).put("text", "**literal user input**"))
                            .put(new JSONObject().put("seq", 2).put("role", "assistant").put("at", 1790056860000L).put("text", "**History**")))
                        .put("live", new JSONObject().put("runId", 1).put("text", "## Streaming\n\n| Column |\n"));
                    apply.invoke(activity, snapshot);
                    View root = activity.getWindow().getDecorView(); TextView history = findText(root, "History");
                    assertNotNull(history); assertNotNull(findText(root, "**literal user input**"));
                    ViewGroup wrapper = (ViewGroup) history.getParent().getParent().getParent();
                    assertNotNull(wrapper.findViewWithTag("messageTimestamp"));
                    wrapper.findViewWithTag("copyMessage").performClick();
                    ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                    assertEquals("**History**", clipboard.getPrimaryClip().getItemAt(0).getText().toString());
                    snapshot.put("cursor", 2).put("live", new JSONObject().put("runId", 1).put("text", "## Streaming\n\n| Column |\n| --- |\n| **Value** |"));
                    apply.invoke(activity, snapshot);
                    assertSame(history, findText(root, "History")); assertNotNull(root.findViewWithTag("markdownTable"));
                    List<TextView> text = new ArrayList<>(); collect(root, text);
                    assertEquals(1, text.stream().filter(view -> view.getText().toString().equals("Streaming")).count());
                    assertNotNull(root.findViewWithTag("composerBar"));
                } catch (Exception error) { throw new AssertionError(error); }
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    public void testCodeWrapTogglePreservesTextAndCopy() {
        Activity activity = start();
        try {
            getInstrumentation().runOnMainSync(() -> {
                MarkdownView renderer = new MarkdownView(activity, Color.BLACK, Color.GRAY, Color.LTGRAY, Color.BLUE);
                String value = "    value = \"" + "long_identifier_中文".repeat(60) + "\"\n    second_line\n";
                String source = "```python\n" + value + "```";
                View rendered = renderer.render(source);
                activity.setContentView(rendered);
                int width = Math.round(320 * activity.getResources().getDisplayMetrics().density);
                rendered.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
                rendered.layout(0, 0, width, rendered.getMeasuredHeight());
                TextView code = rendered.findViewWithTag("markdownCodeText");
                View wrap = rendered.findViewWithTag("markdownCodeWrap");
                assertTrue(wrap instanceof android.widget.ImageButton);
                assertNotNull(((android.widget.ImageButton) wrap).getDrawable());
                assertTrue(wrap.getContentDescription().length() > 0);
                android.graphics.drawable.Drawable unwrappedIcon = ((android.widget.ImageButton) wrap).getDrawable();
                HorizontalScrollView horizontal = rendered.findViewWithTag("markdownCodeScroll");
                assertFalse(wrap.isSelected()); assertTrue(code.getWidth() > horizontal.getWidth());
                wrap.performClick();
                assertNotSame(unwrappedIcon, ((android.widget.ImageButton) wrap).getDrawable());
                rendered.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
                rendered.layout(0, 0, width, rendered.getMeasuredHeight());
                assertTrue(wrap.isSelected()); assertEquals(View.GONE, horizontal.getVisibility());
                assertTrue(code.getWidth() < width); assertTrue(code.getLineCount() > 2);
                assertEquals(value.substring(0, value.length() - 1), code.getText().toString());
                findDescription(rendered, "Copy code", "复制代码").performClick();
                ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                assertEquals(value, clipboard.getPrimaryClip().getItemAt(0).getText().toString());
                View streamed = renderer.render(source + "\nMore text");
                assertTrue(streamed.findViewWithTag("markdownCodeWrap").isSelected());
                View recreated = new MarkdownView(activity, Color.BLACK, Color.GRAY, Color.LTGRAY, Color.BLUE).render(source);
                assertTrue(recreated.findViewWithTag("markdownCodeWrap").isSelected());
                wrap.performClick();
                rendered.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
                rendered.layout(0, 0, width, rendered.getMeasuredHeight());
                assertFalse(wrap.isSelected()); assertEquals(View.VISIBLE, horizontal.getVisibility());
                assertTrue(code.getWidth() > horizontal.getWidth());
                assertEquals(value.substring(0, value.length() - 1), code.getText().toString());
            });
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    private void collect(View view, List<TextView> result) {
        if (view instanceof TextView) result.add((TextView) view);
        if (view instanceof ViewGroup) for (int index = 0; index < ((ViewGroup) view).getChildCount(); index++) collect(((ViewGroup) view).getChildAt(index), result);
    }

    private TextView findText(View root, String content) {
        List<TextView> views = new ArrayList<>(); collect(root, views);
        for (TextView view : views) if (view.getText().toString().contains(content)) return view;
        return null;
    }

    private View findDescription(View root, String english, String chinese) {
        if (english.contentEquals(root.getContentDescription() == null ? "" : root.getContentDescription()) || chinese.contentEquals(root.getContentDescription() == null ? "" : root.getContentDescription())) return root;
        if (root instanceof ViewGroup) for (int index = 0; index < ((ViewGroup) root).getChildCount(); index++) {
            View found = findDescription(((ViewGroup) root).getChildAt(index), english, chinese); if (found != null) return found;
        }
        return null;
    }
}
