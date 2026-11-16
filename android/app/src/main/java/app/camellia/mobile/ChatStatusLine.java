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
    private Runnable retry, workAction;

    ChatStatusLine(TextView view, ChatStyle style, boolean chinese) {
        this.view = view; this.chinese = chinese; muted = style.muted;
        error = new SettingsStyle(view.getContext()).error;
        style.dockStatus(view); view.setVisibility(View.VISIBLE);
        view.setOnClickListener(v -> {
            long now = SystemClock.uptimeMillis();
            String details = state.text(now);
            if (retry != null) {
                CamelliaDialog.Builder builder = new CamelliaDialog.Builder(view.getContext())
                    .setTitle(chinese ? "状态与操作详情" : "Status and action details").setMessage(details)
                    .setPositiveButton(chinese ? "重试同一请求" : "Retry same request", (dialog, which) -> { if (retry != null) retry.run(); })
                    .setNegativeButton(chinese ? "关闭" : "Close", null);
                if (workAction != null) builder.setNeutralButton(chinese ? "工作状态" : "Work status",
                    (detailsDialog, which) -> { if (workAction != null) workAction.run(); });
                builder.show();
            } else if (workAction != null && state.showsWork(now)) {
                workAction.run();
            } else {
                ErrorDetails.show(view.getContext(), chinese, details); clear();
            }
        });
        view.setFocusable(true);
    }

    void work(String value) { work(value, null); }
    void work(String value, Runnable action) { state.work(value); workAction = action; render(); }
    void notice(String value) {
        state.notice(value, SystemClock.uptimeMillis()); render();
        handler.removeCallbacks(refresh); handler.postDelayed(refresh, 4000);
    }
    void error(String value, boolean connection) { state.error(value, connection); render(); }
    void reconnected() { state.reconnected(); render(); }
    void clear() { state.clear(); handler.removeCallbacks(refresh); render(); }
    void retry(Runnable action) { retry = action; render(); }
    void close() { handler.removeCallbacksAndMessages(null); retry = null; workAction = null; }

    private void render() {
        long now = SystemClock.uptimeMillis();
        String value = state.text(now);
        boolean opensWork = workAction != null && retry == null && state.showsWork(now);
        String display = value + (opensWork ? "  ›" : "");
        if (!view.getText().toString().equals(display)) view.setText(display);
        view.setContentDescription(value + (opensWork ? (chinese ? "。点按查看工作状态" : ". Tap to view work status.") : ""));
        view.setTextColor(state.isError() ? error : muted);
        view.setVisibility(View.VISIBLE);
    }
}
