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
    private final TextView duration;
    private JSONObject current;
    private long elapsedBase = -1, observedAt;
    private final Runnable clock = new Runnable() {
        @Override public void run() {
            if (current == null || !current.optString("state").equals("running") || !isAttachedToWindow()) return;
            renderDescription();
            postDelayed(this, 1000);
        }
    };

    ContextCompactionView(Context context, ChatStyle style, boolean chinese) {
        super(context);
        this.style = style; this.chinese = chinese;
        setGravity(Gravity.CENTER_VERTICAL);
        setPadding(0, style.dp(12), 0, style.dp(12));
        setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_NONE);
        progress = new LoadingIndicator(context);
        addView(progress, new LayoutParams(style.dp(20), style.dp(20)));
        icon = new ImageView(context); icon.setImageDrawable(new LineIcon("file", style.muted));
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        addView(icon, new LayoutParams(style.dp(20), style.dp(20)));
        LinearLayout text = new LinearLayout(context); text.setOrientation(VERTICAL);
        LayoutParams textLayout = new LayoutParams(0, -2, 1); textLayout.setMarginStart(style.dp(8));
        addView(text, textLayout);
        label = new TextView(context); label.setTextSize(13); label.setTag("compactionStatus");
        label.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        text.addView(label, new LayoutParams(-1, -2));
        duration = new TextView(context); duration.setTextSize(12); duration.setTextColor(style.muted);
        duration.setTag("compactionDuration");
        // Announce meaningful status changes; the clock remains readable on focus.
        duration.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_NONE);
        text.addView(duration, new LayoutParams(-1, -2));
    }

    void update(JSONObject compaction) {
        boolean running = "running".equals(compaction.optString("state"));
        boolean wasRunning = current != null && "running".equals(current.optString("state"));
        long now = android.os.SystemClock.elapsedRealtime();
        if (compaction.optLong("elapsedMs", -1) >= 0) {
            elapsedBase = compaction.optLong("elapsedMs"); observedAt = now;
        } else if (running && !wasRunning) {
            elapsedBase = 0; observedAt = now;
        } else if (!running && wasRunning && elapsedBase >= 0) {
            elapsedBase += now - observedAt; observedAt = now;
        }
        current = compaction;
        progress.setVisibility(running ? VISIBLE : GONE); icon.setVisibility(running ? GONE : VISIBLE);
        label.setTextColor(running ? style.ink : style.muted);
        renderDescription();
        removeCallbacks(clock);
        if (running && isAttachedToWindow()) postDelayed(clock, 1000);
    }

    private void renderDescription() {
        String value = description(current);
        if (!value.contentEquals(label.getText())) label.setText(value);
        String elapsed = elapsedDescription(current);
        if (!elapsed.contentEquals(duration.getText())) duration.setText(elapsed);
        duration.setVisibility(elapsed.isEmpty() ? GONE : VISIBLE);
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (current != null && current.optString("state").equals("running")) { renderDescription(); removeCallbacks(clock); postDelayed(clock, 1000); }
    }

    @Override protected void onDetachedFromWindow() { removeCallbacks(clock); super.onDetachedFromWindow(); }

    private String tr(String zh, String en) { return chinese ? zh : en; }

    private String description(JSONObject value) {
        String state = value.optString("state");
        String status = null;
        if (state.equals("running")) {
            if (value.optString("stage").equals("saving")) status = tr("正在保存压缩后的上下文…", "Saving compacted context…");
            if (value.optString("stage").equals("summarizing")) {
                long completed = value.optLong("completedChunks", -1), total = value.optLong("totalChunks", -1);
                if (completed >= 0 && total > 0 && completed <= total) {
                    boolean merging = value.optString("summaryPhase").equals("reduce");
                    status = (merging ? tr("正在合并摘要：已完成 ", "Merging summaries: ") : tr("正在总结上下文：已完成 ", "Summarizing context: "))
                        + completed + tr("／", "/") + total + tr(" 块…", " chunks completed…");
                } else if (value.optInt("chunk") > 0) {
                    String suffix = value.optBoolean("finalChunk") ? tr("（最后一块）", " (last)") : "";
                    status = tr("正在总结上下文：第 ", "Summarizing context: chunk ") + value.optInt("chunk") + tr(" 块", "") + suffix + "…";
                }
            }
        }
        return status != null ? status : switch (state) {
            case "completed" -> tr("上下文已压缩", "Context compacted");
            case "failed" -> tr("上下文压缩失败，原对话已保留。", "Context compaction failed. The original conversation is retained.");
            case "cancelled" -> tr("上下文压缩已取消，原对话已保留。", "Context compaction canceled. The original conversation is retained.");
            default -> tr("正在压缩上下文…", "Compacting context…");
        };
    }

    private String elapsedDescription(JSONObject value) {
        String state = value.optString("state");
        long elapsed = state.equals("running") ? elapsedBase + android.os.SystemClock.elapsedRealtime() - observedAt
            : value.optLong("durationMs", value.optLong("elapsedMs", elapsedBase));
        if (elapsed >= 0) {
            long seconds = Math.round(elapsed / 1000.0);
            return (state.equals("running") ? tr("已用时 ", "Elapsed ") : "")
                + (seconds < 60 ? seconds + tr(" 秒", seconds == 1 ? " second" : " seconds")
                : seconds / 60 + tr(" 分钟", seconds / 60 == 1 ? " minute" : " minutes")
                    + (seconds % 60 == 0 ? "" : " " + seconds % 60 + tr(" 秒", seconds % 60 == 1 ? " second" : " seconds")));
        }
        return "";
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
