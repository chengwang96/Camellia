package app.camellia.mobile;

import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.widget.FrameLayout;
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
    private VideoView video;
    private boolean loading;

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
        card = new TextView(context);
        card.setTag("markdownInlineVideoCard");
        card.setText("▶  " + alt + "\n" + (retry
            ? tr("点击重试", "Tap to retry")
            : tr("点击在对话中播放视频", "Tap to play video")));
        card.setTextColor(ink); card.setTextSize(15); card.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        card.setGravity(Gravity.CENTER); card.setLineSpacing(dp(6), 1);
        card.setMinHeight(dp(190)); card.setPadding(dp(18), dp(18), dp(18), dp(18));
        card.setBackground(cardBackground());
        card.setFocusable(true); card.setClickable(true);
        card.setContentDescription(alt + " · " + (retry ? tr("重试视频", "Retry video") : tr("播放视频", "Play video")));
        card.setOnClickListener(view -> start());
        addView(card, new FrameLayout.LayoutParams(-1, -2));
    }

    private void start() {
        if (loading) return;
        loading = true;
        if (card != null) {
            card.setText("▶  " + alt + "\n" + tr("正在下载视频…", "Downloading video…"));
            card.setEnabled(false);
        }
        loader.loadVideo(reference, new MarkdownView.VideoCallback() {
            @Override public void loaded(File file) { play(file); }
            @Override public void failed() { unavailable(); }
        });
    }

    private void play(File file) {
        loading = false;
        if (file == null || !file.isFile()) { unavailable(); return; }
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
            post(this::unavailable);
            return true;
        });
        int width = context.getResources().getDisplayMetrics().widthPixels;
        int height = Math.max(dp(170), Math.min(dp(360), Math.round(width * 9f / 16f)));
        addView(video, new FrameLayout.LayoutParams(-1, height));
        video.requestFocus();
    }

    private void unavailable() {
        loading = false;
        if (video != null) {
            video.stopPlayback();
            video = null;
        }
        showCard(true);
        if (card != null) card.setText("▶  " + alt + "\n" + tr("无法播放视频，点击重试", "Video unavailable. Tap to retry."));
    }

    @Override protected void onDetachedFromWindow() {
        if (video != null) video.stopPlayback();
        super.onDetachedFromWindow();
    }
}
