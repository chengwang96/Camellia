package app.camellia.mobile;

import android.content.Context;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;

/** A timeline status, independent of context token accounting. */
@android.annotation.SuppressLint("ViewConstructor") // Created only by the chat renderer with its theme and language.
final class ContextCompactionView extends LinearLayout {
    private final ChatStyle style;
    private final boolean chinese;
    private final LoadingIndicator progress;
    private final ImageView icon;
    private final TextView label;

    ContextCompactionView(Context context, ChatStyle style, boolean chinese) {
        super(context);
        this.style = style; this.chinese = chinese;
        setGravity(Gravity.CENTER_VERTICAL);
        setPadding(0, style.dp(12), 0, style.dp(12));
        setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        progress = new LoadingIndicator(context);
        addView(progress, new LayoutParams(style.dp(20), style.dp(20)));
        icon = new ImageView(context); icon.setImageDrawable(new LineIcon("file", style.muted));
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        addView(icon, new LayoutParams(style.dp(20), style.dp(20)));
        label = new TextView(context); label.setTextSize(13);
        LayoutParams textLayout = new LayoutParams(0, -2, 1); textLayout.setMarginStart(style.dp(8));
        addView(label, textLayout);
    }

    void update(JSONObject compaction) {
        boolean running = "running".equals(compaction.optString("state"));
        progress.setVisibility(running ? VISIBLE : GONE); icon.setVisibility(running ? GONE : VISIBLE);
        label.setTextColor(running ? style.ink : style.muted);
        String value = description(compaction);
        if (!value.contentEquals(label.getText())) label.setText(value);
    }

    private String tr(String zh, String en) { return chinese ? zh : en; }

    private String description(JSONObject value) {
        String state = value.optString("state");
        if (state.equals("running")) {
            if (value.optString("stage").equals("saving")) return tr("正在保存压缩后的上下文…", "Saving compacted context…");
            if (value.optString("stage").equals("summarizing") && value.optInt("chunk") > 0) {
                String suffix = value.optBoolean("finalChunk") ? tr("（最后一块）", " (last)") : "";
                return tr("正在总结上下文：第 ", "Summarizing context: chunk ") + value.optInt("chunk") + tr(" 块", "") + suffix + "…";
            }
        }
        String label = switch (state) {
            case "completed" -> tr("上下文已压缩", "Context compacted");
            case "failed" -> tr("上下文压缩失败，原对话已保留。", "Context compaction failed. The original conversation is retained.");
            case "cancelled" -> tr("上下文压缩已取消，原对话已保留。", "Context compaction canceled. The original conversation is retained.");
            default -> tr("正在压缩上下文…", "Compacting context…");
        };
        if (state.equals("completed") && value.has("durationMs") && value.optLong("durationMs", -1) >= 0) {
            long seconds = Math.round(value.optLong("durationMs") / 1000.0);
            label += " · " + (seconds < 60 ? seconds + tr(" 秒", seconds == 1 ? " second" : " seconds")
                : seconds / 60 + tr(" 分钟", seconds / 60 == 1 ? " minute" : " minutes")
                    + (seconds % 60 == 0 ? "" : " " + seconds % 60 + tr(" 秒", seconds % 60 == 1 ? " second" : " seconds")));
        }
        return label;
    }

    static JSONObject fromMessage(JSONObject row) {
        if (!row.optString("role").equals("notice")) return null;
        JSONObject value = row.optJSONObject("compaction");
        if (value != null) return withState(value, value.optString("state", "completed"));
        // Older desktop versions store successful compaction as a plain notice.
        return switch (row.optString("text")) {
            case "Context compacted", "Context compacted automatically", "Context compacted: summary saved" -> withState(null, "completed");
            default -> null;
        };
    }

    static JSONObject fromSnapshot(JSONObject snapshot, JSONObject previous, long boundary) {
        if (snapshot.has("compaction")) {
            JSONObject value = snapshot.optJSONObject("compaction");
            return value == null ? null : withState(value, value.optString("state"));
        }
        JSONObject context = snapshot.optJSONObject("context");
        if (context == null) return null;
        String state = context.optBoolean("compacting") ? "running" : context.optString("compactionState");
        JSONObject value = withState(null, state);
        if (value != null) try {
            value.put("afterSeq", previous != null && previous.optString("state").equals("running")
                ? previous.optLong("afterSeq", boundary) : boundary);
        } catch (org.json.JSONException ignored) { }
        return value;
    }

    private static JSONObject withState(JSONObject value, String state) {
        if (!java.util.List.of("running", "completed", "failed", "cancelled").contains(state)) return null;
        try { return (value == null ? new JSONObject() : new JSONObject(value.toString())).put("state", state); }
        catch (org.json.JSONException ignored) { return null; }
    }
}
