package app.camellia.mobile;

import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;

final class ChatComposer {
    final ComposerInput input;
    final TextView model;
    final ImageButton send, stop;
    private final LinearLayout tools, editing;
    private final ImageButton cancelEdit;
    private final Context context;
    private final boolean chinese;

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
        label.setTextColor(style.muted); label.setTextSize(12); label.setPadding(dp(12), 0, 0, 0);
        label.setSingleLine(true); label.setEllipsize(TextUtils.TruncateAt.END);
        editing.addView(label, new LinearLayout.LayoutParams(0, -2, 1));
        cancelEdit = style.lineButton("close", chinese ? "取消编辑" : "Cancel editing", onCancelEdit);
        cancelEdit.setTag("composerCancelEdit");
        editing.addView(cancelEdit, new LinearLayout.LayoutParams(dp(48), dp(48)));
        editing.setVisibility(View.GONE); bar.addView(editing);
        input = new ComposerInput(context); input.setTextColor(style.ink); input.setTextSize(16);
        input.setMaxLines(4); input.setMinHeight(dp(48)); input.setVerticalScrollBarEnabled(false);
        input.setHint(hint); input.setHintTextColor(style.muted);
        input.setContentDescription(chinese ? "消息输入框" : "Message input");
        input.setGravity(Gravity.TOP | Gravity.START);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        input.setFilters(new InputFilter[] { new InputFilter.LengthFilter(limit) });
        input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        input.setBackgroundColor(Color.TRANSPARENT); input.setPadding(dp(12), dp(12), dp(8), dp(12));
        bar.addView(input, new LinearLayout.LayoutParams(-1, -2));
        tools = new LinearLayout(context); tools.setGravity(Gravity.CENTER_VERTICAL); tools.setTag("composerTools");
        bar.addView(tools, new LinearLayout.LayoutParams(-1, -2));
        model = new TextView(context); model.setTextColor(style.ink); model.setTextSize(14);
        model.setGravity(Gravity.CENTER_VERTICAL); model.setSingleLine(true); model.setEllipsize(TextUtils.TruncateAt.END);
        LineIcon chevron = new LineIcon("down", style.muted); chevron.setBounds(0, 0, dp(14), dp(14));
        model.setCompoundDrawablesRelative(null, null, chevron, null); model.setCompoundDrawablePadding(dp(4));
        model.setPadding(dp(10), 0, dp(10), 0); model.setFocusable(true);
        model.setBackground(new android.graphics.drawable.RippleDrawable(
            android.content.res.ColorStateList.valueOf(0x224176e6), style.capsule(style.background), style.capsule(Color.WHITE)));
        model.setOnClickListener(view -> onModel.run());
        tools.addView(model, new LinearLayout.LayoutParams(0, dp(48), 1));
        send = style.composerAction(chinese ? "发送" : "Send", R.drawable.ic_send, onSend);
        stop = style.composerAction(chinese ? "停止" : "Stop", R.drawable.ic_stop, onStop);
        tools.addView(send, new LinearLayout.LayoutParams(dp(48), dp(48)));
        tools.addView(stop, new LinearLayout.LayoutParams(dp(48), dp(48)));
        input.setSendAction(() -> { if (send.isEnabled() && send.getVisibility() == View.VISIBLE) send.performClick(); });
        input.setOnFocusChangeListener((view, focused) -> shape.setStroke(dp(1), focused ? style.accent : style.floatingBarEdge()));
    }

    void addTool(View tool) {
        tools.addView(tool, tools.indexOfChild(model), new LinearLayout.LayoutParams(dp(48), dp(48)));
    }

    void model(String name, String thinking, boolean enabled) {
        String label = ModelLabel.compact(name) + (thinking.isEmpty() ? "" : " · " + thinking);
        model.setText(label); model.setEnabled(enabled); model.setAlpha(enabled ? 1f : .45f);
        String description = (chinese ? "切换模型和思考等级：" : "Change model and thinking level: ")
            + name + (thinking.isEmpty() ? "" : " · " + thinking);
        model.setContentDescription(description); model.setTooltipText(description);
    }

    void editing(boolean active, boolean enabled) {
        editing.setVisibility(active ? View.VISIBLE : View.GONE);
        cancelEdit.setEnabled(enabled);
    }

    private int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
}
