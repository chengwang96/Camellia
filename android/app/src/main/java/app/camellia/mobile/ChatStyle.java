package app.camellia.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.view.Gravity;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.function.Supplier;

final class ChatStyle {
    final int background, surface, ink, muted, accent;
    private final Context context;

    ChatStyle(Context context) {
        this.context = context;
        boolean dark = (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        background = Color.parseColor(dark ? "#151517" : "#FFFFFF");
        surface = Color.parseColor(dark ? "#232324" : "#F5F6F7");
        ink = Color.parseColor(dark ? "#F9FAFB" : "#0F1115");
        muted = Color.parseColor(dark ? "#ADB2B8" : "#61666B");
        accent = Color.parseColor(dark ? "#679EFE" : "#4176E6");
    }

    int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }

    int dockBottomPadding() { return dp(8); }

    void dockStatus(TextView status) { status.setPadding(0, dp(2), 0, dp(2)); }

    GradientDrawable rounded(int color) {
        GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(12)); return shape;
    }

    GradientDrawable capsule(int color) {
        GradientDrawable shape = rounded(color); shape.setCornerRadius(dp(28)); return shape;
    }

    GradientDrawable floatingBar(android.view.View view) {
        GradientDrawable shape = capsule(background); view.setBackground(shape); view.setElevation(dp(4));
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            view.setOutlineAmbientShadowColor(0x24000000); view.setOutlineSpotShadowColor(0x32000000);
        }
        return shape;
    }

    ColorStateList enabledColors(int enabled, int disabled) {
        return new ColorStateList(new int[][] {{-android.R.attr.state_enabled}, {}}, new int[] {disabled, enabled});
    }

    ImageButton lineButton(String icon, String label, Runnable action) {
        ImageButton button = new ImageButton(context); button.setImageDrawable(new LineIcon(icon, ink));
        button.setContentDescription(label); button.setTooltipText(label); button.setPadding(dp(13), dp(13), dp(13), dp(13));
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(0x224176e6), capsule(background), capsule(Color.WHITE)));
        button.setOnClickListener(view -> action.run()); return button;
    }

    LinearLayout workspaceHeader(String title, String label, String tag, Runnable action) {
        LinearLayout header = new LinearLayout(context); header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(0, dp(12), 0, 0);
        TextView heading = new TextView(context); heading.setText(title); heading.setTextSize(14); heading.setTextColor(muted);
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        ImageButton create = lineButton("add", label, action); create.setTag(tag);
        create.setImageDrawable(new LineIcon("add", muted));
        header.addView(create, new LinearLayout.LayoutParams(dp(48), dp(48)));
        return header;
    }

    ImageButton backButton(String label, Runnable action) {
        boolean dark = (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        ImageButton button = new ImageButton(context); button.setImageDrawable(new LineIcon("back", ink));
        button.setContentDescription(label); button.setTooltipText(label); button.setTag("pageBack");
        button.setPadding(dp(14), dp(14), dp(14), dp(14)); button.setMinimumWidth(dp(48)); button.setMinimumHeight(dp(48));
        GradientDrawable face = new GradientDrawable(); face.setShape(GradientDrawable.OVAL);
        face.setColor(Color.parseColor(dark ? "#29292D" : "#FFFFFF"));
        face.setStroke(1, Color.parseColor(dark ? "#3A3A40" : "#F3F3F5"));
        GradientDrawable mask = new GradientDrawable(); mask.setShape(GradientDrawable.OVAL); mask.setColor(Color.WHITE);
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(dark ? 0x33ffffff : 0x14000000), face, mask));
        button.setElevation(dp(4));
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            button.setOutlineAmbientShadowColor(0x40000000); button.setOutlineSpotShadowColor(0x50000000);
        }
        android.animation.StateListAnimator states = new android.animation.StateListAnimator();
        android.animation.ObjectAnimator pressed = android.animation.ObjectAnimator.ofFloat(button, "translationZ", -dp(2)); pressed.setDuration(100);
        android.animation.ObjectAnimator resting = android.animation.ObjectAnimator.ofFloat(button, "translationZ", 0f); resting.setDuration(150);
        states.addState(new int[]{android.R.attr.state_pressed, android.R.attr.state_enabled}, pressed);
        states.addState(new int[]{}, resting); button.setStateListAnimator(states);
        button.setOnClickListener(view -> action.run()); return button;
    }

    ImageButton composerAction(String label, int icon, Runnable action) {
        ImageButton button = new ImageButton(context); button.setImageResource(icon);
        button.setContentDescription(label); button.setTooltipText(label); button.setPadding(dp(13), dp(13), dp(13), dp(13));
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(0x33ffffff), capsule(accent), capsule(Color.WHITE)));
        button.setBackgroundTintList(enabledColors(accent, surface)); button.setImageTintList(enabledColors(Color.WHITE, muted));
        button.setOnClickListener(view -> action.run()); return button;
    }

    LinearLayout messageBlock(boolean user) {
        LinearLayout block = new LinearLayout(context); block.setOrientation(LinearLayout.VERTICAL);
        block.setPadding(user ? dp(14) : 0, dp(8), user ? dp(14) : 0, dp(12));
        if (user) block.setBackground(rounded(surface));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(user ? -2 : -1, -2);
        params.gravity = user ? android.view.Gravity.END : android.view.Gravity.START;
        params.setMargins(user ? dp(44) : 0, dp(6), 0, dp(16)); block.setLayoutParams(params);
        return block;
    }

    void messageTypography(TextView view) { view.setLineSpacing(dp(7), 1); }

    LinearLayout messageWithFooter(LinearLayout block, boolean user, Supplier<String> content, long at, boolean chinese) {
        LinearLayout wrapper = new LinearLayout(context); wrapper.setOrientation(LinearLayout.VERTICAL);
        wrapper.setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams bubbleParams = (LinearLayout.LayoutParams) block.getLayoutParams();
        bubbleParams.bottomMargin = 0; wrapper.addView(block);
        LinearLayout footer = new LinearLayout(context); footer.setGravity(Gravity.CENTER_VERTICAL);
        footer.setTag("messageFooter");
        LinearLayout.LayoutParams footerParams = new LinearLayout.LayoutParams(-2, dp(48));
        footerParams.gravity = user ? Gravity.END : Gravity.START; footerParams.bottomMargin = dp(18);
        String label = chinese ? "复制消息" : "Copy message";
        ImageButton copy = lineButton("copy", label, () -> {
            String value = content.get();
            if (value == null || value.isEmpty()) return;
            ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(ClipData.newPlainText(label, value));
            if (android.os.Build.VERSION.SDK_INT < 33) Toast.makeText(context, chinese ? "已复制" : "Copied", Toast.LENGTH_SHORT).show();
        });
        copy.setImageDrawable(new LineIcon("copy", muted)); copy.setTag("copyMessage");
        copy.setPadding(dp(16), dp(16), dp(16), dp(16));
        footer.addView(copy, new LinearLayout.LayoutParams(dp(48), dp(48)));
        if (at > 0) {
            TextView time = new TextView(context); time.setTextColor(muted); time.setTextSize(12);
            time.setTag("messageTimestamp");
            time.setText(new SimpleDateFormat(chinese ? "M月d日 HH:mm" : "MMM d, HH:mm", chinese ? Locale.CHINA : Locale.ENGLISH).format(new Date(at)));
            footer.addView(time);
        }
        wrapper.addView(footer, footerParams); return wrapper;
    }
}
