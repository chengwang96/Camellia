package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ScrollView;
import android.widget.TextView;
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
    private final LinearLayout body;
    private View anchor;
    private int left, bottom, width, heightLimit;

    RemoteSettingsPopup(Context context, boolean chinese, int background, int ink, int muted, int accent,
            JSONObject settings, Listener listener) {
        this.context = context; this.chinese = chinese; this.background = background; this.ink = ink;
        this.muted = muted; this.accent = accent; this.settings = settings; this.listener = listener;
        body = new LinearLayout(context); body.setOrientation(LinearLayout.VERTICAL); body.setPadding(dp(12), dp(12), dp(12), dp(12));
        body.setTag("remoteSettingsPanel");
        ScrollView scroll = new ScrollView(context); scroll.setFillViewport(false); scroll.addView(body);
        popup.setContentView(scroll); popup.setBackgroundDrawable(round(background, 26)); popup.setElevation(dp(12));
        popup.setFocusable(true); popup.setOutsideTouchable(true); popup.setInputMethodMode(PopupWindow.INPUT_METHOD_NOT_NEEDED);
    }

    private int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
    private String tr(String zh, String en) { return chinese ? zh : en; }
    private GradientDrawable round(int color, int radius) {
        GradientDrawable drawable = new GradientDrawable(); drawable.setColor(color); drawable.setCornerRadius(dp(radius)); return drawable;
    }
    private TextView text(String value, int size, int color) {
        TextView label = new TextView(context); label.setText(value); label.setTextSize(size); label.setTextColor(color); return label;
    }
    private void row(String title, String description, boolean selected, String tag, Runnable action) {
        LinearLayout row = new LinearLayout(context); row.setGravity(Gravity.CENTER_VERTICAL); row.setPadding(dp(14), dp(14), dp(10), dp(14));
        row.setTag(tag); row.setMinimumHeight(dp(60)); row.setFocusable(true); row.setSelected(selected);
        row.setBackground(new RippleDrawable(ColorStateList.valueOf((accent & 0xffffff) | 0x18000000), round(background, 16), round(Color.WHITE, 16)));
        LinearLayout words = new LinearLayout(context); words.setOrientation(LinearLayout.VERTICAL);
        TextView name = text(title, 17, ink); name.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); words.addView(name);
        if (!description.isEmpty()) { TextView detail = text(description, 12, muted); detail.setPadding(0, dp(6), 0, 0); words.addView(detail); }
        row.addView(words, new LinearLayout.LayoutParams(0, -2, 1));
        if (selected) { TextView check = text("✓", 22, accent); check.setGravity(Gravity.CENTER); row.addView(check, new LinearLayout.LayoutParams(dp(32), dp(32))); }
        row.setContentDescription(title + ", " + description + (selected ? tr("，已选择", ", selected") : ""));
        row.setOnClickListener(view -> action.run()); body.addView(row);
    }
    private void choose(String key, String value) { dismiss(); listener.onSelect(key, value); }
    private void divider() {
        View line = new View(context); line.setBackgroundColor((muted & 0xffffff) | 0x24000000);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(1)); params.setMargins(dp(14), dp(8), dp(14), dp(8)); body.addView(line, params);
    }
    private void models() {
        body.removeAllViews();
        JSONArray models = settings.optJSONArray("models");
        if (models == null || models.length() == 0) row(tr("暂无可用模型", "No models available"), tr("请在电脑端配置模型或登录账号", "Configure models or sign in on your computer"), false, "remoteModelsEmpty", () -> {});
        else for (int index = 0; index < models.length(); index++) {
            JSONObject model = models.optJSONObject(index); if (model == null) continue;
            String id = model.optString("id"), name = model.optString("name", id);
            row(name, name.equals(id) ? "" : id, id.equals(settings.optString("model")), "remoteModelOption:" + id, () -> choose("model", id));
        }
        divider();
        row(tr("思考等级", "Thinking level"), settings.optString("thinking").isEmpty() ? tr("默认", "Default") : settings.optString("thinking"), false, "remoteThinkingSettings", this::thinking);
        position();
    }
    private void thinking() {
        body.removeAllViews();
        row(tr("‹ 返回模型", "‹ Back to models"), "", false, "remoteThinkingBack", this::models); divider();
        row(tr("默认", "Default"), tr("遵循引擎默认设置", "Use engine defaults"), settings.optString("thinking").isEmpty(), "remoteThinkingOption:", () -> choose("thinking", ""));
        JSONArray models = settings.optJSONArray("models");
        if (models != null) for (int index = 0; index < models.length(); index++) {
            JSONObject model = models.optJSONObject(index); if (model == null || !model.optString("id").equals(settings.optString("model"))) continue;
            JSONArray levels = model.optJSONArray("thinking"); if (levels == null) continue;
            for (int levelIndex = 0; levelIndex < levels.length(); levelIndex++) {
                String level = levels.optString(levelIndex);
                row(level, "", level.equals(settings.optString("thinking")), "remoteThinkingOption:" + level, () -> choose("thinking", level));
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
        int[] composerLocation = new int[2]; ((View) anchor.getParent().getParent()).getLocationOnScreen(composerLocation);
        width = Math.min(dp(320), visible.width() - dp(24));
        left = Math.max(visible.left + dp(12), Math.min(location[0], visible.right - width - dp(12)));
        bottom = Math.min(composerLocation[1] - dp(10), visible.bottom - dp(12));
        heightLimit = Math.max(dp(48), bottom - visible.top - dp(12));
        popup.setWidth(width);
        if (permissions) permissions(); else models();
    }
    private void position() {
        body.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        int height = Math.min(heightLimit, body.getMeasuredHeight());
        popup.setHeight(height);
        if (popup.isShowing()) popup.update(left, bottom - height, width, height);
        else popup.showAtLocation(anchor, Gravity.TOP | Gravity.LEFT, left, bottom - height);
    }
    void dismiss() { popup.dismiss(); }
}
