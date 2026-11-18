package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.HashMap;
import java.util.Map;

@android.annotation.SuppressLint("ViewConstructor")
final class ExecutionProcessView extends LinearLayout {
    static final class State {
        private final Map<String, Boolean> opened = new HashMap<>();
        boolean open(String key, boolean live) {
            return open(key, live, false);
        }
        boolean open(String key, boolean live, boolean defaultOpen) {
            return opened.getOrDefault(key, defaultOpen);
        }
        void set(String key, boolean value) { opened.put(key, value); }
        void clear() { opened.clear(); }
    }

    private final ChatStyle style;
    private final boolean chinese;
    private final String key;
    private final State state;
    private final LinearLayout body, header;
    private final TextView caption, icon;
    private final View rule, footer;
    private final TextView collapse;
    private final ImageView arrow;
    private JSONArray entries = new JSONArray();
    private boolean expanded;
    private int fileCount;

    ExecutionProcessView(Context context, ChatStyle style, State state, String key) {
        super(context); this.style = style; this.state = state; this.key = key;
        chinese = context.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        setOrientation(VERTICAL); setTag("executionProcess:" + key);
        setBackgroundColor(android.graphics.Color.TRANSPARENT);
        LayoutParams params = new LayoutParams(-1, -2); params.setMargins(0, 0, 0, style.dp(10)); setLayoutParams(params);
        header = new LinearLayout(context); header.setGravity(Gravity.CENTER_VERTICAL); header.setMinimumHeight(style.dp(48));
        header.setPadding(0, style.dp(8), 0, style.dp(8)); header.setFocusable(true); header.setTag("processToggle:" + key);
        header.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_PAGE), null, style.rounded(Color.WHITE)));
        icon = label("◇", 19); icon.setPadding(0, 0, style.dp(10), 0); header.addView(icon);
        caption = label("", 13); header.addView(caption, new LayoutParams(0, -2, 1));
        arrow = new ImageView(context); header.addView(arrow, new LayoutParams(style.dp(18), style.dp(18)));
        addView(header);
        rule = new View(context); rule.setBackgroundColor(Palette.of(context).separator); rule.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        addView(rule, new LayoutParams(-1, Math.max(1, style.dp(1)))); rule.setVisibility(GONE);
        body = new LinearLayout(context); body.setOrientation(VERTICAL); body.setPadding(style.dp(10), style.dp(4), style.dp(10), style.dp(8));
        body.setTag("processBody:" + key); addView(body);
        header.setOnClickListener(view -> { if (entries.length() > 0) setExpanded(!expanded); });
        LinearLayout end = new LinearLayout(context); end.setOrientation(VERTICAL);
        end.setTag("processCollapseFooter:" + key);
        View border = new View(context); border.setBackgroundColor(Palette.of(context).separator);
        border.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        end.addView(border, new LayoutParams(-1, Math.max(1, style.dp(1))));
        collapse = label(tr("收起", "Collapse"), 12); collapse.setTag("processCollapse:" + key);
        collapse.setGravity(Gravity.CENTER); collapse.setMinHeight(style.dp(48));
        collapse.setPadding(style.dp(12), style.dp(8), style.dp(12), style.dp(8)); collapse.setFocusable(true);
        collapse.setContentDescription(tr("收起执行过程", "Collapse execution process"));
        LineIcon up = new LineIcon("up", style.muted); up.setBounds(0, 0, style.dp(14), style.dp(14));
        android.text.SpannableString collapseLabel = new android.text.SpannableString("  " + tr("收起", "Collapse"));
        collapseLabel.setSpan(new android.text.style.ImageSpan(up), 0, 1, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        collapse.setText(collapseLabel);
        collapse.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_PAGE), null, style.rounded(Color.WHITE)));
        collapse.setAccessibilityDelegate(new AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View host, android.view.accessibility.AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info); info.setClassName("android.widget.Button");
                info.addAction(android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction.ACTION_COLLAPSE);
            }
            @Override public boolean performAccessibilityAction(View host, int action, android.os.Bundle args) {
                if (action == android.view.accessibility.AccessibilityNodeInfo.ACTION_COLLAPSE) { collapseFromFooter(); return true; }
                return super.performAccessibilityAction(host, action, args);
            }
        });
        collapse.setOnClickListener(view -> collapseFromFooter()); end.addView(collapse, new LayoutParams(-1, -2));
        footer = end; footer.setVisibility(GONE); addView(footer, new LayoutParams(-1, -2));
    }

    private void collapseFromFooter() {
        if (!expanded || entries.length() == 0) return;
        boolean focused = collapse.hasFocus(), accessibilityFocused = collapse.isAccessibilityFocused();
        setExpanded(false);
        if (focused) header.requestFocus();
        if (accessibilityFocused) header.sendAccessibilityEvent(android.view.accessibility.AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED);
    }

    private void setExpanded(boolean value) {
        Runnable change = () -> { expanded = value; state.set(key, value); renderBody(); };
        android.view.ViewParent parent = getParent();
        while (parent != null && !(parent instanceof ChatScrollView)) parent = parent.getParent();
        if (parent instanceof ChatScrollView) ((ChatScrollView) parent).changeProcess(header, value, change);
        else {
            change.run();
            header.post(() -> { if (header.isAttachedToWindow()) header.requestRectangleOnScreen(new android.graphics.Rect(0, 0, header.getWidth(), header.getHeight()), true); });
        }
    }

    private String tr(String zh, String en) { return chinese ? zh : en; }
    private TextView label(String value, int size) {
        TextView text = new TextView(getContext()); text.setText(value); text.setTextSize(MobilePreferences.chatTextSize(getContext(), size)); text.setTextColor(style.muted); text.setLineSpacing(style.dp(3), 1); return text;
    }

    void update(JSONArray process, boolean live) {
        update(process, live, null, 0);
    }

    void update(JSONArray process, boolean live, TurnDetails details) {
        update(process, live, details, 0);
    }

    void update(JSONArray process, boolean live, TurnDetails details, int files) {
        entries = process == null ? new JSONArray() : process;
        fileCount = Math.max(0, files);
        expanded = state.open(key, live, MobilePreferences.processExpanded(getContext(), live));
        int tools = 0; boolean onlyThinking = entries.length() > 0;
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.optJSONObject(index); if (entry == null) continue;
            if (entry.optString("type").equals("tool")) tools++;
            if (!entry.optString("type").equals("thinking")) onlyThinking = false;
        }
        String title = onlyThinking ? live ? tr("正在思考", "Thinking") : tr("思考已完成", "Thinking completed")
            : live ? tr("执行中", "Running") : tr("已完成", "Completed");
        String summary = title + (tools > 0 ? " · " + tools + tr(" 次工具调用", " tool calls") : "")
            + (fileCount > 0 ? " · " + fileCount + tr(" 个文件", " files") : "");
        caption.setText(summary);
        boolean terminal = !live && details != null && details.terminal();
        if (terminal) {
            int elapsed = details.state.equals("stopped") ? R.string.turn_stopped_elapsed : details.state.equals("error") ? R.string.turn_failed_elapsed : R.string.turn_completion_elapsed;
            String state = details.state.equals("stopped") ? tr("已停止", "Stopped")
                : details.state.equals("error") ? tr("失败", "Failed") : tr("已完成", "Completed");
            String stateAndElapsed = details.duration == null ? state : getContext().getString(elapsed, details.elapsed());
            caption.setText(stateAndElapsed
                + (tools > 0 ? " · " + tools + tr(" 次工具调用", " tool calls") : "")
                + (fileCount > 0 ? " · " + fileCount + tr(" 个文件", " files") : ""));
        }
        icon.setText(details != null && details.state.equals("error") ? "!"
            : details != null && details.state.equals("stopped") ? "■" : live ? "◌" : "✓");
        icon.setTextSize(14);
        icon.setTextColor(details != null && details.state.equals("error") ? Palette.of(getContext()).error
            : details != null && details.state.equals("stopped") ? style.muted : live ? style.accent : Palette.of(getContext()).success);
        icon.setVisibility(entries.length() == 0 && !terminal ? GONE : VISIBLE);
        header.setClickable(entries.length() > 0); header.setFocusable(entries.length() > 0);
        caption.setTextColor(terminal ? style.faint : style.muted);
        setVisibility(entries.length() == 0 && !terminal ? GONE : VISIBLE); renderBody();
    }

    private void renderBody() {
        arrow.setImageDrawable(new LineIcon(expanded ? "down" : "right", style.muted));
        arrow.setVisibility(entries.length() == 0 ? GONE : VISIBLE);
        header.setContentDescription(caption.getText() + (entries.length() == 0 ? "" : expanded ? tr("，收起", ", collapse") : tr("，展开", ", expand")));
        body.setVisibility(expanded ? VISIBLE : GONE); body.removeAllViews();
        footer.setVisibility(expanded && entries.length() > 0 ? VISIBLE : GONE);
        rule.setVisibility(expanded && entries.length() > 0 ? VISIBLE : GONE);
        header.setPadding(expanded ? style.dp(12) : 0, style.dp(8), expanded ? style.dp(12) : 0, style.dp(8));
        if (expanded) {
            var face = style.rounded(style.surface); face.setStroke(style.dp(1), Palette.of(getContext()).separator); setBackground(face);
        } else setBackgroundColor(Color.TRANSPARENT);
        if (!expanded) return;
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.optJSONObject(index); if (entry == null) continue;
            String type = entry.optString("type"), title = entry.optString("title");
            if (type.equals("tool")) {
                String id = entry.optString("id");
                body.addView(new ProcessToolView(getContext(), style, state, key + ":tool:" + (id.isEmpty() ? index : id), entry));
                continue;
            }
            if (title.isEmpty()) title = type.equals("thinking") ? tr("思考", "Reasoning") : type.equals("plan") ? tr("计划", "Plan") : tr("过程信息", "Progress");
            String status = entry.optString("status");
            if (!status.isEmpty()) title += " · " + (status.equals("completed") ? tr("已完成", "Completed") : status.equals("failed") ? tr("失败", "Failed") : status.equals("cancelled") ? tr("已停止", "Stopped") : tr("进行中", "Running"));
            TextView heading = label(title, 12); heading.setPadding(0, style.dp(10), 0, style.dp(5)); body.addView(heading);
            String input = entry.optString("input"), text = entry.optString("text");
            TextView detail = label((input.isEmpty() ? "" : input + "\n") + text, 13); detail.setTextColor(style.ink); detail.setTextIsSelectable(true);
            detail.setPadding(0, 0, 0, style.dp(8));
            body.addView(detail);
            if (entry.optBoolean("truncated")) body.addView(label(tr("内容过长，仅显示部分。", "Long output: partial content shown."), 11));
        }
    }
}
