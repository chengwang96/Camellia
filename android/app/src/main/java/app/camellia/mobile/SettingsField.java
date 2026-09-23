package app.camellia.mobile;

import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

@android.annotation.SuppressLint("ViewConstructor")
final class SettingsField extends LinearLayout {
    private final EditText input;
    private final TextView feedback;
    private final ChatStyle style;
    private final SettingsStyle settings;
    private final int errorColor;

    SettingsField(EditText input) {
        super(input.getContext());
        this.input = input; style = new ChatStyle(getContext());
        settings = new SettingsStyle(getContext()); errorColor = settings.error;
        setOrientation(VERTICAL);
        input.setBackgroundTintList(null);
        input.setPadding(style.dp(16), style.dp(14), style.dp(16), style.dp(14));
        input.setMinimumHeight(style.dp(52));
        input.setTextColor(settings.ink);
        input.setHintTextColor(settings.secondary);
        input.setHighlightColor((style.accent & 0x00ffffff) | 0x33000000);
        addView(input, new LayoutParams(-1, -2));
        feedback = new TextView(getContext()); feedback.setTextSize(13); feedback.setTextColor(errorColor);
        feedback.setPadding(style.dp(12), style.dp(8), style.dp(12), style.dp(4));
        feedback.setTag(input.getTag() + "Error"); feedback.setVisibility(GONE);
        feedback.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        addView(feedback, new LayoutParams(-1, -2));
        input.setAccessibilityDelegate(new View.AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info);
                boolean invalid = feedback.getVisibility() == VISIBLE;
                info.setContentInvalid(invalid); info.setError(invalid ? feedback.getText() : null);
            }
        });
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) {
                if (feedback.getVisibility() == VISIBLE) {
                    feedback.setText(""); feedback.setVisibility(GONE); updateBackground(false);
                }
            }
            @Override public void afterTextChanged(Editable text) {}
        });
        updateBackground(false);
    }

    private GradientDrawable background(int border) {
        return settings.fieldBackground(border);
    }

    private void updateBackground(boolean invalid) {
        StateListDrawable states = new StateListDrawable();
        states.addState(new int[]{android.R.attr.state_focused}, background(invalid ? errorColor : style.accent));
        states.addState(new int[]{}, background(invalid ? errorColor : settings.fieldBorder));
        input.setBackground(states);
    }

    void showError(String message) {
        feedback.setText(message); feedback.setVisibility(VISIBLE); updateBackground(true); input.requestFocus();
    }
}
