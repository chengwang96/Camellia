package app.camellia.mobile;

import android.app.Activity;
import android.content.Context;
import android.graphics.Bitmap;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;

@android.annotation.SuppressLint("ViewConstructor")
final class InlineImageView extends FrameLayout {
    private final Context context;
    private final String alt, reference;
    private final MarkdownView.ImageLoader loader;
    private Bitmap bitmap;

    InlineImageView(Context context, String alt, String reference, int ink, MarkdownView.ImageLoader loader) {
        super(context); this.context = context; this.alt = alt; this.reference = reference; this.loader = loader;
        setTag("markdownInlineImage"); setContentDescription(alt); setPadding(0, dp(4), 0, dp(10)); setMinimumHeight(dp(48));
        TextView fallback = new TextView(context); fallback.setTag("markdownInlineImageFallback");
        fallback.setText(context.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh") ? "[图片：" + alt + "]" : "[Image: " + alt + "]");
        fallback.setTextColor(ink); fallback.setTextSize(15); fallback.setLineSpacing(dp(7), 1);
        addView(fallback, new FrameLayout.LayoutParams(-1, -2));
        load(new MarkdownView.ImageCallback() {
            @Override public void loaded(Bitmap value) { show(value); }
            @Override public void failed() { }
        });
    }

    private int dp(float value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }

    void show(Bitmap value) {
        if (bitmap != null) return;
        bitmap = value; removeAllViews();
        ImageView image = new ImageView(context); image.setTag("markdownInlineImageBitmap");
        image.setImageBitmap(value); image.setAdjustViewBounds(true); image.setScaleType(ImageView.ScaleType.FIT_CENTER);
        image.setMaxHeight(dp(480)); image.setContentDescription(alt); image.setCropToPadding(false);
        addView(image, new FrameLayout.LayoutParams(-1, -2));
        OnClickListener open = view -> preview();
        setOnClickListener(open); image.setOnClickListener(open); setClickable(true); setFocusable(true);
    }

    Bitmap bitmap() { return bitmap; }
    String alt() { return alt; }
    void load(MarkdownView.ImageCallback callback) { loader.load(reference, callback); }

    private void preview() {
        if (bitmap == null || !(context instanceof Activity)) return;
        InlineImageGallery.show((Activity) context, this);
    }
}
