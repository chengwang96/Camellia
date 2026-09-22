package app.camellia.mobile;

import android.content.Context;
import android.animation.ValueAnimator;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.RenderEffect;
import android.graphics.Shader;
import android.os.Build;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ScrollView;
import android.widget.TextView;
import java.net.URI;
import java.util.List;

final class ModelPickerPopup {
    interface Listener {
        void onModel(LocalChatConfig.Route route);
        void onThinking(String level);
        void onImport();
    }

    private final Context context;
    private final boolean chinese;
    private final int background, surface, ink, muted, accent;
    private final List<LocalChatConfig.Route> routes;
    private final LocalChatConfig.Route selected;
    private final String level;
    private final Listener listener;
    private boolean closing;
    private final PopupWindow popup = new PopupWindow() {
        @Override public void dismiss() {
            if (!closing && thinkingSurface != null) models();
            else super.dismiss();
        }
    };
    private final FrameLayout panel;
    private PopupSurface modelSurface;
    private PopupSurface thinkingSurface;
    private View retreat;
    private View backdropSource;
    private int heightLimit, modelHeight;

    ModelPickerPopup(Context context, boolean chinese, int background, int surface, int ink, int muted, int accent,
            List<LocalChatConfig.Route> routes, LocalChatConfig.Route selected, String level, Listener listener) {
        this.context = context; this.chinese = chinese;
        this.background = Color.red(background) < 128 ? blend(background, surface, .7f) : background; this.surface = surface;
        this.ink = ink; this.muted = muted; this.accent = accent; this.routes = routes; this.selected = selected;
        this.level = LocalChatThinking.effective(selected, level); this.listener = listener;
        panel = new FrameLayout(context) {
            @Override public boolean dispatchKeyEvent(KeyEvent event) {
                if (event.getKeyCode() == KeyEvent.KEYCODE_BACK && thinkingSurface != null) {
                    if (event.getAction() == KeyEvent.ACTION_UP) models();
                    return true;
                }
                return super.dispatchKeyEvent(event);
            }
        };
        panel.setTag("modelPickerPanel"); panel.setClipChildren(false); panel.setClipToPadding(false);
        panel.setBackground(round(this.background, 26)); panel.setClipToOutline(true);
        popup.setContentView(panel); popup.setBackgroundDrawable(round(this.background, 26));
        popup.setElevation(dp(8)); popup.setFocusable(true); popup.setOutsideTouchable(true);
        popup.setInputMethodMode(PopupWindow.INPUT_METHOD_NOT_NEEDED);
    }

    void show(View anchor) {
        Rect visible = new Rect(); anchor.getWindowVisibleDisplayFrame(visible);
        int[] location = new int[2]; anchor.getLocationOnScreen(location);
        int width = Math.max(1, Math.min(dp(320), visible.width() - dp(24)));
        int left = Math.max(visible.left + dp(12), Math.min(location[0], visible.right - width - dp(12)));
        int top = Math.max(visible.top + dp(8), Math.min(location[1] + anchor.getHeight() + dp(10), visible.bottom - dp(180)));
        heightLimit = Math.max(1, visible.bottom - top - dp(16));
        popup.setWidth(width); models();
        backdropSource = anchor.getRootView();
        modelSurface.capture(backdropSource, left, top, width, modelHeight);
        int horizontal = anchor.getLayoutDirection() == View.LAYOUT_DIRECTION_RTL
            ? anchor.getRootView().getWidth() - left - width : left;
        popup.showAtLocation(anchor, Gravity.TOP | Gravity.START, horizontal, top);
    }

    void dismiss() {
        closing = true;
        try { popup.dismiss(); } finally { closing = false; }
    }
    boolean isShowing() { return popup.isShowing(); }

    private int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
    private String tr(String zh, String en) { return chinese ? zh : en; }
    private LinearLayout column() { LinearLayout layout = new LinearLayout(context); layout.setOrientation(LinearLayout.VERTICAL); return layout; }
    private GradientDrawable round(int color, int radius) { GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(radius)); return shape; }
    private TextView text(String value, int size, int color) {
        TextView text = new TextView(context); text.setText(value); text.setTextSize(size); text.setTextColor(color);
        text.setLineSpacing(dp(3), 1); return text;
    }
    private void divider(LinearLayout parent) {
        View line = new View(context); line.setBackgroundColor((muted & 0x00ffffff) | 0x24000000);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(1)); params.setMargins(dp(14), dp(10), dp(14), dp(10));
        parent.addView(line, params);
    }

    private View row(String title, String subtitle, String icon, boolean checked, String tag, Runnable action) {
        LinearLayout row = new LinearLayout(context); row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(16), dp(14), dp(14), dp(14)); row.setMinimumHeight(dp(64)); row.setTag(tag);
        row.setBackground(new RippleDrawable(ColorStateList.valueOf((accent & 0x00ffffff) | 0x18000000), null, round(Color.WHITE, 18)));
        LinearLayout words = column();
        TextView name = text(title, 17, ink); name.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        name.setMaxLines(2); name.setEllipsize(android.text.TextUtils.TruncateAt.END); words.addView(name);
        if (!subtitle.isEmpty()) {
            TextView description = text(subtitle, 12, muted); description.setPadding(0, dp(5), 0, 0);
            description.setMaxLines(3); description.setEllipsize(android.text.TextUtils.TruncateAt.END); words.addView(description);
        }
        row.addView(words, new LinearLayout.LayoutParams(0, -2, 1));
        if (checked) {
            TextView check = text("✓", 22, accent); check.setGravity(Gravity.CENTER); check.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            row.addView(check, new LinearLayout.LayoutParams(dp(32), dp(32)));
        } else if (icon != null) {
            ImageView arrow = new ImageView(context); arrow.setImageDrawable(new LineIcon(icon, muted)); arrow.setPadding(dp(4), dp(4), dp(4), dp(4));
            arrow.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); row.addView(arrow, new LinearLayout.LayoutParams(dp(26), dp(26)));
        }
        row.setFocusable(true); row.setSelected(checked);
        row.setContentDescription(title + (subtitle.isEmpty() ? "" : ", " + subtitle) + (checked ? tr("，已选择", ", selected") : ""));
        row.setOnClickListener(view -> action.run()); return row;
    }

    static int blend(int base, int tint, float fraction) {
        return Color.rgb(Math.round(Color.red(base) * (1 - fraction) + Color.red(tint) * fraction),
            Math.round(Color.green(base) * (1 - fraction) + Color.green(tint) * fraction),
            Math.round(Color.blue(base) * (1 - fraction) + Color.blue(tint) * fraction));
    }

    private PopupSurface surface(LinearLayout body) {
        PopupSurface layer = new PopupSurface(context, background);
        ScrollView viewport = new ScrollView(context); viewport.setVerticalScrollBarEnabled(false); viewport.addView(body);
        viewport.setPadding(dp(12), dp(14), dp(12), dp(10)); viewport.setClipToPadding(false);
        layer.addView(viewport, new FrameLayout.LayoutParams(-1, -1)); return layer;
    }

    private int height(View layer) {
        layer.measure(View.MeasureSpec.makeMeasureSpec(popup.getWidth(), View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(heightLimit, View.MeasureSpec.AT_MOST));
        return Math.min(heightLimit, layer.getMeasuredHeight());
    }

    private void resize(int height) {
        popup.setHeight(height);
        if (popup.isShowing()) popup.update(popup.getWidth(), height);
    }

    private void reveal(View layer) {
        if (!ValueAnimator.areAnimatorsEnabled()) return;
        layer.setAlpha(0f); layer.setTranslationY(dp(8));
        layer.animate().alpha(1f).translationY(0f).setDuration(180).start();
    }

    private void models() {
        if (modelSurface != null) {
            if (thinkingSurface != null) {
                thinkingSurface.animate().cancel(); panel.removeView(thinkingSurface); thinkingSurface = null;
                panel.removeView(retreat); retreat = null;
                modelSurface.setAlpha(1f);
                modelSurface.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
                modelSurface.setDescendantFocusability(ViewGroup.FOCUS_AFTER_DESCENDANTS);
                if (Build.VERSION.SDK_INT >= 31) modelSurface.setRenderEffect(null);
                resize(modelHeight);
                modelSurface.findViewWithTag("thinkingSettings").requestFocus();
            }
            return;
        }
        LinearLayout body = column();
        TextView caption = text(tr("选择模型", "Choose a model"), 11, muted); caption.setPadding(dp(16), dp(2), dp(16), dp(10)); body.addView(caption);
        for (LocalChatConfig.Route route : routes) {
            String host = URI.create(route.baseUrl).getHost();
            body.addView(row(route.displayName(), route.providerName() + " · " + host, null,
                selected != null && route.id.equals(selected.id), "modelOption:" + route.id, () -> { dismiss(); listener.onModel(route); }));
        }
        if (routes.isEmpty()) {
            TextView empty = text(tr("导入 API 配置后，即可选择模型。", "Import API configuration to choose a model."), 14, muted);
            empty.setPadding(dp(16), dp(12), dp(16), dp(16)); body.addView(empty);
        }
        divider(body);
        body.addView(row(tr("思考等级", "Thinking level"), LocalChatThinking.label(level, chinese), "right", false, "thinkingSettings", this::thinking));
        divider(body);
        body.addView(row(tr("管理 API 配置", "API configuration"), "", "right", false, "pickerImport", () -> { dismiss(); listener.onImport(); }));
        modelSurface = surface(body); modelSurface.setTag("modelPickerModels"); modelHeight = height(modelSurface);
        panel.addView(modelSurface, new FrameLayout.LayoutParams(-1, modelHeight)); resize(modelHeight);
    }

    private void thinking() {
        if (thinkingSurface != null) return;
        LinearLayout body = column();
        body.addView(row(tr("思考等级", "Thinking level"), selected == null ? tr("未选择模型", "No model selected") : selected.displayName(), "down", false, "thinkingBack", this::models));
        divider(body);
        boolean supported = LocalChatThinking.supported(selected);
        for (String option : LocalChatThinking.LEVELS) {
            String description = option.equals("auto") ? tr("遵循模型默认，不额外设置参数", "Use the model’s default settings")
                : option.equals("medium") ? tr("平衡思考深度与响应速度", "Balance reasoning and response speed")
                : tr("投入更多思考，可能增加耗时与费用", "More reasoning; may take longer and cost more");
            View choice = row(LocalChatThinking.label(option, chinese), description, null, option.equals(level), "thinkingOption:" + option,
                () -> { dismiss(); listener.onThinking(option); });
            if (!supported && !option.equals("auto")) { choice.setEnabled(false); choice.setAlpha(.4f); }
            body.addView(choice);
        }
        TextView note = text(supported ? tr("由所选 API 决定支持程度；若提示参数不支持，请切回默认。", "API support varies. If the parameter is rejected, switch back to Default.")
            : tr("此模型暂无已知的思考参数映射，使用默认设置。", "No known thinking controls for this model; using defaults."), 11, muted);
        note.setPadding(dp(16), dp(12), dp(16), dp(8)); body.addView(note);
        thinkingSurface = surface(body); thinkingSurface.setTag("modelPickerThinking");
        int childHeight = height(thinkingSurface);
        int totalHeight = Math.min(heightLimit, Math.max(modelHeight, childHeight + dp(96)));
        int[] origin = new int[2]; modelSurface.getLocationOnScreen(origin);
        thinkingSurface.capture(backdropSource, origin[0], origin[1] + totalHeight - childHeight, popup.getWidth(), childHeight);
        modelSurface.setAlpha(.48f);
        modelSurface.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        modelSurface.setDescendantFocusability(ViewGroup.FOCUS_BLOCK_DESCENDANTS);
        if (Build.VERSION.SDK_INT >= 31 && PopupSurface.supportsBlur(context))
            modelSurface.setRenderEffect(RenderEffect.createBlurEffect(dp(6), dp(6), Shader.TileMode.CLAMP));
        retreat = new View(context); retreat.setTag("thinkingRetreat");
        retreat.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        retreat.setOnClickListener(view -> models()); panel.addView(retreat, new FrameLayout.LayoutParams(-1, -1));
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-1, childHeight, Gravity.BOTTOM);
        thinkingSurface.setElevation(dp(6)); panel.addView(thinkingSurface, params);
        resize(totalHeight); reveal(thinkingSurface);
        thinkingSurface.findViewWithTag("thinkingBack").requestFocus();
    }
}
