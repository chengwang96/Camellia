package app.camellia.mobile;

import android.app.Activity;
import android.app.Dialog;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.*;
import org.json.*;

/** A full-screen child page; the parent's views, scroll position and draft stay mounted. */
final class SubtaskPage extends Dialog {
    interface Action { void run(JSONObject task, String operation, JSONObject extra) throws Exception; }
    private final Activity activity;
    private final ChatStyle style;
    private final Palette palette;
    private final boolean chinese;
    private final long userSeq;
    private final Action action;
    private final LinearLayout page, content, approvals, controls, replyBar;
    private final LinearLayout overview, goalSection, progressSection, resultSection, historySection;
    private final ScrollView scroll;
    private final TextView heading, summary, title, status, engine, goal, progress, result, history, shortened;
    private final EditText reply;
    private final Button send, stop, expand;
    private JSONArray tasks = new JSONArray();
    private JSONObject current;
    private String selected, approvalSignature = "", listSignature;
    private boolean showingList, controlAvailable = true;
    private Dialog approvalDialog;
    private String replyOwner;
    private final java.util.Map<String, String> drafts = new java.util.HashMap<>();
    private final boolean listOrigin;

    SubtaskPage(Activity activity, boolean chinese, long userSeq, String selected, Action action) {
        super(activity, android.R.style.Theme_DeviceDefault_NoActionBar);
        this.activity = activity; this.chinese = chinese; this.userSeq = userSeq; this.selected = selected; this.action = action;
        listOrigin = selected == null; style = new ChatStyle(activity); palette = Palette.of(activity);
        page = column(); page.setTag("subtaskPage"); page.setBackgroundColor(palette.grouped);
        page.setFocusableInTouchMode(true); page.requestFocus();
        page.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        LinearLayout header = new LinearLayout(activity); header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(20), dp(12), dp(20), dp(16)); header.setClipChildren(false); header.setClipToPadding(false);
        header.addView(style.backButton(tr("返回", "Back"), this::onBackPressed), new LinearLayout.LayoutParams(dp(48), dp(48)));
        LinearLayout titles = column(); titles.setPadding(dp(12), 0, 0, 0);
        heading = text(Palette.TEXT_TITLE); medium(heading); heading.setText(tr("子任务", "Subtasks")); markHeading(heading);
        summary = text(Palette.TEXT_SMALL); summary.setTag("subtaskSummary"); summary.setTextColor(style.muted);
        summary.setPadding(0, dp(3), 0, 0);
        titles.addView(heading); titles.addView(summary); header.addView(titles, new LinearLayout.LayoutParams(0, -2, 1)); page.addView(header);
        scroll = new ScrollView(activity); scroll.setTag("subtaskScroll"); scroll.setFillViewport(true); scroll.setClipToPadding(false);
        content = column(); content.setPadding(dp(20), dp(4), dp(20), dp(20)); scroll.addView(content);
        page.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));

        title = text(Palette.TEXT_DISPLAY); medium(title); title.setTextIsSelectable(true); title.setLineSpacing(dp(3), 1); title.setPadding(0, dp(14), 0, 0);
        status = text(Palette.TEXT_SMALL); engine = text(Palette.TEXT_NOTE); engine.setTextColor(style.muted);
        overview = column(); overview.setPadding(dp(18), dp(18), dp(18), dp(18)); overview.setBackground(cardBackground());
        LinearLayout metadata = new LinearLayout(activity); metadata.setGravity(Gravity.CENTER_VERTICAL);
        metadata.addView(icon("branch", style.accent), new LinearLayout.LayoutParams(dp(20), dp(20)));
        engine.setPadding(dp(8), 0, dp(8), 0); engine.setSingleLine(true); engine.setEllipsize(TextUtils.TruncateAt.END);
        metadata.addView(engine, new LinearLayout.LayoutParams(0, -2, 1)); metadata.addView(status); overview.addView(metadata); overview.addView(title);
        goal = body(); progress = body(); result = body(); history = body(); history.setTextSize(Palette.TEXT_NOTE);
        goalSection = section(tr("任务目标", "Goal"), goal);
        progressSection = section(tr("最新进展", "Latest progress"), progress);
        resultSection = section(tr("执行结果", "Result"), result);
        approvals = column(); approvals.setPadding(dp(16), dp(8), dp(16), dp(8)); approvals.setBackground(cardBackground());
        shortened = text(Palette.TEXT_NOTE); shortened.setTextColor(style.muted); shortened.setPadding(dp(4), dp(8), dp(4), dp(16));
        shortened.setText(tr("部分详情已缩短，可在电脑查看完整记录。", "Some details are shortened; open the computer for the full record."));
        historySection = column(); historySection.setBackground(cardBackground());
        expand = actionButton(tr("执行记录", "Execution history"), style.muted, palette.card);
        expand.setGravity(Gravity.START | Gravity.CENTER_VERTICAL); expand.setCompoundDrawablePadding(dp(8));
        history.setPadding(dp(16), 0, dp(16), dp(16)); history.setVisibility(View.GONE);
        expand.setOnClickListener(view -> { history.setVisibility(history.getVisibility() == View.GONE ? View.VISIBLE : View.GONE); updateDisclosure(); });
        historySection.addView(expand, new LinearLayout.LayoutParams(-1, -2)); historySection.addView(history); updateDisclosure();

        controls = column(); controls.setTag("subtaskControls"); controls.setPadding(dp(20), dp(8), dp(20), dp(12)); controls.setVisibility(View.GONE);
        replyBar = new LinearLayout(activity); replyBar.setGravity(Gravity.BOTTOM); replyBar.setPadding(dp(4), dp(4), dp(4), dp(4));
        GradientDrawable replyFace = shape(palette.card, Palette.RADIUS_CAPSULE); replyFace.setStroke(dp(1), palette.homeCardEdge()); replyBar.setBackground(replyFace);
        reply = new EditText(activity); reply.setHint(tr("回复此子任务", "Reply to this subtask")); reply.setTextColor(style.ink); reply.setTextSize(Palette.TEXT_INPUT);
        reply.setHintTextColor(style.muted); reply.setMinLines(1); reply.setMaxLines(5); reply.setMinHeight(dp(48)); reply.setTag("subtaskReply");
        reply.setGravity(Gravity.TOP | Gravity.START); reply.setPadding(dp(12), dp(13), dp(8), dp(13)); reply.setBackgroundColor(Color.TRANSPARENT);
        reply.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        reply.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        reply.setContentDescription(tr("回复此子任务", "Reply to this subtask"));
        send = actionButton(tr("发送", "Send"), Color.WHITE, style.accent); send.setTag("sendSubtask");
        send.setOnClickListener(view -> perform("reply", extra("prompt", reply.getText().toString()))); send.setEnabled(false);
        reply.addTextChangedListener(new android.text.TextWatcher() {
            public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            public void onTextChanged(CharSequence text, int start, int before, int count) { refreshControls(); }
            public void afterTextChanged(android.text.Editable text) {}
        });
        replyBar.addView(reply, new LinearLayout.LayoutParams(0, -2, 1)); replyBar.addView(send, new LinearLayout.LayoutParams(-2, -2)); controls.addView(replyBar);
        stop = actionButton(tr("停止此子任务", "Stop this subtask"), palette.error, palette.grouped); stop.setTag("stopSubtask");
        stop.setOnClickListener(view -> perform("stop", new JSONObject())); controls.addView(stop, new LinearLayout.LayoutParams(-1, -2)); page.addView(controls);
        setContentView(page);
        if (getWindow() != null) {
            getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(palette.grouped));
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            getWindow().setStatusBarColor(palette.grouped); getWindow().setNavigationBarColor(palette.grouped);
            getWindow().getDecorView().setSystemUiVisibility(palette.dark ? 0 : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
            getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE | WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        }
    }

    @Override protected void onStart() {
        super.onStart(); getWindow().setLayout(-1, -1); page.requestApplyInsets();
    }

    void update(JSONArray value) {
        tasks = value; current = null;
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.optJSONObject(i);
            if (task != null && task.optLong("userSeq") == userSeq && identity(task).equals(selected)) current = task;
        }
        if (selected == null || current == null) { showList(); return; }
        String owner = identity(current);
        boolean changedTask = !owner.equals(replyOwner);
        if (changedTask) {
            if (replyOwner != null) drafts.put(replyOwner, reply.getText().toString());
            replyOwner = owner; reply.setText(drafts.getOrDefault(owner, "")); history.setVisibility(View.GONE); updateDisclosure();
        }
        if (showingList || content.getChildCount() == 0) {
            showingList = false; content.removeAllViews();
            addBlock(overview);
            addBlock(goalSection); addBlock(progressSection); addBlock(resultSection); content.addView(shortened);
            addBlock(approvals); addBlock(historySection); scroll.scrollTo(0, 0);
        }
        heading.setText(tr("任务详情", "Task details"));
        summary.setText(String.format(java.util.Locale.ROOT, "%s · %s", tr("子任务", "Subtasks"), engineName(current)));
        title.setText(taskTitle(current)); engine.setText(engineName(current)); status(status, current);
        updateSection(goalSection, goal, current.optString("goal")); updateSection(progressSection, progress, current.optString("progress"));
        updateSection(resultSection, result, current.optString("result")); shortened.setVisibility(current.optBoolean("detailsTruncated") ? View.VISIBLE : View.GONE);
        replyBar.setVisibility(current.optBoolean("canReply") ? View.VISIBLE : View.GONE); stop.setVisibility(current.optBoolean("canStop") ? View.VISIBLE : View.GONE);
        controls.setVisibility(replyBar.getVisibility() == View.VISIBLE || stop.getVisibility() == View.VISIBLE ? View.VISIBLE : View.GONE);
        StringBuilder log = new StringBuilder(); JSONArray entries = current.optJSONArray("history");
        for (int i = 0; entries != null && i < entries.length(); i++) {
            JSONObject row = entries.optJSONObject(i); if (row != null) log.append(row.optString("type")).append("\n").append(row.optString("text")).append("\n\n");
        }
        history.setText(log.toString().trim()); historySection.setVisibility(log.length() > 0 ? View.VISIBLE : View.GONE);
        JSONArray requests = current.optJSONArray("approvals"); String signature = identity(current) + ":" + current.optString("turnId") + ":" + String.valueOf(requests) + current.optInt("pendingApprovals");
        if (!signature.equals(approvalSignature)) {
            closeApproval(); approvalSignature = signature; approvals.removeAllViews();
            TextView label = text(Palette.TEXT_NOTE); label.setText(tr("需要你处理", "Needs your attention")); label.setTextColor(palette.warning); medium(label);
            label.setPadding(0, dp(8), 0, dp(4)); approvals.addView(label);
            int requestCount = 0;
            for (int i = 0; requests != null && i < requests.length(); i++) {
                JSONObject request = requests.optJSONObject(i); if (request == null) continue; requestCount++;
                Button respond = actionButton(tr("处理：", "Respond: ") + request.optString("toolName"), style.accent, palette.card);
                respond.setGravity(Gravity.START | Gravity.CENTER_VERTICAL); respond.setTag(request.optBoolean("responseSupported", request.optBoolean("actionable")));
                respond.setOnClickListener(view -> { final JSONObject approvalOwner = current;
                    if (!controlAvailable || approvalOwner == null) return;
                    approvalDialog = RemoteApprovalDialog.show(activity, request, approvalOwner.optString("title"), (allow, input, optionId) -> {
                        JSONObject extra = new JSONObject().put("approvalId", request.getString("requestId")).put("fingerprint", request.getString("fingerprint")).put("allow", allow);
                        if (input != null) extra.put("input", input); if (optionId != null) extra.put("optionId", optionId); perform(approvalOwner, "approve", extra); return true;
                    });
                }); approvals.addView(respond, new LinearLayout.LayoutParams(-1, -2));
            }
            boolean pending = current.optInt("pendingApprovals") > 0;
            if (pending && requestCount == 0) {
                TextView notice = text(Palette.TEXT_BODY); notice.setText(tr("等待授权，请在电脑处理。", "Approval pending; respond on the computer."));
                notice.setPadding(0, dp(8), 0, dp(8)); approvals.addView(notice);
            }
            approvals.setVisibility(pending || requestCount > 0 ? View.VISIBLE : View.GONE);
        }
        refreshControls();
    }

    private void showList() {
        closeApproval(); current = null; selected = null; controls.setVisibility(View.GONE);
        refreshControls();
        heading.setText(tr("子任务", "Subtasks"));
        JSONArray visible = new JSONArray(); int active = 0, attention = 0, completed = 0;
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.optJSONObject(i); if (task == null || task.optLong("userSeq") != userSeq) continue; visible.put(task);
            String state = task.optString("status");
            if (state.equals("running") || state.equals("starting")) active++;
            if (state.equals("waiting") || task.optInt("pendingApprovals") > 0) attention++;
            if (state.equals("completed")) completed++;
        }
        String counts = chinese ? visible.length() + " 个任务" : visible.length() + (visible.length() == 1 ? " task" : " tasks");
        if (active > 0) counts += " · " + active + tr(" 个进行中", " active");
        if (attention > 0) counts += " · " + attention + tr(" 个待处理", attention == 1 ? " needs attention" : " need attention");
        else if (active == 0 && completed > 0) counts += " · " + completed + tr(" 个已完成", " completed");
        summary.setText(counts);
        String signature = visible.toString();
        if (showingList && signature.equals(listSignature)) return;
        boolean wasList = showingList; showingList = true; listSignature = signature; content.removeAllViews();
        for (int i = 0; i < visible.length(); i++) addBlock(taskCard(visible.optJSONObject(i)));
        if (visible.length() == 0) {
            LinearLayout empty = column(); empty.setTag("subtaskEmpty"); empty.setGravity(Gravity.CENTER); empty.setPadding(dp(24), dp(64), dp(24), dp(40));
            empty.addView(icon("branch", style.muted), new LinearLayout.LayoutParams(dp(36), dp(36)));
            TextView label = text(Palette.TEXT_ROW_STRONG); label.setText(tr("暂无子任务", "No subtasks")); medium(label); label.setPadding(0, dp(20), 0, dp(8)); empty.addView(label);
            TextView note = text(Palette.TEXT_BODY); note.setTextColor(style.muted); note.setGravity(Gravity.CENTER);
            note.setText(tr("此轮的子任务会显示在这里", "Subtasks for this turn will appear here")); empty.addView(note); content.addView(empty);
        }
        if (!wasList) scroll.scrollTo(0, 0);
    }

    private View taskCard(JSONObject task) {
        LinearLayout card = column(); card.setPadding(dp(16), dp(16), dp(16), dp(16)); card.setTag("subtaskCard:" + identity(task));
        card.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_HOME_CARD), cardBackground(), shape(Color.WHITE, Palette.RADIUS_HOME_CARD)));
        LinearLayout metadata = new LinearLayout(activity); metadata.setGravity(Gravity.CENTER_VERTICAL);
        ImageView branch = icon("branch", style.accent); branch.setPadding(dp(8), dp(8), dp(8), dp(8)); branch.setBackground(shape(tint(style.accent), Palette.RADIUS_CARD));
        metadata.addView(branch, new LinearLayout.LayoutParams(dp(36), dp(36)));
        TextView provider = text(Palette.TEXT_SMALL); provider.setText(engineName(task)); provider.setTextColor(style.muted); medium(provider);
        provider.setPadding(dp(10), 0, dp(8), 0); provider.setSingleLine(true); provider.setEllipsize(TextUtils.TruncateAt.END);
        metadata.addView(provider, new LinearLayout.LayoutParams(0, -2, 1));
        TextView badge = text(Palette.TEXT_SMALL); status(badge, task); metadata.addView(badge); card.addView(metadata);
        LinearLayout nameRow = new LinearLayout(activity); nameRow.setGravity(Gravity.CENTER_VERTICAL); nameRow.setPadding(0, dp(14), 0, 0);
        TextView name = text(Palette.TEXT_ROW_STRONG); name.setTag("subtaskCardTitle"); name.setText(taskTitle(task)); medium(name);
        name.setMaxLines(3); name.setEllipsize(TextUtils.TruncateAt.END); name.setLineSpacing(dp(3), 1);
        nameRow.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
        ImageView chevron = icon("right", style.muted); LinearLayout.LayoutParams arrowParams = new LinearLayout.LayoutParams(dp(18), dp(18)); arrowParams.leftMargin = dp(12);
        nameRow.addView(chevron, arrowParams); card.addView(nameRow);
        String preview = preview(task);
        if (!preview.isEmpty()) {
            TextView note = text(Palette.TEXT_NOTE); note.setText(preview); note.setTextColor(style.muted); note.setMaxLines(2);
            note.setEllipsize(TextUtils.TruncateAt.END); note.setLineSpacing(dp(3), 1); note.setPadding(0, dp(8), 0, 0); card.addView(note);
        }
        card.setFocusable(true); card.setContentDescription(taskTitle(task) + " · " + engineName(task) + " · " + taskState(task) + (preview.isEmpty() ? "" : " · " + preview));
        card.setOnClickListener(view -> { selected = identity(task); update(tasks); });
        card.setAccessibilityDelegate(new View.AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View host, android.view.accessibility.AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info); info.setClassName(Button.class.getName());
            }
        });
        return card;
    }

    @Override public void onBackPressed() {
        if (listOrigin && !showingList && selected != null) {
            reply.clearFocus(); android.view.inputmethod.InputMethodManager keyboard = (android.view.inputmethod.InputMethodManager) activity.getSystemService(Activity.INPUT_METHOD_SERVICE);
            if (keyboard != null) keyboard.hideSoftInputFromWindow(reply.getWindowToken(), 0); showList();
        } else dismiss();
    }
    private void perform(String operation, JSONObject extra) { perform(current, operation, extra); }
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
        send.setAlpha(send.isEnabled() ? 1f : .45f);
        if (stop != null) { stop.setEnabled(controlAvailable && current != null && current.optBoolean("canStop")); stop.setAlpha(stop.isEnabled() ? 1f : .45f); }
        for (int i = 0; i < approvals.getChildCount(); i++) {
            View view = approvals.getChildAt(i);
            if (view instanceof Button) { view.setEnabled(controlAvailable && Boolean.TRUE.equals(view.getTag())); view.setAlpha(view.isEnabled() ? 1f : .45f); }
        }
    }
    private void closeApproval() { if (approvalDialog != null) { approvalDialog.dismiss(); approvalDialog = null; } }
    @Override public void dismiss() { closeApproval(); super.dismiss(); }
    static String identity(JSONObject task) { return task.optString("engine") + ":" + task.optString("id"); }
    private JSONObject extra(String key, String value) { JSONObject extra = new JSONObject(); try { extra.put(key, value); } catch (JSONException ignored) {} return extra; }
    private int dp(int value) { return style.dp(value); }
    private LinearLayout column() { LinearLayout view = new LinearLayout(activity); view.setOrientation(LinearLayout.VERTICAL); return view; }
    private TextView text(int size) { TextView view = new TextView(activity); view.setTextColor(style.ink); view.setTextSize(size); view.setIncludeFontPadding(false); return view; }
    private TextView body() { TextView view = text(Palette.TEXT_INPUT); view.setTextIsSelectable(true); view.setLineSpacing(dp(5), 1); return view; }
    private void medium(TextView view) { view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); }
    private void markHeading(TextView view) { if (android.os.Build.VERSION.SDK_INT >= 28) view.setAccessibilityHeading(true); }
    private ImageView icon(String kind, int color) { ImageView view = new ImageView(activity); view.setImageDrawable(new LineIcon(kind, color)); view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); return view; }
    private GradientDrawable shape(int color, int radius) { GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(radius)); return shape; }
    private GradientDrawable cardBackground() { GradientDrawable face = shape(palette.card, Palette.RADIUS_HOME_CARD); face.setStroke(dp(1), palette.homeCardEdge()); return face; }
    private int tint(int color) { return Color.argb(palette.dark ? 36 : 20, Color.red(color), Color.green(color), Color.blue(color)); }
    private void addBlock(View view) { LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.bottomMargin = dp(12); content.addView(view, params); }
    private LinearLayout section(String label, TextView value) {
        LinearLayout block = column(); block.setPadding(dp(18), dp(16), dp(18), dp(18)); block.setBackground(cardBackground());
        TextView caption = text(Palette.TEXT_NOTE); caption.setTextColor(style.muted); caption.setText(label); medium(caption); markHeading(caption);
        caption.setPadding(0, 0, 0, dp(10)); block.addView(caption); block.addView(value); return block;
    }
    private void updateSection(LinearLayout section, TextView view, String value) { view.setText(value); section.setVisibility(value.trim().isEmpty() ? View.GONE : View.VISIBLE); }
    private Button actionButton(String label, int foreground, int background) {
        Button button = new Button(activity); button.setText(label); button.setAllCaps(false); button.setTextSize(Palette.TEXT_INPUT); medium(button);
        button.setTextColor(foreground); button.setMinHeight(dp(48)); button.setMinimumHeight(dp(48)); button.setMinWidth(dp(72)); button.setMinimumWidth(dp(72));
        button.setPadding(dp(16), dp(12), dp(16), dp(12)); button.setStateListAnimator(null); button.setElevation(0);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(Palette.RIPPLE_ON_CARD), shape(background, Palette.RADIUS_HOME_CARD), shape(Color.WHITE, Palette.RADIUS_HOME_CARD)));
        return button;
    }
    private void updateDisclosure() {
        LineIcon arrow = new LineIcon(history.getVisibility() == View.VISIBLE ? "down" : "right", style.muted); arrow.setBounds(0, 0, dp(16), dp(16));
        expand.setCompoundDrawablesRelative(null, null, arrow, null);
        expand.setContentDescription(tr("执行记录", "Execution history") + (history.getVisibility() == View.VISIBLE ? tr("，已展开", ", expanded") : tr("，已收起", ", collapsed")));
    }
    private String engineName(JSONObject task) { String engine = task.optString("engine"); switch (engine) { case "codex": return "Codex"; case "claude": return "Claude"; case "kimi": return "Kimi"; case "dsh": return "DSH"; default: return engine.isEmpty() ? "Agent" : engine; } }
    private String taskTitle(JSONObject task) { String title = task.optString("title").trim(); return title.isEmpty() ? tr("未命名子任务", "Untitled subtask") : title; }
    private String preview(JSONObject task) {
        String value = task.optString(task.optString("status").equals("completed") ? "result" : "progress").trim();
        if (value.isEmpty()) value = task.optString("progress").trim();
        if (value.isEmpty()) value = task.optString("goal").trim(); return value;
    }
    private String taskState(JSONObject task) { return task.optInt("pendingApprovals") > 0 ? tr("待处理", "Needs attention") : state(task.optString("status"), chinese); }
    private void status(TextView badge, JSONObject task) {
        String value = task.optString("status"); int color = style.muted;
        if (value.equals("running") || value.equals("starting")) color = style.accent;
        if (value.equals("completed")) color = palette.success;
        if (value.equals("failed")) color = palette.error;
        if (value.equals("waiting") || task.optInt("pendingApprovals") > 0) color = palette.warning;
        badge.setText(taskState(task)); badge.setTextColor(color); badge.setBackground(shape(tint(color), Palette.RADIUS_CARD)); badge.setPadding(dp(10), dp(6), dp(10), dp(6));
        medium(badge);
    }
    private String tr(String zh, String en) { return chinese ? zh : en; }
    static String state(String value, boolean chinese) {
        switch (value) {
            case "ready": return chinese ? "就绪" : "Ready";
            case "starting": return chinese ? "准备中" : "Starting";
            case "running": return chinese ? "运行中" : "Running";
            case "waiting": return chinese ? "待处理" : "Needs attention";
            case "completed": return chinese ? "已完成" : "Completed";
            case "failed": return chinese ? "失败" : "Failed";
            case "stopped": return chinese ? "已停止" : "Stopped";
            default: return chinese ? "状态不可用" : "Status unavailable";
        }
    }
}
