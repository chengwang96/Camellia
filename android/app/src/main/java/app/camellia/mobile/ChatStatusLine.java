package app.camellia.mobile;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.widget.TextView;

/** A stable, single-line footer shared by remote chat and discussions. */
final class ChatStatusLine {
    private final TextView view;
    private final ChatStatusState state = new ChatStatusState();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final boolean chinese;
    private final int muted, error;
    private final Runnable refresh = this::render;
    private Runnable retry;

    ChatStatusLine(TextView view, ChatStyle style, boolean chinese) {
        this.view = view; this.chinese = chinese; muted = style.muted;
        error = new SettingsStyle(view.getContext()).error;
        style.dockStatus(view); view.setVisibility(View.VISIBLE);
        view.setOnClickListener(v -> {
            String details = state.text(SystemClock.uptimeMillis());
            if (retry != null) {
                new CamelliaDialog.Builder(view.getContext())
                    .setTitle(chinese ? "状态与操作详情" : "Status and action details").setMessage(details)
                    .setPositiveButton(chinese ? "重试同一请求" : "Retry same request", (dialog, which) -> { if (retry != null) retry.run(); })
                    .setNegativeButton(chinese ? "关闭" : "Close", null).show();
            } else {
                ErrorDetails.show(view.getContext(), chinese, details); clear();
            }
        });
        view.setFocusable(true);
    }

    void work(String value) { state.work(value); render(); }
    void notice(String value) {
        state.notice(value, SystemClock.uptimeMillis()); render();
        handler.removeCallbacks(refresh); handler.postDelayed(refresh, 4000);
    }
    void error(String value, boolean connection) { state.error(value, connection); render(); }
    void reconnected() { state.reconnected(); render(); }
    void clear() { state.clear(); handler.removeCallbacks(refresh); render(); }
    void retry(Runnable action) { retry = action; }
    void close() { handler.removeCallbacksAndMessages(null); retry = null; }

    private void render() {
        String value = state.text(SystemClock.uptimeMillis());
        if (!view.getText().toString().equals(value)) view.setText(value);
        view.setTextColor(state.isError() ? error : muted);
        view.setVisibility(View.VISIBLE);
    }
}
