package app.camellia.mobile;

import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.method.LinkMovementMethod;
import android.text.style.BackgroundColorSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.StrikethroughSpan;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;
import android.text.style.URLSpan;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.commonmark.Extension;
import org.commonmark.ext.gfm.strikethrough.Strikethrough;
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension;
import org.commonmark.ext.gfm.tables.TableBlock;
import org.commonmark.ext.gfm.tables.TableCell;
import org.commonmark.ext.gfm.tables.TableRow;
import org.commonmark.ext.gfm.tables.TablesExtension;
import org.commonmark.node.*;
import org.commonmark.parser.Parser;
import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

final class MarkdownView {
    private static final List<Extension> EXTENSIONS = Arrays.asList(TablesExtension.create(), StrikethroughExtension.create());
    private final Parser parser = Parser.builder().extensions(EXTENSIONS).build();
    private final Context context;
    private final int ink, muted, surface, accent;
    private final boolean chinese;
    private int blocks;

    MarkdownView(Context context, int ink, int muted, int surface, int accent) {
        this.context = context; this.ink = ink; this.muted = muted; this.surface = surface; this.accent = accent;
        chinese = context.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
    }

    private int dp(float value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
    private String tr(String zh, String en) { return chinese ? zh : en; }

    View render(String source) {
        LinearLayout container = column(); container.setTag("markdown");
        blocks = 0;
        Node document = parser.parse(source);
        try { renderChildren(document, container, 0); }
        catch (RenderLimit limit) { container.removeAllViews(); container.addView(text(source, 15)); }
        return container;
    }

    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(context); layout.setOrientation(LinearLayout.VERTICAL);
        layout.setLayoutParams(new LinearLayout.LayoutParams(-1, -2)); return layout;
    }

    private TextView text(CharSequence content, int size) {
        TextView view = new TextView(context); view.setTextColor(ink); view.setTextSize(size);
        view.setLineSpacing(dp(7), 1); view.setPadding(0, dp(4), 0, dp(6));
        view.setText(content, TextView.BufferType.SPANNABLE); view.setTextIsSelectable(true);
        if (content instanceof Spanned && ((Spanned) content).getSpans(0, content.length(), URLSpan.class).length > 0) view.setMovementMethod(LinkMovementMethod.getInstance());
        view.setLinkTextColor(accent); return view;
    }

    private GradientDrawable background(int color, boolean border) {
        GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(8));
        if (border) shape.setStroke(dp(1), (muted & 0x00ffffff) | 0x44000000); return shape;
    }

    private void renderChildren(Node parent, LinearLayout target, int depth) {
        if (depth > 24) throw new RenderLimit();
        for (Node node = parent.getFirstChild(); node != null; node = node.getNext()) renderBlock(node, target, depth);
    }

    private void renderBlock(Node node, LinearLayout target, int depth) {
        if (++blocks > 1200) throw new RenderLimit();
        if (node instanceof TableBlock) { table((TableBlock) node, target); return; }
        if (node instanceof FencedCodeBlock) {
            FencedCodeBlock code = (FencedCodeBlock) node; code(code.getLiteral(), code.getInfo(), target); return;
        }
        if (node instanceof IndentedCodeBlock) { code(((IndentedCodeBlock) node).getLiteral(), "", target); return; }
        if (node instanceof BulletList || node instanceof OrderedList) {
            int number = node instanceof OrderedList ? ((OrderedList) node).getStartNumber() : 0;
            for (Node item = node.getFirstChild(); item != null; item = item.getNext()) {
                LinearLayout row = new LinearLayout(context); row.setGravity(Gravity.TOP);
                TextView marker = text(node instanceof OrderedList ? number++ + "." : "•", 15);
                marker.setGravity(Gravity.END); marker.setPadding(0, dp(4), dp(8), 0);
                row.addView(marker, new LinearLayout.LayoutParams(dp(34), -2));
                LinearLayout body = column(); row.addView(body, new LinearLayout.LayoutParams(0, -2, 1));
                renderChildren(item, body, depth + 1); target.addView(row);
            }
            return;
        }
        if (node instanceof BlockQuote) {
            LinearLayout quote = new LinearLayout(context); quote.setTag("markdownQuote");
            View line = new View(context); line.setBackgroundColor(accent); quote.addView(line, new LinearLayout.LayoutParams(dp(3), -1));
            LinearLayout body = column(); body.setPadding(dp(12), dp(2), dp(6), dp(2)); body.setBackgroundColor(surface);
            quote.addView(body, new LinearLayout.LayoutParams(0, -2, 1)); renderChildren(node, body, depth + 1); target.addView(quote); return;
        }
        if (node instanceof ThematicBreak) {
            View line = new View(context); line.setBackgroundColor(surface);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(1)); params.setMargins(0, dp(12), 0, dp(12));
            target.addView(line, params); return;
        }
        if (node instanceof HtmlBlock) { target.addView(text(((HtmlBlock) node).getLiteral(), 15)); return; }
        TextView view = text(inline(node), node instanceof Heading ? Math.max(16, 25 - ((Heading) node).getLevel() * 2) : 15);
        if (node instanceof Heading) {
            view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); view.setPadding(0, dp(12), 0, dp(6));
            if (android.os.Build.VERSION.SDK_INT >= 28) view.setAccessibilityHeading(true);
        } else if (node instanceof Paragraph && !(node.getParent() instanceof ListItem)) {
            view.setPadding(0, dp(4), 0, dp(12));
        }
        target.addView(view);
    }

    private SpannableStringBuilder inline(Node parent) {
        SpannableStringBuilder result = new SpannableStringBuilder();
        appendChildren(parent, result, 0); return result;
    }

    private void appendChildren(Node parent, SpannableStringBuilder target, int depth) {
        if (depth > 64) throw new RenderLimit();
        for (Node child = parent.getFirstChild(); child != null; child = child.getNext()) {
            int start = target.length();
            if (child instanceof Text) target.append(((Text) child).getLiteral());
            else if (child instanceof Code) target.append(((Code) child).getLiteral());
            else if (child instanceof SoftLineBreak) target.append('\n');
            else if (child instanceof HardLineBreak) target.append('\n');
            else if (child instanceof HtmlInline) target.append(((HtmlInline) child).getLiteral());
            else if (child instanceof Image) {
                target.append(tr("[图片：", "[Image: ")); appendChildren(child, target, depth + 1); target.append(']');
            } else appendChildren(child, target, depth + 1);
            if (target.length() == start) continue;
            if (child instanceof StrongEmphasis) span(target, new StyleSpan(Typeface.BOLD), start);
            if (child instanceof Emphasis) span(target, new StyleSpan(Typeface.ITALIC), start);
            if (child instanceof Strikethrough) span(target, new StrikethroughSpan(), start);
            if (child instanceof Code) {
                span(target, new TypefaceSpan("monospace"), start); span(target, new BackgroundColorSpan(surface), start);
            }
            if (child instanceof Link && safeLink(((Link) child).getDestination())) {
                String destination = ((Link) child).getDestination();
                span(target, new URLSpan(destination) {
                    @Override public void onClick(View widget) { openLink(destination); }
                }, start);
                span(target, new ForegroundColorSpan(accent), start);
            }
        }
    }

    private void span(SpannableStringBuilder target, Object span, int start) { target.setSpan(span, start, target.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE); }

    static boolean safeLink(String destination) {
        try {
            URI uri = new URI(destination);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            return (scheme.equals("https") || scheme.equals("http")) && uri.getHost() != null && uri.getUserInfo() == null;
        } catch (Exception error) { return false; }
    }

    private void openLink(String destination) {
        if (!safeLink(destination)) return;
        new AlertDialog.Builder(context).setTitle(tr("在浏览器中打开？", "Open in browser?"))
            .setMessage(destination).setNegativeButton(tr("取消", "Cancel"), null)
            .setPositiveButton(tr("打开", "Open"), (dialog, which) -> {
                try { context.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(destination)).addCategory(Intent.CATEGORY_BROWSABLE)); }
                catch (Exception error) { android.widget.Toast.makeText(context, tr("无法打开链接", "Cannot open link"), android.widget.Toast.LENGTH_SHORT).show(); }
            }).show();
    }

    private Button copy(String value) {
        Button button = new Button(context); button.setAllCaps(false); button.setText(tr("复制", "Copy"));
        button.setTextSize(12); button.setTextColor(accent); button.setBackgroundColor(android.graphics.Color.TRANSPARENT);
        button.setMinHeight(dp(48)); button.setContentDescription(tr("复制代码", "Copy code"));
        button.setOnClickListener(view -> {
            ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(ClipData.newPlainText("Camellia", value));
            button.setText(tr("已复制", "Copied"));
        }); return button;
    }

    private void code(String value, String language, LinearLayout target) {
        LinearLayout panel = column(); panel.setTag("markdownCode"); panel.setBackground(background(surface, false)); panel.setPadding(dp(12), 0, dp(12), dp(8));
        LinearLayout header = new LinearLayout(context); header.setGravity(Gravity.CENTER_VERTICAL);
        TextView label = text(language.split("\\s+", 2)[0], 11); label.setTextColor(muted); label.setSingleLine(true); label.setEllipsize(android.text.TextUtils.TruncateAt.END);
        Button wrap = new Button(context); wrap.setTag("markdownCodeWrap"); wrap.setAllCaps(false);
        wrap.setText(tr("自动换行", "Word wrap")); wrap.setContentDescription(tr("自动换行", "Word wrap"));
        wrap.setTextSize(12); wrap.setTextColor(accent); wrap.setMinHeight(dp(48));
        header.addView(label, new LinearLayout.LayoutParams(0, -2, 1)); header.addView(wrap, new LinearLayout.LayoutParams(-2, dp(48)));
        header.addView(copy(value), new LinearLayout.LayoutParams(-2, dp(48))); panel.addView(header);
        HorizontalScrollView horizontal = new HorizontalScrollView(context); horizontal.setTag("markdownCodeScroll");
        TextView code = text(value.endsWith("\n") ? value.substring(0, value.length() - 1) : value, 13);
        code.setTag("markdownCodeText"); code.setTypeface(Typeface.MONOSPACE);
        android.content.SharedPreferences preferences = context.getSharedPreferences("markdown", Context.MODE_PRIVATE);
        Runnable applyWrap = () -> {
            boolean wrapped = wrap.isSelected();
            if (code.getParent() == horizontal) horizontal.removeView(code);
            else if (code.getParent() == panel) panel.removeView(code);
            code.setHorizontallyScrolling(!wrapped);
            horizontal.scrollTo(0, 0); horizontal.setVisibility(wrapped ? View.GONE : View.VISIBLE);
            if (wrapped) panel.addView(code, new LinearLayout.LayoutParams(-1, -2));
            else horizontal.addView(code, new android.widget.FrameLayout.LayoutParams(-2, -2));
            wrap.setText(tr("自动换行", "Word wrap") + (wrapped ? " ✓" : ""));
        };
        panel.addView(horizontal, new LinearLayout.LayoutParams(-1, -2));
        wrap.setSelected(preferences.getBoolean("codeWrap", false)); applyWrap.run();
        wrap.setOnClickListener(view -> {
            wrap.setSelected(!wrap.isSelected());
            preferences.edit().putBoolean("codeWrap", wrap.isSelected()).apply(); applyWrap.run();
        });
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, dp(6), 0, dp(10)); target.addView(panel, params);
    }

    private void table(TableBlock node, LinearLayout target) {
        List<TableRow> rows = new ArrayList<>();
        for (Node section = node.getFirstChild(); section != null; section = section.getNext()) {
            for (Node row = section.getFirstChild(); row != null; row = row.getNext()) if (row instanceof TableRow) rows.add((TableRow) row);
        }
        if (rows.isEmpty()) return;
        int columns = 0;
        for (Node cell = rows.get(0).getFirstChild(); cell != null; cell = cell.getNext()) columns++;
        if (columns > 32 || rows.size() * columns > 1600) throw new RenderLimit();
        blocks += rows.size() * columns;
        if (blocks > 1600) throw new RenderLimit();
        int columnWidth = dp(Math.max(120, Math.min(220, (context.getResources().getDisplayMetrics().widthPixels / context.getResources().getDisplayMetrics().density - 68) / Math.max(1, columns))));
        HorizontalScrollView horizontal = new HorizontalScrollView(context); horizontal.setTag("markdownTableScroll"); horizontal.setFillViewport(true);
        LinearLayout grid = column(); grid.setTag("markdownTable");
        for (TableRow row : rows) {
            LinearLayout line = new LinearLayout(context); line.setBaselineAligned(false);
            for (Node item = row.getFirstChild(); item != null; item = item.getNext()) {
                TableCell cell = (TableCell) item;
                TextView view = text(inline(cell), 14); view.setPadding(dp(10), dp(10), dp(10), dp(10));
                GradientDrawable fill = new GradientDrawable(); fill.setColor(cell.isHeader() ? surface : android.graphics.Color.TRANSPARENT);
                fill.setStroke(dp(0.5f), (muted & 0x00ffffff) | 0x55000000); view.setBackground(fill);
                if (cell.isHeader()) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
                view.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);
                view.setGravity(Gravity.TOP | (cell.getAlignment() == TableCell.Alignment.CENTER ? Gravity.CENTER_HORIZONTAL : cell.getAlignment() == TableCell.Alignment.RIGHT ? Gravity.END : Gravity.START));
                line.addView(view, new LinearLayout.LayoutParams(columnWidth, -1));
            }
            grid.addView(line, new LinearLayout.LayoutParams(-2, -2));
        }
        horizontal.addView(grid, new android.widget.FrameLayout.LayoutParams(-2, -2));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, dp(8), 0, dp(12)); target.addView(horizontal, params);
    }

    private static final class RenderLimit extends RuntimeException { }
}
