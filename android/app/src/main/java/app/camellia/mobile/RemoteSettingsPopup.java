package app.camellia.mobile;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ScrollView;
import org.json.JSONArray;
import org.json.JSONObject;

final class RemoteSettingsPopup {
    interface Listener { void onSelect(String key, String value); }
    private final Context context;
    private final boolean chinese;
    private final int background, ink, muted, accent;
    private final JSONObject settings;
    private final Listener listener;
    private final PopupWindow popup = new PopupWindow();
    private final PopupSurface surface;
    private final ScrollView scroll;
    private final LinearLayout body;
    private View anchor;
    private int left, bottom, width, heightLimit;

    RemoteSettingsPopup(Context context, boolean chinese, int background, int ink, int muted, int accent,
            JSONObject settings, Listener listener) {
        this.context = context; this.chinese = chinese; this.background = background; this.ink = ink;
        this.muted = muted; this.accent = accent; this.settings = settings; this.listener = listener;
        body = new LinearLayout(context); body.setOrientation(LinearLayout.VERTICAL); body.setPadding(dp(12), dp(14), dp(12), dp(10));
        surface = new PopupSurface(context, background); surface.setTag("remoteSettingsPanel");
        scroll = new ScrollView(context); scroll.setFillViewport(false); scroll.setVerticalScrollBarEnabled(false); scroll.setClipToPadding(false); scroll.addView(body);
        surface.addView(scroll, new android.widget.FrameLayout.LayoutParams(-1, -1));
        popup.setContentView(surface); popup.setBackgroundDrawable(round(background, 26)); popup.setElevation(dp(8));
        popup.setFocusable(true); popup.setOutsideTouchable(true); popup.setInputMethodMode(PopupWindow.INPUT_METHOD_NOT_NEEDED);
    }

    private int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
    private String tr(String zh, String en) { return chinese ? zh : en; }
    private GradientDrawable round(int color, int radius) {
        GradientDrawable drawable = new GradientDrawable(); drawable.setColor(color); drawable.setCornerRadius(dp(radius)); return drawable;
    }
    private void row(String title, String description, boolean selected, String tag, Runnable action) {
        String icon = tag.equals("remoteThinkingBack") ? "down" : tag.equals("remoteThinkingSettings") ? "right" : null;
        body.addView(new ChatChoiceRow(context, chinese, ink, muted, accent, title, description, icon, selected, tag, action));
    }
    private void choose(String key, String value) { dismiss(); listener.onSelect(key, value); }
    private void divider() {
        View line = new View(context); line.setBackgroundColor((muted & 0xffffff) | 0x24000000);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(1)); params.setMargins(dp(14), dp(8), dp(14), dp(8)); body.addView(line, params);
    }
    private void models() {
        body.removeAllViews();
        if (settings.optBoolean("appliesNextTurn")) heading(tr("模型与思考等级更改从下一轮生效", "Changes apply to the next message"));
        JSONObject quick = settings.optJSONObject("quickSwitch");
        if (quick != null && quick.optBoolean("available")) row(tr("切换默认模型", "Quick-switch default"), quick.optString("model"), false,
            "remoteQuickSwitch", () -> choose("quickSwitch", "true"));
        JSONArray models = settings.optJSONArray("models");
        if (models == null || models.length() == 0) row(tr("暂无可用模型", "No models available"), tr("请在电脑端配置模型或登录账号", "Configure models or sign in on your computer"), false, "remoteModelsEmpty", () -> {});
        else {
            boolean grouped = hasConnection(models, "api") && hasConnection(models, "subscription");
            boolean accountHeading = false, apiHeading = false;
            for (int index = 0; index < models.length(); index++) {
                JSONObject model = models.optJSONObject(index); if (model == null) continue;
                if (grouped) {
                    boolean account = model.optString("connection", "api").equals("subscription");
                    if (account && !accountHeading) { heading(tr("账号模型", "Account models")); accountHeading = true; }
                    if (!account && !apiHeading) { heading(tr("共享 API 路由", "Shared API routes")); apiHeading = true; }
                }
                String id = model.optString("id"), name = model.optString("name", id);
                String connection = model.optString("connection", settings.optString("connection"));
                boolean sameConnection = connection.equals(settings.optString("connection"));
                String description = name.equals(id) ? "" : id;
                if (settings.optBoolean("appliesNextTurn") && !sameConnection) description += tr(" · 停止回复后可切换连接", " · Stop the reply to change connection");
                row(name, description, id.equals(settings.optString("model")) && sameConnection, "remoteModelOption:" + id, () -> {
                    if (settings.optBoolean("appliesNextTurn") && !sameConnection) return;
                    if (!settings.has("modelEditable")) { choose("model", id); return; }
                    try { choose("modelChoice", new JSONObject().put("model", id).put("connection", connection).toString()); }
                    catch (org.json.JSONException error) { throw new IllegalArgumentException(error); }
                });
            }
        }
        divider();
        if (settings.optBoolean("supportsFast")) row("Fast", tr("消耗更多订阅用量；从下一轮生效", "Uses more subscription allowance; applies next turn"),
            settings.optBoolean("fastMode"), "remoteFastMode", () -> choose("fastMode", String.valueOf(!settings.optBoolean("fastMode"))));
        row(tr("思考等级", "Thinking level"), LocalChatThinking.display(settings.optString("thinking"), chinese), false, "remoteThinkingSettings", this::thinking);
        position();
    }
    private boolean hasConnection(JSONArray models, String connection) {
        for (int index = 0; index < models.length(); index++) {
            JSONObject model = models.optJSONObject(index);
            if (model != null && model.optString("connection", "api").equals(connection)) return true;
        }
        return false;
    }
    private void heading(String title) {
        android.widget.TextView caption = new android.widget.TextView(context);
        caption.setText(title); caption.setTextSize(11); caption.setTextColor(muted);
        caption.setPadding(dp(16), dp(10), dp(16), dp(4));
        body.addView(caption);
    }
    private void thinking() {
        body.removeAllViews();
        row(tr("返回模型", "Back to models"), "", false, "remoteThinkingBack", this::models); divider();
        row(tr("默认", "Default"), tr("遵循引擎默认设置", "Use engine defaults"), settings.optString("thinking").isEmpty(), "remoteThinkingOption:", () -> choose("thinking", ""));
        JSONArray models = settings.optJSONArray("models");
        if (models != null) for (int index = 0; index < models.length(); index++) {
            JSONObject model = models.optJSONObject(index); if (model == null || !model.optString("id").equals(settings.optString("model"))
                || !model.optString("connection", settings.optString("connection")).equals(settings.optString("connection"))) continue;
            JSONArray levels = model.optJSONArray("thinking"); if (levels == null) continue;
            for (int levelIndex = 0; levelIndex < levels.length(); levelIndex++) {
                String level = levels.optString(levelIndex);
                String label = LocalChatThinking.display(level, chinese);
                row(label, label.equals(level) ? "" : level, level.equals(settings.optString("thinking")), "remoteThinkingOption:" + level, () -> choose("thinking", level));
            }
        }
        position();
    }
    static String permissionLabel(String level, boolean chinese) {
        if (level.equals("full")) return chinese ? "全自动" : "Fully automatic";
        if (level.equals("auto")) return chinese ? "默认" : "Default";
        return chinese ? "手动批准" : "Manual approval";
    }
    private void permissions() {
        body.removeAllViews();
        String[] levels = { "ask", "auto", "full" };
        String[] descriptions = { tr("执行需要授权的操作前先询问", "Ask before actions that need authorization"),
            tr("常规操作自动执行，风险操作会询问", "Run routine actions; ask about risky ones"),
            tr("所有工具操作无需确认直接执行", "Run all tool actions without confirmation") };
        for (int index = 0; index < levels.length; index++) {
            String level = levels[index];
            row(permissionLabel(level, chinese), descriptions[index], level.equals(settings.optString("permissionMode")), "remotePermissionOption:" + level, () -> choose("permissionMode", level));
        }
        position();
    }
    void show(View anchor, boolean permissions) {
        this.anchor = anchor;
        Rect visible = new Rect(); anchor.getWindowVisibleDisplayFrame(visible);
        int[] location = new int[2]; anchor.getLocationOnScreen(location);
        width = Math.min(dp(320), visible.width() - dp(24));
        left = Math.max(visible.left + dp(12), Math.min(location[0], visible.right - width - dp(12)));
        bottom = Math.min(location[1] - dp(6), visible.bottom - dp(12));
        heightLimit = Math.max(dp(48), bottom - visible.top - dp(12));
        popup.setWidth(width);
        if (permissions) permissions(); else models();
    }
    @android.annotation.SuppressLint("RtlHardcoded")
    private void position() {
        int contentWidth = Math.max(1, width);
        body.measure(View.MeasureSpec.makeMeasureSpec(contentWidth, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        int height = Math.min(heightLimit, body.getMeasuredHeight());
        popup.setHeight(height);
        if (popup.isShowing()) popup.update(left, bottom - height, width, height);
        else {
            surface.capture(anchor.getRootView(), left, bottom - height, width, height);
            popup.showAtLocation(anchor, Gravity.TOP | Gravity.LEFT, left, bottom - height);
        }
    }
    void dismiss() { popup.dismiss(); }
}
