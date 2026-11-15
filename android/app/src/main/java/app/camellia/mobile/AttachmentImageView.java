package app.camellia.mobile;

import android.app.Activity;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;

/** A compact sent-image tile; opening the gallery requests its larger image, not the thumbnail. */
@android.annotation.SuppressLint("ViewConstructor")
final class AttachmentImageView extends FrameLayout implements InlineImageGallery.ImageSource {
    private final String name;
    private final AttachmentImages.Source source;

    AttachmentImageView(Context context, ChatStyle style, String name, AttachmentImages.Source source, boolean caption) {
        super(context); this.name = name; this.source = source;
        setContentDescription(name); setClickable(true); setFocusable(true); setClipToOutline(true);
        GradientDrawable background = style.rounded(style.surface); background.setCornerRadius(dp(14)); setBackground(background);
        ImageView preview = new ImageView(context); preview.setTag("attachmentImagePreview");
        preview.setImageDrawable(new LineIcon("image", style.muted)); preview.setScaleType(ImageView.ScaleType.FIT_CENTER);
        preview.setPadding(dp(24), dp(24), dp(24), dp(24));
        addView(preview, new LayoutParams(-1, -1));
        if (caption) {
            TextView label = new TextView(context); label.setText(name); label.setTextColor(Color.WHITE); label.setTextSize(9);
            label.setMaxLines(1); label.setEllipsize(TextUtils.TruncateAt.MIDDLE); label.setPadding(dp(4), dp(2), dp(4), dp(2));
            label.setBackgroundColor(0x99000000); addView(label, new LayoutParams(-1, -2, Gravity.BOTTOM));
        }
        setOnClickListener(view -> { if (context instanceof Activity activity) InlineImageGallery.show(activity, this); });
        source.preview(new MarkdownView.ImageCallback() {
            @Override public void loaded(Bitmap bitmap) { preview.setPadding(0, 0, 0, 0); preview.setImageBitmap(bitmap); }
            @Override public void failed() { }
        });
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    @Override public Bitmap bitmap() { return source.bitmap(); }
    @Override public String alt() { return name; }
    @Override public void load(MarkdownView.ImageCallback callback) { source.load(callback); }
}
