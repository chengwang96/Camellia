package app.camellia.mobile;

import android.app.Activity;
import android.app.Dialog;
import android.view.View;
import android.widget.*;
import org.json.*;

/** A full-screen child page; the parent's views, scroll position and draft stay mounted. */
final class SubtaskPage extends Dialog {
    interface Action { void run(JSONObject task, String operation, JSONObject extra) throws Exception; }
    private final Activity activity;
    private final ChatStyle style;
    private final boolean chinese;
    private final long userSeq;
    private final Action action;
    private final LinearLayout page, content, approvals;
    private final TextView title, status, goal, progress, result, history;
    private final TextView shortened;
    private final EditText reply;
    private final Button send, stop;
    private JSONArray tasks = new JSONArray();
    private JSONObject current;
    private String selected, approvalSignature = "";
    private boolean showingList, controlAvailable = true;
    private Dialog approvalDialog;
    private String replyOwner;
    private final java.util.Map<String, String> drafts = new java.util.HashMap<>();
    private final boolean listOrigin;

    SubtaskPage(Activity activity, boolean chinese, long userSeq, String selected, Action action) {
        super(activity, android.R.style.Theme_DeviceDefault_NoActionBar);
        this.activity = activity; this.chinese = chinese; this.userSeq = userSeq; this.selected = selected; this.action = action; listOrigin = selected == null;
        style = new ChatStyle(activity); page = column(); page.setBackgroundColor(style.background);
        page.setFitsSystemWindows(true);
        LinearLayout header = new LinearLayout(activity); header.setPadding(style.dp(12), style.dp(12), style.dp(12), 0); header.setGravity(android.view.Gravity.CENTER_VERTICAL);
        header.addView(style.backButton(tr("返回", "Back"), this::onBackPressed), new LinearLayout.LayoutParams(style.dp(48), style.dp(48)));
        TextView heading = text(18); heading.setText(tr("子任务", "Subtasks")); header.addView(heading); page.addView(header);
        ScrollView scroll = new ScrollView(activity); content = column(); content.setPadding(style.dp(20), style.dp(12), style.dp(20), style.dp(24)); scroll.addView(content);
        page.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1)); setContentView(page);
        title = text(20); status = text(13); goal = text(16); progress = text(16); result = text(16); history = text(13); approvals = column();
        shortened = text(13); shortened.setText(tr("部分详情已缩短，可在电脑查看完整记录。", "Some details are shortened; open the computer for the full record."));
        reply = new EditText(activity); reply.setHint(tr("回复此子任务", "Reply to this subtask")); reply.setTextColor(style.ink); reply.setHintTextColor(style.muted); reply.setMinLines(2); reply.setMaxLines(6); reply.setTag("subtaskReply");
        send = new Button(activity); send.setText(tr("发送", "Send")); send.setOnClickListener(view -> perform("reply", extra("prompt", reply.getText().toString())));
        send.setTag("sendSubtask"); reply.addTextChangedListener(new android.text.TextWatcher() {
            public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            public void onTextChanged(CharSequence text, int start, int before, int count) { refreshControls(); }
            public void afterTextChanged(android.text.Editable text) {}
        }); send.setEnabled(false);
        stop = new Button(activity); stop.setText(tr("停止此子任务", "Stop this subtask")); stop.setTag("stopSubtask"); stop.setOnClickListener(view -> perform("stop", new JSONObject()));
    }
    void update(JSONArray value) {
        tasks = value; current = null;
        for (int i = 0; i < tasks.length(); i++) { JSONObject task = tasks.optJSONObject(i); if (task != null && task.optLong("userSeq") == userSeq && identity(task).equals(selected)) current = task; }
        if (selected == null || current == null) { showList(); return; }
        String owner = current.optString("engine") + ":" + current.optString("id");
        if (!owner.equals(replyOwner)) {
            if (replyOwner != null) drafts.put(replyOwner, reply.getText().toString());
            replyOwner = owner; reply.setText(drafts.getOrDefault(owner, ""));
        }
        if (showingList || content.getChildCount() == 0) {
            showingList = false; content.removeAllViews(); content.addView(title); content.addView(status);
            section(tr("目标", "Goal"), goal); section(tr("最新进展", "Latest progress"), progress); section(tr("结果", "Result"), result);
            content.addView(shortened);
            content.addView(approvals); content.addView(reply); content.addView(send); content.addView(stop);
            Button expand = new Button(activity); expand.setText(tr("执行记录", "Execution history")); history.setVisibility(View.GONE);
            expand.setOnClickListener(view -> history.setVisibility(history.getVisibility() == View.GONE ? View.VISIBLE : View.GONE)); content.addView(expand); content.addView(history);
        }
        title.setText(current.optString("title")); status.setText(state(current.optString("status"), chinese)); goal.setText(current.optString("goal")); progress.setText(current.optString("progress")); result.setText(current.optString("result"));
        shortened.setVisibility(current.optBoolean("detailsTruncated") ? View.VISIBLE : View.GONE);
        reply.setVisibility(current.optBoolean("canReply") ? View.VISIBLE : View.GONE); send.setVisibility(reply.getVisibility()); stop.setVisibility(current.optBoolean("canStop") ? View.VISIBLE : View.GONE);
        StringBuilder log = new StringBuilder(); JSONArray entries = current.optJSONArray("history");
        for (int i = 0; entries != null && i < entries.length(); i++) { JSONObject row = entries.optJSONObject(i); if (row != null) log.append(row.optString("type")).append("\n").append(row.optString("text")).append("\n\n"); } history.setText(log.toString());
        JSONArray requests = current.optJSONArray("approvals"); String signature = identity(current) + ":" + current.optString("turnId") + ":" + String.valueOf(requests) + current.optInt("pendingApprovals");
        if (!signature.equals(approvalSignature)) {
            closeApproval(); approvalSignature = signature; approvals.removeAllViews();
            for (int i = 0; requests != null && i < requests.length(); i++) {
                JSONObject request = requests.optJSONObject(i); if (request == null) continue;
                Button respond = new Button(activity); respond.setText(tr("处理：", "Respond: ") + request.optString("toolName")); respond.setTag(request.optBoolean("responseSupported", request.optBoolean("actionable")));
                respond.setOnClickListener(view -> { final JSONObject approvalOwner = current;
                    if (!controlAvailable || approvalOwner == null) return;
                    approvalDialog = RemoteApprovalDialog.show(activity, request, approvalOwner.optString("title"), (allow, input, optionId) -> {
                    JSONObject extra = new JSONObject().put("approvalId", request.getString("requestId")).put("fingerprint", request.getString("fingerprint")).put("allow", allow);
                    if (input != null) extra.put("input", input); if (optionId != null) extra.put("optionId", optionId); perform(approvalOwner, "approve", extra); return true;
                }); }); approvals.addView(respond);
            }
            if (current.optInt("pendingApprovals") > 0 && (requests == null || requests.length() == 0)) { TextView notice = text(14); notice.setText(tr("等待授权，请在电脑处理。", "Approval pending; respond on the computer.")); approvals.addView(notice); }
        }
        refreshControls();
    }
    private void showList() {
        closeApproval(); showingList = true; selected = null; content.removeAllViews();
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.optJSONObject(i); if (task == null || task.optLong("userSeq") != userSeq) continue;
            Button row = new Button(activity); row.setAllCaps(false); row.setText(task.optString("title") + " · " + state(task.optString("status"), chinese));
            row.setOnClickListener(view -> { selected = identity(task); update(tasks); }); content.addView(row);
        }
    }
    @Override public void onBackPressed() { if (listOrigin && !showingList && selected != null) { selected = null; showList(); } else dismiss(); }
    private void perform(String operation, JSONObject extra) {
        perform(current, operation, extra);
    }
    private void perform(JSONObject owner, String operation, JSONObject extra) {
        if (!controlAvailable || owner == null || current == null || !identity(owner).equals(identity(current))
                || !owner.optString("turnId").equals(current.optString("turnId"))) return;
        if (operation.equals("reply") && !current.optBoolean("canReply") || operation.equals("stop") && !current.optBoolean("canStop")) return;
        try { action.run(owner, operation, extra); } catch (Exception error) { Toast.makeText(activity, error.getMessage(), Toast.LENGTH_LONG).show(); }
    }
    void setControlAvailable(boolean available) {
        controlAvailable = available; if (!available) closeApproval(); refreshControls();
    }
    private void refreshControls() {
        send.setEnabled(controlAvailable && current != null && current.optBoolean("canReply") && !reply.getText().toString().trim().isEmpty() && reply.length() <= 32000);
        if (stop != null) stop.setEnabled(controlAvailable && current != null && current.optBoolean("canStop"));
        for (int i = 0; i < approvals.getChildCount(); i++) { View view = approvals.getChildAt(i); if (view instanceof Button) view.setEnabled(controlAvailable && Boolean.TRUE.equals(view.getTag())); }
    }
    private void closeApproval() { if (approvalDialog != null) { approvalDialog.dismiss(); approvalDialog = null; } }
    @Override public void dismiss() { closeApproval(); super.dismiss(); }
    static String identity(JSONObject task) { return task.optString("engine") + ":" + task.optString("id"); }
    private JSONObject extra(String key, String value) { JSONObject extra = new JSONObject(); try { extra.put(key, value); } catch (JSONException ignored) {} return extra; }
    private LinearLayout column() { LinearLayout view = new LinearLayout(activity); view.setOrientation(LinearLayout.VERTICAL); return view; }
    private TextView text(int size) { TextView view = new TextView(activity); view.setTextColor(style.ink); view.setTextSize(size); view.setTextIsSelectable(true); view.setPadding(0, style.dp(8), 0, style.dp(8)); return view; }
    private void section(String label, TextView value) { TextView heading = text(13); heading.setTextColor(style.muted); heading.setText(label); content.addView(heading); content.addView(value); }
    private String tr(String zh, String en) { return chinese ? zh : en; }
    static String state(String value, boolean chinese) { if (!chinese) return value; switch (value) { case "ready": return "就绪"; case "starting": return "准备中"; case "running": return "运行中"; case "waiting": return "待处理"; case "completed": return "已完成"; case "failed": return "失败"; case "stopped": return "已停止"; default: return "状态不可用"; } }
}
