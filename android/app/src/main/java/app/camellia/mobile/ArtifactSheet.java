package app.camellia.mobile;

import android.app.Dialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

final class ArtifactSheet extends Dialog {
    final SettingsStyle style;
    final LinearLayout content, actions;

    ArtifactSheet(Context context, String title, String subtitle) {
        super(context); requestWindowFeature(Window.FEATURE_NO_TITLE);
        style = new SettingsStyle(context);
        // Not `style.sheetPanel(...)`. That is the narrow sheet's frame — 18/14
        // side padding and a 16dp gap under the grip. This one is the wide
        // variant (up to 560dp) and uses 16/12 with a 12dp gap, which is what
        // makes it read as a different shape rather than the same sheet at a
        // different width. Same corner and same grip, though, so those two go
        // through `Palette` rather than being written out again.
        LinearLayout panel = column(); panel.setPadding(dp(16), dp(12), dp(16), dp(16));
        panel.setBackground(rounded(style.background, Palette.RADIUS_SHEET));
        View handle = new View(context); handle.setBackground(rounded(style.divider, Palette.RADIUS_GRIP));
        LinearLayout.LayoutParams grip = new LinearLayout.LayoutParams(dp(36), dp(4)); grip.gravity = Gravity.CENTER_HORIZONTAL; grip.bottomMargin = dp(12); panel.addView(handle, grip);
        panel.addView(style.header(title, context.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh") ? "返回" : "Back", this::dismiss));
        if (!subtitle.isEmpty()) style.note(panel, subtitle);
        content = column(); ScrollView scroll = new ScrollView(context); scroll.setFillViewport(false); scroll.addView(content);
        panel.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        actions = column(); panel.addView(actions); setContentView(panel);
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND); getWindow().setDimAmount(.28f);
        getWindow().setGravity(Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
    }

    @Override public void show() {
        super.show();
        android.util.DisplayMetrics metrics = getContext().getResources().getDisplayMetrics();
        getWindow().setLayout(Math.min(dp(560), metrics.widthPixels - dp(24)), Math.min(dp(660), (int) (metrics.heightPixels * .83f)));
        var attributes = getWindow().getAttributes(); attributes.y = dp(12); getWindow().setAttributes(attributes);
    }
    int dp(int value) { return style.dp(value); }
    LinearLayout column() { LinearLayout layout = new LinearLayout(getContext()); layout.setOrientation(LinearLayout.VERTICAL); return layout; }
    GradientDrawable rounded(int color, int radius) { return style.round(color, radius); }
    TextView text(String value, int size, int color) {
        TextView text = new TextView(getContext()); text.setText(value); text.setTextSize(size); text.setTextColor(color);
        text.setLineSpacing(dp(3), 1); return text;
    }
    TextView action(String value, boolean primary, Runnable action) {
        TextView button = text(value, Palette.TEXT_ROW, primary ? style.card : style.ink); button.setGravity(Gravity.CENTER);
        button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL)); button.setPadding(dp(16), dp(14), dp(16), dp(14));
        button.setMinHeight(dp(52)); button.setFocusable(true);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(style.divider),
            rounded(primary ? style.ink : style.card, Palette.RADIUS_DIALOG_ACTION),
            rounded(Color.WHITE, Palette.RADIUS_DIALOG_ACTION)));
        button.setOnClickListener(view -> action.run());
        button.setAccessibilityDelegate(new View.AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View host, android.view.accessibility.AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info); info.setClassName("android.widget.Button");
            }
        });
        return button;
    }
}
