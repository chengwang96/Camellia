package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;

/** Desktop-style input/output card, shared by local and remote execution history. */
@android.annotation.SuppressLint("ViewConstructor")
final class ProcessToolView extends LinearLayout {
    private final ChatStyle style;
    private final Palette palette;
    private final boolean chinese;
    private final ExecutionProcessView.State state;
    private final String key, name, status, input, output;
    private final boolean truncated;
    private final LinearLayout header, detail;
    private final ImageView arrow;
    private boolean open, populated;

    ProcessToolView(Context context, ChatStyle style, ExecutionProcessView.State state, String key, JSONObject entry) {
        super(context);
        this.style = style; this.state = state; this.key = key; palette = Palette.of(context);
        chinese = context.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        name = entry.optString("title"); status = entry.optString("status");
        input = entry.optString("input"); output = entry.optString("text"); truncated = entry.optBoolean("truncated");
        open = state.open(key, false);
        setOrientation(VERTICAL); setTag("processTool:" + key);
        GradientDrawable face = style.rounded(palette.card); face.setStroke(style.dp(1), palette.cardBorder); setBackground(face);
        setClipToOutline(true);
        LayoutParams params = new LayoutParams(-1, -2); params.setMargins(0, style.dp(4), 0, style.dp(4)); setLayoutParams(params);

        header = new LinearLayout(context); header.setGravity(Gravity.CENTER_VERTICAL); header.setMinimumHeight(style.dp(48));
        header.setPadding(style.dp(10), style.dp(8), style.dp(10), style.dp(8)); header.setTag("processToolToggle:" + key);
        header.setFocusable(true);
        header.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), null, style.rounded(Color.WHITE)));
        arrow = new ImageView(context); arrow.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        LayoutParams arrowParams = new LayoutParams(style.dp(16), style.dp(16)); arrowParams.setMarginEnd(style.dp(8)); header.addView(arrow, arrowParams);

        LinearLayout labels = new LinearLayout(context); labels.setOrientation(VERTICAL);
        TextView title = label(displayName(), 13, style.ink); title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setSingleLine(true); title.setEllipsize(TextUtils.TruncateAt.END); labels.addView(title, new LayoutParams(-1, -2));
        String summary = summary();
        if (!summary.isEmpty()) {
            TextView preview = label(summary, 11, style.muted); preview.setTypeface(Typeface.MONOSPACE);
            preview.setSingleLine(true); preview.setEllipsize(TextUtils.TruncateAt.END); preview.setTag("processToolSummary:" + key);
            labels.addView(preview, new LayoutParams(-1, -2));
        }
        header.addView(labels, new LayoutParams(0, -2, 1));

        View dot = new View(context); GradientDrawable marker = new GradientDrawable(); marker.setShape(GradientDrawable.OVAL); marker.setColor(statusColor()); dot.setBackground(marker);
        dot.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        LayoutParams dotParams = new LayoutParams(style.dp(6), style.dp(6)); dotParams.setMargins(style.dp(10), 0, style.dp(5), 0); header.addView(dot, dotParams);
        TextView statusLabel = label(statusTitle(), 11, statusColor()); statusLabel.setSingleLine(true); header.addView(statusLabel);
        header.setAccessibilityDelegate(new AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info); info.setClassName("android.widget.Button");
                info.addAction(open ? AccessibilityNodeInfo.AccessibilityAction.ACTION_COLLAPSE : AccessibilityNodeInfo.AccessibilityAction.ACTION_EXPAND);
            }
            @Override public boolean performAccessibilityAction(View host, int action, android.os.Bundle args) {
                if (action == AccessibilityNodeInfo.ACTION_EXPAND || action == AccessibilityNodeInfo.ACTION_COLLAPSE) {
                    setOpen(action == AccessibilityNodeInfo.ACTION_EXPAND); return true;
                }
                return super.performAccessibilityAction(host, action, args);
            }
        });
        header.setOnClickListener(view -> setOpen(!open)); addView(header, new LayoutParams(-1, -2));
        detail = new LinearLayout(context); detail.setOrientation(VERTICAL); detail.setPadding(style.dp(10), 0, style.dp(10), style.dp(10));
        detail.setTag("processToolBody:" + key); addView(detail, new LayoutParams(-1, -2));
        render();
    }

    private String tr(String zh, String en) { return chinese ? zh : en; }

    private String displayName() {
        switch (name) {
            case "commandExecution": case "Shell": case "Bash": case "exec_command": return tr("命令", "Command");
            case "fileChange": return tr("文件修改", "File changes");
            case "Read": return tr("读取文件", "Read file");
            case "Write": return tr("写入文件", "Write file");
            case "Edit": case "apply_patch": return tr("编辑文件", "Edit file");
            case "web_search": case "camellia_web_search": return tr("搜索网页", "Web search");
            case "web_fetch": case "camellia_web_fetch": return tr("读取网页", "Read web page");
            case "": case "Tool": return tr("工具调用", "Tool call");
            default: return name;
        }
    }

    private String summary() {
        String value = input.trim();
        // Local tools store their allowlisted arguments as JSON; remote tools
        // already supply the command/path/query itself.
        if (value.startsWith("{")) try {
            JSONObject arguments = new JSONObject(value);
            for (String field : new String[]{"command", "cmd", "file_path", "path", "query", "url", "pattern"}) {
                Object candidate = arguments.opt(field);
                if (candidate instanceof String && !((String) candidate).trim().isEmpty()) { value = ((String) candidate).trim(); break; }
            }
        } catch (org.json.JSONException ignored) { }
        return value.replaceAll("\\s+", " ");
    }

    private boolean pending() { return status.equals("in_progress") || status.equals("running"); }
    private int statusColor() { return status.equals("failed") ? palette.error : status.equals("completed") ? palette.success : pending() ? style.accent : style.muted; }
    private String statusTitle() { return status.equals("completed") ? tr("已完成", "Done") : status.equals("failed") ? tr("失败", "Failed") : status.equals("cancelled") ? tr("已停止", "Stopped") : pending() ? tr("进行中", "Running") : tr("状态未知", "Unknown"); }

    private TextView label(String value, int size, int color) {
        TextView text = new TextView(getContext()); text.setText(value); text.setTextSize(MobilePreferences.chatTextSize(getContext(), size));
        text.setTextColor(color); text.setIncludeFontPadding(false); text.setLineSpacing(style.dp(3), 1); return text;
    }

    private void setOpen(boolean value) { open = value; state.set(key, open); render(); }

    private void render() {
        arrow.setImageDrawable(new LineIcon(open ? "down" : "right", style.muted));
        String preview = summary(); if (preview.length() > 300) preview = preview.substring(0, 300) + "…";
        header.setContentDescription(displayName() + (preview.isEmpty() ? "" : ", " + preview) + ", " + statusTitle() + tr(open ? "，收起" : "，展开", open ? ", collapse" : ", expand"));
        if (android.os.Build.VERSION.SDK_INT >= 30) header.setStateDescription(tr(open ? "已展开" : "已收起", open ? "Expanded" : "Collapsed"));
        detail.setVisibility(open ? VISIBLE : GONE);
        if (!open || populated) return;
        populated = true;
        View rule = new View(getContext()); rule.setBackgroundColor(palette.separator); rule.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        detail.addView(rule, new LayoutParams(-1, Math.max(1, style.dp(1))));
        // Preserve the provider's exact name without making every collapsed row
        // a repeated implementation label such as commandExecution.
        if (!name.isEmpty() && !name.equals(displayName())) {
            TextView nativeName = label(name, 11, style.muted); nativeName.setPadding(0, style.dp(8), 0, 0); detail.addView(nativeName);
        }
        section(tr("输入", "Input"), input.isEmpty() ? tr("无输入", "No input") : input, false, "input");
        section(tr("输出", "Output"), output.isEmpty() ? pending() ? tr("等待结果…", "Waiting for result…") : tr("无输出", "No output") : output, status.equals("failed"), "output");
        if (truncated) {
            TextView note = label(tr("内容过长，仅显示部分。", "Long output: partial content shown."), 11, style.muted);
            note.setPadding(0, style.dp(8), 0, 0); detail.addView(note);
        }
    }

    private void section(String title, String content, boolean failed, String section) {
        TextView caption = label(title, 11, style.muted); caption.setPadding(0, style.dp(8), 0, style.dp(5)); detail.addView(caption);
        TextView text = label(content, 12, failed ? palette.error : style.ink); text.setTypeface(Typeface.MONOSPACE); text.setTextIsSelectable(true);
        text.setPadding(style.dp(8), style.dp(8), style.dp(8), style.dp(8)); text.setTag("processTool:" + section + ":" + key);
        CodeScroll scroll = new CodeScroll(getContext()); scroll.setFillViewport(false); scroll.setClipToOutline(true);
        GradientDrawable background = style.rounded(style.surface); background.setCornerRadius(style.dp(Palette.RADIUS_CODE));
        background.setStroke(style.dp(1), failed ? palette.error : palette.separator); scroll.setBackground(background);
        scroll.addView(text, new ScrollView.LayoutParams(-1, -2)); detail.addView(scroll, new LayoutParams(-1, -2));
    }

    /** Keep long results readable without making a single tool fill the transcript. */
    private final class CodeScroll extends ScrollView {
        private float lastY;
        CodeScroll(Context context) { super(context); setVerticalScrollBarEnabled(false); setHorizontalScrollBarEnabled(false); }
        @Override protected void onMeasure(int width, int height) {
            int limit = style.dp(220);
            if (MeasureSpec.getMode(height) != MeasureSpec.UNSPECIFIED) limit = Math.min(limit, MeasureSpec.getSize(height));
            super.onMeasure(width, MeasureSpec.makeMeasureSpec(limit, MeasureSpec.AT_MOST));
        }
        @Override public boolean dispatchTouchEvent(MotionEvent event) {
            int action = event.getActionMasked();
            if (getParent() != null) {
                if (action == MotionEvent.ACTION_DOWN) getParent().requestDisallowInterceptTouchEvent(canScrollVertically(-1) || canScrollVertically(1));
                else if (action == MotionEvent.ACTION_MOVE) getParent().requestDisallowInterceptTouchEvent(canScrollVertically(event.getY() < lastY ? 1 : -1));
                else if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) getParent().requestDisallowInterceptTouchEvent(false);
            }
            lastY = event.getY(); return super.dispatchTouchEvent(event);
        }
    }
}
