package app.camellia.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.ViewTreeObserver;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.MediaController;
import android.widget.TextView;
import android.widget.VideoView;
import java.io.File;

@android.annotation.SuppressLint("ViewConstructor")
final class InlineVideoView extends FrameLayout {
    private final Context context;
    private final String alt, reference;
    private final int ink, surface;
    private final MarkdownView.ImageLoader loader;
    private final boolean chinese;
    private TextView card;
    private TextView caption;
    private FrameLayout preview;
    private ImageView posterImage;
    private Bitmap poster;
    private VideoView video;
    private boolean loading;
    private boolean posterRequested;
    private int posterGeneration;
    private float aspectRatio = 16f / 9f;
    private final Rect visibleBounds = new Rect();
    private final ViewTreeObserver.OnPreDrawListener posterVisibility = () -> {
        requestVisiblePoster();
        return true;
    };

    InlineVideoView(Context context, String alt, String reference, int ink, int surface,
                    MarkdownView.ImageLoader loader) {
        super(context);
        this.context = context; this.alt = alt; this.reference = reference;
        this.ink = ink; this.surface = surface; this.loader = loader;
        chinese = context.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        setTag("markdownInlineVideo"); setContentDescription(alt); setPadding(0, dp(4), 0, dp(10));
        showCard(false);
    }

    private int dp(float value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
    private String tr(String zh, String en) { return chinese ? zh : en; }

    private GradientDrawable cardBackground() {
        GradientDrawable background = new GradientDrawable();
        background.setColor(surface);
        background.setCornerRadius(dp(12));
        background.setStroke(dp(1), (ink & 0x00ffffff) | 0x24000000);
        return background;
    }

    private void showCard(boolean retry) {
        removeAllViews();
        preview = new FrameLayout(context);
        preview.setBackground(cardBackground());
        preview.setClipToOutline(true);
        preview.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        preview.setOnClickListener(view -> start());
        posterImage = new ImageView(context);
        posterImage.setTag("markdownInlineVideoPoster");
        posterImage.setScaleType(ImageView.ScaleType.FIT_CENTER);
        posterImage.setBackgroundColor(Color.rgb(16, 20, 28));
        posterImage.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        if (poster != null) posterImage.setImageBitmap(poster);
        preview.addView(posterImage, new FrameLayout.LayoutParams(-1, -1));

        caption = new TextView(context);
        caption.setTag("markdownInlineVideoCaption");
        caption.setText(alt);
        caption.setTextColor(Color.WHITE); caption.setTextSize(13);
        caption.setMaxLines(3); caption.setEllipsize(android.text.TextUtils.TruncateAt.END);
        caption.setPadding(dp(12), dp(22), dp(12), dp(12));
        caption.setBackground(new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP,
            new int[] { 0xe6000000, Color.TRANSPARENT }));
        caption.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        preview.addView(caption, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));

        card = new TextView(context);
        card.setTag("markdownInlineVideoCard");
        card.setText(retry ? "↻" : "▶");
        card.setTextColor(Color.WHITE); card.setTextSize(27); card.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        card.setGravity(Gravity.CENTER); card.setIncludeFontPadding(false);
        card.setPadding(dp(retry ? 0 : 4), 0, 0, 0);
        GradientDrawable disc = new GradientDrawable(); disc.setColor(0xb8000000); disc.setCornerRadius(dp(999));
        GradientDrawable mask = new GradientDrawable(); mask.setColor(Color.WHITE); mask.setCornerRadius(dp(999));
        card.setBackground(new android.graphics.drawable.RippleDrawable(
            android.content.res.ColorStateList.valueOf(0x44ffffff), disc, mask));
        card.setFocusable(true); card.setClickable(true);
        card.setContentDescription(alt + " · " + (retry ? tr("重试视频", "Retry video") : tr("播放视频", "Play video")));
        card.setOnClickListener(view -> start());
        preview.addView(card, new FrameLayout.LayoutParams(dp(64), dp(64), Gravity.CENTER));
        addView(preview, new FrameLayout.LayoutParams(-1, dp(190)));
    }

    private void requestVisiblePoster() {
        if (posterRequested || video != null || !isAttachedToWindow() || getWidth() <= 0 || !getGlobalVisibleRect(visibleBounds)) return;
        posterRequested = true;
        removePosterVisibilityListener();
        int ticket = posterGeneration;
        loader.loadVideoPoster(reference, new MarkdownView.ImageCallback() {
            @Override public void loaded(Bitmap bitmap) {
                if (ticket != posterGeneration || bitmap == null) return;
                poster = bitmap;
                aspectRatio = bitmap.getWidth() / (float) bitmap.getHeight();
                if (video == null && posterImage != null) posterImage.setImageBitmap(bitmap);
                requestLayout();
            }
            @Override public void failed() { }
        });
    }

    private void removePosterVisibilityListener() {
        if (getViewTreeObserver().isAlive()) getViewTreeObserver().removeOnPreDrawListener(posterVisibility);
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (!posterRequested) {
            getViewTreeObserver().addOnPreDrawListener(posterVisibility);
            post(this::requestVisiblePoster);
        }
    }

    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        int width = MeasureSpec.getSize(widthSpec) - getPaddingLeft() - getPaddingRight();
        int height = Math.max(dp(170), Math.min(dp(360), Math.round(width / aspectRatio)));
        if (preview != null && preview.getParent() == this) preview.getLayoutParams().height = height;
        if (video != null && video.getParent() == this) video.getLayoutParams().height = height;
        super.onMeasure(widthSpec, heightSpec);
    }

    private void start() {
        if (loading) return;
        loading = true;
        if (card != null) {
            caption.setText(alt + "\n" + tr("正在加载视频…", "Loading video…"));
            card.setText("…");
            card.setEnabled(false);
        }
        loader.loadVideo(reference, new MarkdownView.VideoCallback() {
            @Override public void loaded(File file) { play(file); }
            @Override public void failed() { unavailable(tr("视频下载失败，请检查连接后重试。", "Video download failed. Check the connection and retry.")); }
            @Override public void failed(String reason) { unavailable(reason); }
        });
    }

    private void play(File file) {
        loading = false;
        if (file == null || !file.isFile()) { unavailable(tr("下载的视频文件已不存在，请重试。", "The downloaded video file is no longer available. Retry the download.")); return; }
        removeAllViews();
        video = new VideoView(context);
        video.setTag("markdownInlineVideoView");
        video.setContentDescription(alt);
        MediaController controller = new MediaController(context);
        controller.setAnchorView(video);
        video.setMediaController(controller);
        video.setVideoPath(file.getAbsolutePath());
        video.setOnPreparedListener(player -> {
            player.setLooping(false);
            if (video != null && isAttachedToWindow()) video.start();
        });
        video.setOnErrorListener((player, what, extra) -> {
            android.util.Log.w("CamelliaInlineVideo", "Playback failed: " + what + "/" + extra);
            post(() -> unavailable(extra == android.media.MediaPlayer.MEDIA_ERROR_UNSUPPORTED || extra == android.media.MediaPlayer.MEDIA_ERROR_MALFORMED
                ? tr("设备不支持此视频编码或文件已损坏，可下载后用其他播放器打开。", "This video encoding is unsupported or the file is damaged. Download it and try another player.")
                : tr("视频已下载，但播放器无法打开，可下载后用其他播放器重试。", "The video was downloaded, but the player could not open it. Try downloading it and using another player.")));
            return true;
        });
        int width = context.getResources().getDisplayMetrics().widthPixels;
        int height = Math.max(dp(170), Math.min(dp(360), Math.round(width * 9f / 16f)));
        addView(video, new FrameLayout.LayoutParams(-1, height));
        video.requestFocus();
    }

    private void unavailable(String reason) {
        loading = false;
        if (video != null) {
            video.stopPlayback();
            video = null;
        }
        showCard(true);
        if (card != null) {
            String message = reason == null || reason.isEmpty() ? tr("无法播放视频", "Video unavailable") : reason;
            caption.setText(alt + "\n" + message);
            card.setContentDescription(alt + " · " + message + " · " + tr("点击重试", "Tap to retry"));
        }
    }

    @Override protected void onDetachedFromWindow() {
        removePosterVisibilityListener();
        posterGeneration++;
        if (poster == null) posterRequested = false;
        if (video != null) video.stopPlayback();
        super.onDetachedFromWindow();
    }
}
