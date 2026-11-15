package app.camellia.mobile;

import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.text.InputFilter;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;

final class ChatComposer {
    private static final float MODEL_WIDTH_FRACTION = .58f;
    final ComposerInput input;
    final TextView model;
    final ImageButton send, stop;
    private final LinearLayout tools, editing;
    private final View toolSpacer;
    private final ImageButton cancelEdit;
    private final Context context;
    private final boolean chinese;
    private int modelMaxWidth = -1;

    ChatComposer(LinearLayout bar, ChatStyle style, boolean chinese, String hint, int limit,
                 Runnable onModel, Runnable onSend, Runnable onStop, Runnable onCancelEdit) {
        context = bar.getContext(); this.chinese = chinese;
        bar.setOrientation(LinearLayout.VERTICAL);
        bar.setPadding(dp(8), dp(6), dp(8), dp(6));
        GradientDrawable shape = style.floatingBar(bar);
        editing = new LinearLayout(context); editing.setGravity(Gravity.CENTER_VERTICAL);
        editing.setTag("composerEditBanner");
        TextView label = new TextView(context);
        label.setText(chinese ? "正在编辑上一条消息" : "Editing previous message");
        label.setTextColor(style.muted); label.setTextSize(Palette.TEXT_SMALL); label.setPadding(dp(12), 0, 0, 0);
        label.setSingleLine(true); label.setEllipsize(TextUtils.TruncateAt.END);
        editing.addView(label, new LinearLayout.LayoutParams(0, -2, 1));
        cancelEdit = style.composerToolButton("close", chinese ? "取消编辑" : "Cancel editing", style.ink, onCancelEdit);
        cancelEdit.setTag("composerCancelEdit");
        editing.addView(cancelEdit, new LinearLayout.LayoutParams(dp(48), dp(48)));
        editing.setVisibility(View.GONE); bar.addView(editing);
        input = new ComposerInput(context); input.setTextColor(style.ink); input.setTextSize(MobilePreferences.chatTextSize(context, Palette.TEXT_ROW));
        input.setMaxLines(4); input.setMinHeight(dp(48)); input.setVerticalScrollBarEnabled(false);
        input.setHint(hint); input.setHintTextColor(style.muted);
        input.setContentDescription(chinese ? "消息输入框" : "Message input");
        input.setGravity(Gravity.TOP | Gravity.START);
        input.useMultiLineInput();
        input.setFilters(new InputFilter[] { new InputFilter.LengthFilter(limit) });
        input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        input.setBackgroundColor(Color.TRANSPARENT); input.setPadding(dp(14), dp(11), dp(12), dp(9));
        bar.addView(input, new LinearLayout.LayoutParams(-1, -2));
        tools = new LinearLayout(context); tools.setGravity(Gravity.CENTER_VERTICAL); tools.setTag("composerTools");
        tools.setPadding(dp(2), dp(2), dp(2), 0);
        bar.addView(tools, new LinearLayout.LayoutParams(-1, -2));
        toolSpacer = new View(context);
        toolSpacer.setTag("composerToolSpacer");
        toolSpacer.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        tools.addView(toolSpacer, new LinearLayout.LayoutParams(0, 1, 1));
        model = new TextView(context); model.setTextColor(style.ink); model.setTextSize(Palette.TEXT_BODY);
        model.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
        model.setGravity(Gravity.CENTER_VERTICAL | Gravity.END); model.setSingleLine(true); model.setEllipsize(TextUtils.TruncateAt.END);
        model.setMaxWidth(Math.round(context.getResources().getDisplayMetrics().widthPixels * MODEL_WIDTH_FRACTION));
        LineIcon chevron = new LineIcon("down", style.muted); chevron.setBounds(0, 0, dp(14), dp(14));
        model.setCompoundDrawablesRelative(null, null, chevron, null); model.setCompoundDrawablePadding(dp(4));
        model.setPadding(dp(12), 0, dp(10), 0); model.setFocusable(true);
        model.setBackground(new android.graphics.drawable.RippleDrawable(
            android.content.res.ColorStateList.valueOf(Palette.RIPPLE_ON_CARD),
            null, style.capsule(Color.WHITE)));
        model.setOnClickListener(view -> onModel.run());
        tools.addView(model, new LinearLayout.LayoutParams(-2, dp(48)));
        send = style.composerAction(chinese ? "发送" : "Send", R.drawable.ic_send, onSend);
        stop = style.composerAction(chinese ? "停止" : "Stop", R.drawable.ic_stop, onStop);
        tools.addView(send, new LinearLayout.LayoutParams(dp(48), dp(48)));
        tools.addView(stop, new LinearLayout.LayoutParams(dp(48), dp(48)));
        input.setSendAction(() -> { if (send.isEnabled() && send.getVisibility() == View.VISIBLE) send.performClick(); });
        input.setOnFocusChangeListener((view, focused) -> shape.setStroke(dp(1), focused ? style.accent : style.floatingBarEdge()));
        bar.addOnLayoutChangeListener((view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) ->
            updateModelMaxWidth());
    }

    void addTool(View tool) {
        addTool(tool, 48);
    }

    void addTool(View tool, int widthDp) {
        int width = widthDp < 0 ? widthDp : dp(widthDp);
        tools.addView(tool, tools.indexOfChild(toolSpacer), new LinearLayout.LayoutParams(width, dp(48)));
        tool.post(this::updateModelMaxWidth);
    }

    void model(String name, String thinking, boolean enabled) {
        String label = ModelLabel.compact(name) + (thinking.isEmpty() ? "" : " · " + thinking);
        model.setText(label); model.setEnabled(enabled); model.setAlpha(enabled ? 1f : .45f);
        String description = (chinese ? "切换模型和思考等级：" : "Change model and thinking level: ")
            + name + (thinking.isEmpty() ? "" : " · " + thinking);
        model.setContentDescription(description); model.setTooltipText(description);
        model.post(this::updateModelMaxWidth);
    }

    void editing(boolean active, boolean enabled) {
        editing.setVisibility(active ? View.VISIBLE : View.GONE);
        cancelEdit.setEnabled(enabled);
    }

    private int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }

    private void updateModelMaxWidth() {
        if (model == null || tools == null || input == null) return;
        int editorWidth = input.getWidth();
        int toolsWidth = tools.getWidth() - tools.getPaddingLeft() - tools.getPaddingRight();
        if (editorWidth <= 0 || toolsWidth <= 0) return;
        int fixed = 0;
        for (int index = 0; index < tools.getChildCount(); index++) {
            View child = tools.getChildAt(index);
            if (child == model || child == toolSpacer || child.getVisibility() == View.GONE) continue;
            fixed += child.getMeasuredWidth();
        }
        int limit = modelWidthLimit(editorWidth, toolsWidth, fixed, dp(48));
        if (limit != modelMaxWidth) {
            modelMaxWidth = limit;
            model.setMaxWidth(limit);
        }
    }

    static int modelWidthLimit(int editorWidth, int toolsWidth, int fixedWidth, int minWidth) {
        int available = Math.max(minWidth, toolsWidth - fixedWidth);
        return Math.max(minWidth, Math.min(Math.round(editorWidth * MODEL_WIDTH_FRACTION), available));
    }
}
