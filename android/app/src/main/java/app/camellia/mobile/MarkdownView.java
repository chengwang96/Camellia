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
import android.text.Editable;
import android.text.Selection;
import android.text.Spannable;
import android.text.TextUtils;
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
import android.widget.ImageButton;
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
import java.util.function.Supplier;

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

    Session session(LinearLayout target) { return new Session(target); }

    /** Bindings retain fingerprints and Views, never completed ASTs or source slices. */
    final class Session {
        private final LinearLayout target;
        private final List<Binding> bindings = new ArrayList<>();
        private TextView preview, raw;
        int createdRoots;
        Session(LinearLayout target) { this.target = target; }
        void history(String source) { apply(MarkdownStream.completed(parser.parse(source), source)); }

        void apply(MarkdownStream.Update update) {
            for (MarkdownStream.Change change : update.changes) {
                if (change.raw != null) {
                    if (raw == null) {
                        target.removeAllViews(); bindings.clear(); preview = null;
                        raw = text(change.raw, 15); target.addView(raw); createdRoots++;
                    } else patchText(raw, change.raw);
                } else if (change.preview != null) {
                    if (preview == null) { preview = text("", 15); target.addView(preview); createdRoots++; }
                    patchText(preview, change.preview);
                } else if (change.codeAppend != null) {
                    Binding binding = bindings.get(change.from);
                    CodeContent content = (CodeContent) binding.views.get(0).getTag(R.id.markdown_code_content);
                    if (change.codeRemove > 0) {
                        content.text.append(""); Editable value = content.text.getEditableText();
                        value.delete(value.length() - change.codeRemove, value.length());
                    }
                    if (!change.codeAppend.isEmpty()) content.text.append(change.codeAppend);
                    content.newline = change.codeNewline; binding.signature = 0;
                } else if (change.rows != null) {
                    Binding binding = bindings.get(change.from);
                    LinearLayout grid = binding.views.get(0).findViewWithTag("markdownTable");
                    for (int i = 0; i < change.rows.size(); i++) patchRow(grid, change.tableRow + i, change.rows.get(i), binding.columns);
                    if (change.tableTrim) while (grid.getChildCount() > change.tableRow) grid.removeViewAt(grid.getChildCount() - 1);
                    binding.signature = 0;
                } else if (change.chunks != null) replace(change.from, change.chunks);
            }
        }

        private void replace(int from, List<MarkdownStream.Chunk> chunks) {
            if (raw != null) { target.removeView(raw); raw = null; }
            if (preview != null) { target.removeView(preview); preview = null; }
            int position = 0;
            for (int i = 0; i < from; i++) position += bindings.get(i).views.size();
            for (int i = 0; i < chunks.size(); i++) {
                MarkdownStream.Chunk chunk = chunks.get(i); int index = from + i;
                Binding binding = index < bindings.size() ? bindings.get(index) : null;
                String language = chunk.node instanceof FencedCodeBlock ? ((FencedCodeBlock) chunk.node).getInfo() : "";
                int columns = chunk.node instanceof TableBlock ? tableColumns((TableBlock) chunk.node) : 0;
                if (binding == null || !binding.kind.equals(chunk.node.getClass()) || !binding.language.equals(language) || binding.columns != columns) {
                    if (binding != null) for (View view : binding.views) target.removeView(view);
                    binding = new Binding(chunk.node.getClass(), language, columns);
                    if (chunk.node instanceof BulletList || chunk.node instanceof OrderedList) patchList(binding, chunk, position);
                    else if (chunk.node instanceof BlockQuote) {
                        LinearLayout quote = new LinearLayout(context); quote.setTag("markdownQuote");
                        View line = new View(context); line.setBackgroundColor(accent); quote.addView(line, new LinearLayout.LayoutParams(dp(3), -1));
                        LinearLayout body = column(); body.setPadding(dp(12), dp(2), dp(6), dp(2)); body.setBackgroundColor(surface);
                        body.setTag(R.id.markdown_nested_session, session(body)); quote.addView(body, new LinearLayout.LayoutParams(0, -2, 1));
                        target.addView(quote, position); binding.views.add(quote); createdRoots++; patchQuote(binding, chunk);
                    } else {
                        LinearLayout fresh = column(); blocks = 0; renderBlock(chunk.node, fresh, 0);
                        while (fresh.getChildCount() > 0) {
                            View view = fresh.getChildAt(0); fresh.removeViewAt(0); target.addView(view, position + binding.views.size());
                            binding.views.add(view); createdRoots++;
                        }
                    }
                    if (index < bindings.size()) bindings.set(index, binding); else bindings.add(binding);
                } else if (binding.signature != chunk.signature) {
                    if (chunk.node instanceof BulletList || chunk.node instanceof OrderedList) patchList(binding, chunk, position);
                    else if (chunk.node instanceof BlockQuote) patchQuote(binding, chunk);
                    else if (chunk.node instanceof FencedCodeBlock || chunk.node instanceof IndentedCodeBlock) {
                        String value = chunk.node instanceof FencedCodeBlock ? ((FencedCodeBlock) chunk.node).getLiteral() : ((IndentedCodeBlock) chunk.node).getLiteral();
                        CodeContent content = (CodeContent) binding.views.get(0).getTag(R.id.markdown_code_content);
                        content.newline = value.endsWith("\n");
                        patchText(content.text, content.newline ? value.substring(0, value.length() - 1) : value);
                    } else if (chunk.node instanceof TableBlock) {
                        LinearLayout grid = binding.views.get(0).findViewWithTag("markdownTable");
                        List<TableRow> rows = MarkdownStream.tableRows(chunk.node);
                        for (int row = 0; row < rows.size(); row++) patchRow(grid, row, rows.get(row), columns);
                        while (grid.getChildCount() > rows.size()) grid.removeViewAt(grid.getChildCount() - 1);
                    } else if ((chunk.node instanceof Paragraph || chunk.node instanceof Heading || chunk.node instanceof HtmlBlock) && binding.views.size() == 1) {
                        TextView view = (TextView) binding.views.get(0);
                        setInline(view, chunk.node instanceof HtmlBlock ? ((HtmlBlock) chunk.node).getLiteral() : inline(chunk.node));
                        if (chunk.node instanceof Heading) view.setTextSize(Math.max(16, 25 - ((Heading) chunk.node).getLevel() * 2));
                    } else {
                        for (View view : binding.views) target.removeView(view);
                        binding.views.clear(); LinearLayout fresh = column(); blocks = 0; renderBlock(chunk.node, fresh, 0);
                        while (fresh.getChildCount() > 0) {
                            View view = fresh.getChildAt(0); fresh.removeViewAt(0); target.addView(view, position + binding.views.size());
                            binding.views.add(view); createdRoots++;
                        }
                    }
                }
                binding.signature = chunk.signature; position += binding.views.size();
            }
            while (bindings.size() > from + chunks.size()) {
                Binding removed = bindings.remove(bindings.size() - 1); for (View view : removed.views) target.removeView(view);
            }
        }

        private void patchQuote(Binding binding, MarkdownStream.Chunk chunk) {
            LinearLayout body = (LinearLayout) ((LinearLayout) binding.views.get(0)).getChildAt(1);
            ((Session) body.getTag(R.id.markdown_nested_session)).replace(0, chunk.children);
        }
        private void patchList(Binding binding, MarkdownStream.Chunk chunk, int position) {
            int start = chunk.node instanceof OrderedList ? ((OrderedList) chunk.node).getStartNumber() : 0;
            for (int item = 0; item < chunk.children.size(); item++) {
                LinearLayout row;
                if (item < binding.views.size()) row = (LinearLayout) binding.views.get(item);
                else {
                    row = new LinearLayout(context); row.setGravity(Gravity.TOP);
                    TextView marker = text("", 15); marker.setGravity(Gravity.END); marker.setPadding(0, dp(4), dp(8), 0);
                    row.addView(marker, new LinearLayout.LayoutParams(dp(34), -2));
                    LinearLayout body = column(); body.setTag(R.id.markdown_nested_session, session(body)); row.addView(body, new LinearLayout.LayoutParams(0, -2, 1));
                    target.addView(row, position + item); binding.views.add(row); createdRoots++;
                }
                TextView marker = (TextView) row.getChildAt(0); String value = chunk.node instanceof OrderedList ? (start + item) + "." : "•";
                if (!TextUtils.equals(marker.getText(), value)) marker.setText(value);
                LinearLayout body = (LinearLayout) row.getChildAt(1);
                ((Session) body.getTag(R.id.markdown_nested_session)).replace(0, chunk.children.get(item).children);
            }
            while (binding.views.size() > chunk.children.size()) target.removeView(binding.views.remove(binding.views.size() - 1));
        }
    }

    private static final class Binding {
        final Class<?> kind;
        final String language;
        final int columns;
        final List<View> views = new ArrayList<>();
        long signature;
        Binding(Class<?> kind, String language, int columns) { this.kind = kind; this.language = language; this.columns = columns; }
    }
    private static final class CodeContent {
        final TextView text;
        boolean newline;
        CodeContent(TextView text, boolean newline) { this.text = text; this.newline = newline; }
        String value() { return text.getText().toString() + (newline ? "\n" : ""); }
    }
    private void setInline(TextView view, CharSequence value) {
        int start = view.getSelectionStart(), end = view.getSelectionEnd();
        int selectedEnd = Math.max(start, end);
        boolean preserve = start >= 0 && end >= 0 && selectedEnd <= value.length() && TextUtils.regionMatches(view.getText(), 0, value, 0, selectedEnd);
        view.setText(value, TextView.BufferType.SPANNABLE);
        boolean links = value instanceof Spanned && ((Spanned) value).getSpans(0, value.length(), URLSpan.class).length > 0;
        view.setTextIsSelectable(true);
        view.setMovementMethod(links ? LinkMovementMethod.getInstance() : android.text.method.ArrowKeyMovementMethod.getInstance());
        if (preserve && view.getText() instanceof Spannable)
            Selection.setSelection((Spannable) view.getText(), Math.min(start, value.length()), Math.min(end, value.length()));
    }
    private static void patchText(TextView view, String value) {
        CharSequence old = view.getText(); if (TextUtils.equals(old, value)) return;
        if (value.length() >= old.length() && TextUtils.regionMatches(value, 0, old, 0, old.length())) view.append(value.substring(old.length()));
        else view.setText(value, TextView.BufferType.SPANNABLE);
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
        GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(Palette.RADIUS_CODE));
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
        new CamelliaDialog.Builder(context).setTitle(tr("在浏览器中打开？", "Open in browser?"))
            .setMessage(destination).setNegativeButton(tr("取消", "Cancel"), null)
            .setPositiveButton(tr("打开", "Open"), (dialog, which) -> {
                try { context.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(destination)).addCategory(Intent.CATEGORY_BROWSABLE)); }
                catch (Exception error) { android.widget.Toast.makeText(context, tr("无法打开链接", "Cannot open link"), android.widget.Toast.LENGTH_SHORT).show(); }
            }).show();
    }

    private Button copy(Supplier<String> value) {
        Button button = new Button(context); button.setAllCaps(false); button.setText(tr("复制", "Copy"));
        button.setTextSize(Palette.TEXT_SMALL); button.setTextColor(accent); button.setBackgroundColor(android.graphics.Color.TRANSPARENT);
        button.setMinHeight(dp(48)); button.setContentDescription(tr("复制代码", "Copy code"));
        button.setOnClickListener(view -> {
            ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(ClipData.newPlainText("Camellia", value.get()));
            button.setText(tr("已复制", "Copied"));
            MobileHaptics.success(view);
        }); return button;
    }

    private void code(String value, String language, LinearLayout target) {
        LinearLayout panel = column(); panel.setTag("markdownCode"); panel.setBackground(background(surface, false)); panel.setPadding(dp(12), 0, dp(12), dp(8));
        TextView code = text(value.endsWith("\n") ? value.substring(0, value.length() - 1) : value, 13);
        code.setTag("markdownCodeText"); code.setTypeface(Typeface.MONOSPACE);
        CodeContent content = new CodeContent(code, value.endsWith("\n")); panel.setTag(R.id.markdown_code_content, content);
        LinearLayout header = new LinearLayout(context); header.setGravity(Gravity.CENTER_VERTICAL);
        TextView label = text(language.split("\\s+", 2)[0], 11); label.setTextColor(muted); label.setSingleLine(true); label.setEllipsize(android.text.TextUtils.TruncateAt.END);
        ImageButton wrap = new ImageButton(context); wrap.setTag("markdownCodeWrap");
        wrap.setContentDescription(tr("自动换行", "Word wrap")); wrap.setTooltipText(tr("自动换行", "Word wrap"));
        wrap.setBackgroundColor(android.graphics.Color.TRANSPARENT); wrap.setPadding(dp(14), dp(14), dp(14), dp(14));
        header.addView(label, new LinearLayout.LayoutParams(0, -2, 1)); header.addView(wrap, new LinearLayout.LayoutParams(dp(48), dp(48)));
        header.addView(copy(content::value), new LinearLayout.LayoutParams(-2, dp(48))); panel.addView(header);
        HorizontalScrollView horizontal = new HorizontalScrollView(context); horizontal.setTag("markdownCodeScroll");
        android.content.SharedPreferences preferences = context.getSharedPreferences("markdown", Context.MODE_PRIVATE);
        Runnable applyWrap = () -> {
            boolean wrapped = wrap.isSelected();
            if (code.getParent() == horizontal) horizontal.removeView(code);
            else if (code.getParent() == panel) panel.removeView(code);
            code.setHorizontallyScrolling(!wrapped);
            horizontal.scrollTo(0, 0); horizontal.setVisibility(wrapped ? View.GONE : View.VISIBLE);
            if (wrapped) panel.addView(code, new LinearLayout.LayoutParams(-1, -2));
            else horizontal.addView(code, new android.widget.FrameLayout.LayoutParams(-2, -2));
            wrap.setImageDrawable(new LineIcon(wrapped ? "code-nowrap" : "code-wrap", ink));
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
        for (int row = 0; row < rows.size(); row++) patchRow(grid, row, rows.get(row), columns);
        horizontal.addView(grid, new android.widget.FrameLayout.LayoutParams(-2, -2));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, dp(8), 0, dp(12)); target.addView(horizontal, params);
    }

    private int tableColumns(TableBlock node) {
        List<TableRow> rows = MarkdownStream.tableRows(node);
        return rows.isEmpty() ? 0 : MarkdownStream.children(rows.get(0)).size();
    }
    private void patchRow(LinearLayout grid, int index, TableRow row, int columns) {
        LinearLayout line;
        if (index < grid.getChildCount()) line = (LinearLayout) grid.getChildAt(index);
        else {
            line = new LinearLayout(context); line.setBaselineAligned(false);
            grid.addView(line, new LinearLayout.LayoutParams(-2, -2));
        }
        int columnWidth = dp(Math.max(120, Math.min(220, (context.getResources().getDisplayMetrics().widthPixels / context.getResources().getDisplayMetrics().density - 68) / Math.max(1, columns))));
        int column = 0;
        for (Node item = row.getFirstChild(); item != null; item = item.getNext(), column++) {
            TableCell cell = (TableCell) item; long signature = MarkdownStream.fingerprint(cell);
            TextView view;
            if (column < line.getChildCount()) view = (TextView) line.getChildAt(column);
            else {
                view = text("", 14); view.setPadding(dp(10), dp(10), dp(10), dp(10));
                line.addView(view, new LinearLayout.LayoutParams(columnWidth, -1));
            }
            if (Long.valueOf(signature).equals(view.getTag(R.id.markdown_cell_fingerprint))) continue;
            setInline(view, inline(cell)); view.setTag(R.id.markdown_cell_fingerprint, signature);
            GradientDrawable fill = new GradientDrawable(); fill.setColor(cell.isHeader() ? surface : android.graphics.Color.TRANSPARENT);
            fill.setStroke(dp(0.5f), (muted & 0x00ffffff) | 0x55000000); view.setBackground(fill);
            view.setTypeface(Typeface.DEFAULT, cell.isHeader() ? Typeface.BOLD : Typeface.NORMAL);
            view.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);
            view.setGravity(Gravity.TOP | (cell.getAlignment() == TableCell.Alignment.CENTER ? Gravity.CENTER_HORIZONTAL : cell.getAlignment() == TableCell.Alignment.RIGHT ? Gravity.END : Gravity.START));
        }
        while (line.getChildCount() > column) line.removeViewAt(line.getChildCount() - 1);
    }

    private static final class RenderLimit extends RuntimeException { }
}
