package app.camellia.mobile;

import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

final class CamelliaDialog extends AlertDialog {
    private final Builder options;
    private final SettingsStyle style;
    private final java.util.Map<Integer, Button> buttons = new java.util.HashMap<>();

    private CamelliaDialog(Builder options) {
        super(options.getContext()); this.options = options; style = new SettingsStyle(getContext());
        setCancelable(options.cancelable);
        setCanceledOnTouchOutside(options.cancelable);
        if (options.cancelListener != null) setOnCancelListener(options.cancelListener);
    }

    private int dp(int value) { return Math.round(value * getContext().getResources().getDisplayMetrics().density); }
    private GradientDrawable rounded(int color, int radius) {
        GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(radius)); return shape;
    }
    private LinearLayout column() {
        LinearLayout column = new LinearLayout(getContext()); column.setOrientation(LinearLayout.VERTICAL); return column;
    }
    private TextView text(CharSequence value, int size, int color) {
        TextView view = new TextView(getContext()); view.setText(value); view.setTextSize(size); view.setTextColor(color);
        view.setLineSpacing(dp(3), 1); return view;
    }

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout panel = column(); panel.setTag("camelliaDialog"); style.sheetPanel(panel);
        ScrollView scroll = new ScrollView(getContext()); scroll.setFillViewport(false);
        LinearLayout body = column(); body.setTag("camelliaDialogBody"); scroll.addView(body);
        if (options.title != null && options.title.length() > 0) {
            TextView title = text(options.title, 21, style.ink); title.setTag("camelliaDialogTitle");
            title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); title.setPadding(dp(8), dp(4), dp(8), dp(18));
            if (android.os.Build.VERSION.SDK_INT >= 28) title.setAccessibilityHeading(true);
            body.addView(title);
        }
        if (options.message != null) {
            TextView message = text(options.message, 15, style.secondary); message.setId(android.R.id.message);
            message.setPadding(dp(16), dp(16), dp(16), dp(16)); message.setBackground(style.cardBackground());
            message.setTextIsSelectable(true); body.addView(message);
        }
        if (options.content != null) {
            View content = options.content;
            if (content instanceof ScrollView && ((ScrollView) content).getChildCount() == 1) {
                ScrollView supplied = (ScrollView) content; content = supplied.getChildAt(0); supplied.removeView(content);
            }
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(4); body.addView(content, params);
        }
        if (options.items != null) {
            LinearLayout group = style.group(body, "");
            for (int index = 0; index < options.items.length; index++) {
                final int selected = index;
                style.action(group, options.items[index].toString(), "", "camelliaDialogItem:" + index, false, () -> {
                    dismiss();
                    if (options.itemListener != null) options.itemListener.onClick(this, selected);
                });
            }
        }
        panel.addView(scroll, new LinearLayout.LayoutParams(-1, -2, 1));
        LinearLayout actions = column(); actions.setPadding(0, dp(12), 0, 0); panel.addView(actions);
        addButton(actions, BUTTON_POSITIVE, android.R.id.button1, options.positive, options.positiveListener, true);
        addButton(actions, BUTTON_NEGATIVE, android.R.id.button2, options.negative, options.negativeListener, false);
        addButton(actions, BUTTON_NEUTRAL, android.R.id.button3, options.neutral, options.neutralListener, false);
        setContentView(panel);
        style.sheetWindow(getWindow(), panel);
    }

    private void addButton(LinearLayout parent, int which, int id, CharSequence label, DialogInterface.OnClickListener listener, boolean primary) {
        if (label == null) return;
        Button button = new Button(getContext()); button.setId(id); button.setText(label); button.setAllCaps(false); button.setTextSize(16);
        button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); button.setTextColor(primary ? style.card : style.ink);
        button.setPadding(dp(14), dp(12), dp(14), dp(12)); button.setMinHeight(dp(52)); button.setMinimumHeight(dp(52));
        button.setStateListAnimator(null); button.setElevation(0);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(style.divider), rounded(primary ? style.ink : style.card, 20), rounded(Color.WHITE, 20)));
        button.setOnClickListener(view -> { if (listener != null) listener.onClick(this, which); dismiss(); });
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); if (parent.getChildCount() > 0) params.topMargin = dp(8);
        parent.addView(button, params); buttons.put(which, button);
    }

    @Override public Button getButton(int which) { return buttons.get(which); }

    static final class Builder extends AlertDialog.Builder {
        private CharSequence title, message, positive, negative, neutral;
        private View content;
        private CharSequence[] items;
        private DialogInterface.OnClickListener positiveListener, negativeListener, neutralListener, itemListener;
        private DialogInterface.OnCancelListener cancelListener;
        private boolean cancelable = true;
        Builder(Context context) { super(context); }
        @Override public Builder setTitle(CharSequence value) { title = value; return this; }
        @Override public Builder setMessage(CharSequence value) { message = value; return this; }
        @Override public Builder setView(View value) { content = value; return this; }
        @Override public Builder setPositiveButton(CharSequence value, DialogInterface.OnClickListener listener) { positive = value; positiveListener = listener; return this; }
        @Override public Builder setNegativeButton(CharSequence value, DialogInterface.OnClickListener listener) { negative = value; negativeListener = listener; return this; }
        @Override public Builder setNeutralButton(CharSequence value, DialogInterface.OnClickListener listener) { neutral = value; neutralListener = listener; return this; }
        @Override public Builder setItems(CharSequence[] values, DialogInterface.OnClickListener listener) { items = values.clone(); itemListener = listener; return this; }
        @Override public Builder setCancelable(boolean value) { cancelable = value; return this; }
        @Override public Builder setOnCancelListener(DialogInterface.OnCancelListener value) { cancelListener = value; return this; }
        @Override public CamelliaDialog create() { return new CamelliaDialog(this); }
        @Override public CamelliaDialog show() { CamelliaDialog dialog = create(); dialog.show(); return dialog; }
    }
}
