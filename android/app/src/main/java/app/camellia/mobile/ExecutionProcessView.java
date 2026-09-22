package app.camellia.mobile;

import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
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
        private final Map<String, Boolean> running = new HashMap<>();
        boolean open(String key, boolean live) {
            if (Boolean.TRUE.equals(running.get(key)) && !live) opened.remove(key);
            running.put(key, live); return Boolean.TRUE.equals(opened.get(key));
        }
        void set(String key, boolean value) { opened.put(key, value); }
        void clear() { opened.clear(); running.clear(); }
    }

    private final ChatStyle style;
    private final boolean chinese;
    private final String key;
    private final State state;
    private final LinearLayout body, header;
    private final TextView caption;
    private final ImageView arrow;
    private JSONArray entries = new JSONArray();
    private boolean expanded;

    ExecutionProcessView(Context context, ChatStyle style, State state, String key) {
        super(context); this.style = style; this.state = state; this.key = key;
        chinese = context.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        setOrientation(VERTICAL); setTag("executionProcess:" + key);
        GradientDrawable border = style.rounded(style.background); border.setStroke(style.dp(1), ModelPickerPopup.blend(style.background, style.muted, .22f)); setBackground(border);
        LayoutParams params = new LayoutParams(-1, -2); params.setMargins(0, 0, 0, style.dp(14)); setLayoutParams(params);
        header = new LinearLayout(context); header.setGravity(Gravity.CENTER_VERTICAL); header.setMinimumHeight(style.dp(48));
        header.setPadding(style.dp(12), style.dp(8), style.dp(12), style.dp(8)); header.setFocusable(true); header.setTag("processToggle:" + key);
        TextView icon = label("◇", 19); icon.setPadding(0, 0, style.dp(10), 0); header.addView(icon);
        caption = label("", 14); header.addView(caption, new LayoutParams(0, -2, 1));
        arrow = new ImageView(context); header.addView(arrow, new LayoutParams(style.dp(18), style.dp(18)));
        addView(header); body = new LinearLayout(context); body.setOrientation(VERTICAL); body.setPadding(style.dp(14), 0, style.dp(14), style.dp(12));
        body.setTag("processBody:" + key); addView(body);
        header.setOnClickListener(view -> { expanded = !expanded; state.set(key, expanded); renderBody(); });
    }

    private String tr(String zh, String en) { return chinese ? zh : en; }
    private TextView label(String value, int size) {
        TextView text = new TextView(getContext()); text.setText(value); text.setTextSize(size); text.setTextColor(style.muted); text.setLineSpacing(style.dp(3), 1); return text;
    }

    void update(JSONArray process, boolean live) {
        entries = process == null ? new JSONArray() : process;
        expanded = state.open(key, live);
        int tools = 0; boolean onlyThinking = entries.length() > 0;
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.optJSONObject(index); if (entry == null) continue;
            if (entry.optString("type").equals("tool")) tools++;
            if (!entry.optString("type").equals("thinking")) onlyThinking = false;
        }
        String title = onlyThinking ? live ? tr("正在思考", "Thinking") : tr("思考已完成", "Thinking completed")
            : live ? tr("执行过程 · 进行中", "Execution process · Running") : tr("执行过程", "Execution process");
        String summary = title + (tools > 0 ? " · " + tools + tr(" 次工具调用", " tool calls") : ""); caption.setText(summary);
        setVisibility(entries.length() == 0 ? GONE : VISIBLE); renderBody();
    }

    private void renderBody() {
        arrow.setImageDrawable(new LineIcon(expanded ? "down" : "right", style.muted));
        header.setContentDescription(caption.getText() + (expanded ? tr("，收起", ", collapse") : tr("，展开", ", expand")));
        body.setVisibility(expanded ? VISIBLE : GONE); body.removeAllViews();
        if (!expanded) return;
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.optJSONObject(index); if (entry == null) continue;
            String type = entry.optString("type"), title = entry.optString("title");
            if (title.isEmpty()) title = type.equals("thinking") ? tr("思考", "Reasoning") : type.equals("plan") ? tr("计划", "Plan") : tr("过程信息", "Progress");
            String status = entry.optString("status");
            if (!status.isEmpty()) title += " · " + (status.equals("completed") ? tr("已完成", "Completed") : status.equals("failed") ? tr("失败", "Failed") : status.equals("cancelled") ? tr("已停止", "Stopped") : tr("进行中", "Running"));
            TextView heading = label(title, 12); heading.setPadding(0, style.dp(10), 0, style.dp(5)); body.addView(heading);
            String input = entry.optString("input"), text = entry.optString("text");
            TextView detail = label((input.isEmpty() ? "" : input + "\n") + text, 14); detail.setTextColor(style.ink); detail.setTextIsSelectable(true);
            if (type.equals("tool")) {
                detail.setTypeface(Typeface.MONOSPACE);
                String toolKey = key + ":tool:" + index;
                boolean open = state.open(toolKey, false); detail.setVisibility(open ? VISIBLE : GONE);
                String toolTitle = title;
                LineIcon toolArrow = new LineIcon(open ? "down" : "right", style.muted); toolArrow.setBounds(0, 0, style.dp(18), style.dp(18));
                heading.setCompoundDrawablesRelative(toolArrow, null, null, null); heading.setCompoundDrawablePadding(style.dp(8));
                heading.setMinHeight(style.dp(48)); heading.setGravity(Gravity.CENTER_VERTICAL); heading.setFocusable(true);
                heading.setOnClickListener(view -> {
                    boolean next = detail.getVisibility() != VISIBLE; state.set(toolKey, next);
                    detail.setVisibility(next ? VISIBLE : GONE);
                    LineIcon nextArrow = new LineIcon(next ? "down" : "right", style.muted); nextArrow.setBounds(0, 0, style.dp(18), style.dp(18));
                    heading.setCompoundDrawablesRelative(nextArrow, null, null, null);
                });
            }
            body.addView(detail);
            if (entry.optBoolean("truncated")) body.addView(label(tr("内容过长，仅显示部分。", "Long output: partial content shown."), 11));
        }
    }
}
