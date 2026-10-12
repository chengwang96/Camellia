package app.camellia.mobile;

import android.app.Activity;
import android.app.Dialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import org.json.JSONObject;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.function.Supplier;

final class ConnectionTestDialog implements AutoCloseable {
    private final Activity activity;
    private final boolean chinese;
    private final String name, address, token;
    private final SettingsStyle style;
    private final Supplier<ConnectionStabilityCheck.Transport> transport;
    private final ConnectionStabilityCheck.Config config;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final TextView status, details, hint;
    private final ProgressBar progress;
    private final CamelliaDialog dialog;
    private ConnectionStabilityCheck check;
    private int generation;
    private boolean closed;
    private String report, started, initialNetwork;

    ConnectionTestDialog(Activity activity, JSONObject computer, boolean chinese) {
        this(activity, computer, chinese, null, ConnectionStabilityCheck.DEFAULT);
    }

    ConnectionTestDialog(Activity activity, JSONObject computer, boolean chinese,
            Supplier<ConnectionStabilityCheck.Transport> transport, ConnectionStabilityCheck.Config config) {
        this.activity = activity; this.chinese = chinese; this.config = config;
        name = computer.optString("computerName", tr("电脑", "Computer"));
        address = computer.optString("address"); token = computer.optString("token");
        this.transport = transport == null ? this::transport : transport;
        style = new SettingsStyle(activity);
        LinearLayout content = new LinearLayout(activity); content.setOrientation(LinearLayout.VERTICAL);
        content.setTag("connectionTest"); content.setPadding(style.dp(8), 0, style.dp(8), 0);
        TextView computerName = style.label(name, Palette.TEXT_ROW_STRONG, style.ink); content.addView(computerName);
        hint = style.label(tr("持续约 30 秒，检查请求响应和实时连接。", "About 30 seconds. Checks responses and the live connection."), Palette.TEXT_NOTE, style.secondary);
        hint.setPadding(0, style.dp(6), 0, style.dp(16)); content.addView(hint);
        progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        progress.setTag("connectionTestProgress"); progress.setMax(100); content.addView(progress, new LinearLayout.LayoutParams(-1, style.dp(8)));
        status = style.label("", Palette.TEXT_BODY, style.secondary); status.setTag("connectionTestStatus");
        status.setPadding(0, style.dp(12), 0, style.dp(12)); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); content.addView(status);
        details = style.label("", Palette.TEXT_NOTE, style.ink); details.setTag("connectionTestReport"); details.setTextIsSelectable(true);
        details.setPadding(style.dp(14), style.dp(12), style.dp(14), style.dp(12)); details.setBackground(style.cardBackground()); content.addView(details);
        dialog = new CamelliaDialog.Builder(activity).setTitle(tr("连接稳定性测试", "Connection stability test")).setView(content)
            .setPositiveButton(tr("复制报告", "Copy report"), null)
            .setNegativeButton(tr("取消", "Cancel"), null)
            .setNeutralButton(tr("重新测试", "Test again"), null).create();
        dialog.setOnDismissListener(ignored -> stop());
    }

    CamelliaDialog show() {
        dialog.show(); dialog.getButton(Dialog.BUTTON_POSITIVE).setOnClickListener(view -> copy());
        dialog.getButton(Dialog.BUTTON_NEUTRAL).setOnClickListener(view -> start());
        start(); return dialog;
    }

    private ConnectionStabilityCheck.Transport transport() {
        RemoteApi requests = new RemoteApi(activity, address), events = new RemoteApi(activity, address);
        return new ConnectionStabilityCheck.Transport() {
            @Override public JSONObject status() throws Exception { return requests.json("/v1/status", token, null); }
            @Override public void events(ConnectionStabilityCheck.Events listener) throws Exception {
                events.listEvents(token, listener::snapshot, listener::heartbeat);
            }
            @Override public void close() { try { requests.cancel(); } finally { events.cancel(); } }
        };
    }

    private void start() {
        if (closed || !dialog.isShowing()) return;
        if (check != null) check.close();
        int ticket = ++generation; report = null;
        started = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss Z", Locale.ROOT).format(new Date()); initialNetwork = network();
        title(tr("连接稳定性测试", "Connection stability test"), style.ink);
        details.setVisibility(View.GONE); hint.setVisibility(View.VISIBLE); progress.setVisibility(View.VISIBLE); progress.setProgress(0);
        status.setText(tr("正在连接手机与电脑…", "Connecting phone and computer…")); status.setTextColor(style.secondary);
        dialog.getButton(Dialog.BUTTON_POSITIVE).setVisibility(View.GONE);
        dialog.getButton(Dialog.BUTTON_POSITIVE).setText(tr("复制报告", "Copy report"));
        dialog.getButton(Dialog.BUTTON_NEUTRAL).setVisibility(View.GONE);
        dialog.getButton(Dialog.BUTTON_NEGATIVE).setText(tr("取消", "Cancel"));
        dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        resize();
        try {
            check = new ConnectionStabilityCheck(transport.get(), config, new ConnectionStabilityCheck.Listener() {
                @Override public void progress(ConnectionStabilityCheck.Snapshot value) { deliver(ticket, () -> update(value)); }
                @Override public void complete(ConnectionStabilityCheck.Snapshot value) { deliver(ticket, () -> ConnectionTestDialog.this.complete(value)); }
            });
            check.start();
        } catch (Exception error) {
            ConnectionStabilityCheck.State state = new ConnectionStabilityCheck.State(config, 0);
            state.fail(ConnectionStabilityCheck.Issue.REQUEST_ERROR, error); complete(state.snapshot(0));
        }
    }

    private void deliver(int ticket, Runnable action) {
        handler.post(() -> { if (!closed && ticket == generation && dialog.isShowing() && !activity.isFinishing() && !activity.isDestroyed()) action.run(); });
    }
    private void update(ConnectionStabilityCheck.Snapshot value) {
        progress.setProgress((int) Math.min(100, value.elapsed * 100 / value.duration));
        String text = Math.min(value.elapsed, value.duration) / 1000 + " / " + value.duration / 1000 + tr(" 秒", " s")
            + "\n" + tr("请求成功：", "Successful requests: ") + value.successes + tr(" · 心跳：", " · Heartbeats: ") + value.heartbeats;
        if (!status.getText().toString().equals(text)) status.setText(text);
    }
    private void complete(ConnectionStabilityCheck.Snapshot value) {
        boolean failed = value.issue != null;
        title(failed ? tr("连接稳定性异常", "Connection stability issue") : tr("测试完成", "Test complete"), failed ? style.error : style.ink);
        status.setText(failed ? reason(value) : tr("本次测试未发现连接异常。", "No connection issues detected during this test."));
        status.setTextColor(failed ? style.error : style.secondary);
        report = report(value); details.setText(report); details.setVisibility(View.VISIBLE); hint.setVisibility(View.GONE); progress.setVisibility(View.GONE);
        dialog.getButton(Dialog.BUTTON_POSITIVE).setVisibility(View.VISIBLE);
        dialog.getButton(Dialog.BUTTON_NEUTRAL).setVisibility(View.VISIBLE);
        dialog.getButton(Dialog.BUTTON_NEGATIVE).setText(tr("关闭", "Close"));
        dialog.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); resize();
    }
    private String reason(ConnectionStabilityCheck.Snapshot value) {
        String message = switch (value.issue) {
            case REQUEST_ERROR -> tr("请求失败：", "Request failed: ") + RemoteApi.failureMessage(value.error, chinese);
            case STREAM_ERROR -> tr("实时连接中断：", "Live connection interrupted: ") + RemoteApi.failureMessage(value.error, chinese);
            case REQUEST_TIMEOUT -> tr("电脑响应超时（5 秒）。", "Desktop response timed out (5 seconds).");
            case STREAM_TIMEOUT -> tr("实时连接建立超时（10 秒）。", "Live connection did not open within 10 seconds.");
            case HEARTBEAT_TIMEOUT -> tr("实时连接超过 15 秒没有收到心跳或更新。", "No heartbeat or update received for over 15 seconds.");
            case DESKTOP_CHANGED -> tr("电脑服务标识发生变化，可能重启或重置了连接。", "Desktop service identity changed, possibly due to a restart or connection reset.");
            case HIGH_LATENCY -> tr("多次高延迟：至少 3 次请求达到 2 秒。", "Repeated high latency: at least 3 requests took 2 seconds or longer.");
            case INVALID_RESPONSE -> tr("电脑响应不完整或远程协议不匹配。", "Desktop response is incomplete or uses an unexpected remote protocol.");
        };
        return sanitize(message);
    }
    private String report(ConnectionStabilityCheck.Snapshot value) {
        StringBuilder text = new StringBuilder(tr("Camellia 连接稳定性测试", "Camellia connection stability test"));
        text.append('\n').append(tr("电脑：", "Computer: ")).append(name).append("\n").append(tr("地址：", "Address: ")).append(address);
        text.append('\n').append(tr("手机：", "Phone: ")).append(android.os.Build.MANUFACTURER).append(' ').append(android.os.Build.MODEL)
            .append(" · Android ").append(android.os.Build.VERSION.RELEASE).append(" · Camellia ").append(version());
        text.append('\n').append(tr("开始：", "Started: ")).append(started).append('\n').append(tr("耗时：", "Elapsed: ")).append(value.elapsed).append(" ms");
        text.append('\n').append(tr("手机网络：", "Phone network: ")).append(initialNetwork).append(" → ").append(network());
        text.append('\n').append(tr("连接方式：", "Transport: ")).append(EmbeddedNetwork.enabled() ? tr("内置 Tailscale", "Built-in Tailscale") : tr("系统网络", "System network"));
        text.append('\n').append(tr("结果：", "Result: ")).append(value.issue == null ? tr("测试期间未发现异常", "No issues during the test") : reason(value));
        if (value.issue != null) text.append('\n').append(tr("错误代码：", "Error code: ")).append(value.issue);
        text.append('\n').append(tr("请求：", "Requests: ")).append(value.successes).append('/').append(value.attempts)
            .append(tr(" 成功，失败 ", " successful, failed ")).append(value.failures);
        text.append('\n').append(tr("延迟（最低 / 平均 / 最高）：", "Latency (min / mean / max): "));
        text.append(value.successes == 0 ? tr("无有效样本", "No completed samples") : value.minimum + " / " + value.average + " / " + value.maximum + " ms");
        text.append('\n').append(tr("相邻请求平均抖动：", "Mean successive request jitter: ")).append(value.jitter).append(" ms");
        text.append('\n').append(tr("实时连接：", "Live connection: ")).append(value.streamConnected ? tr("已建立", "Opened") : tr("未建立", "Not opened"))
            .append(tr("，心跳 ", ", heartbeats ")).append(value.heartbeats).append(tr("，更新 ", ", updates ")).append(value.snapshots);
        text.append("\nGET /v1/status\nSSE /v1/conversations/events");
        if (value.error != null) text.append('\n').append(tr("错误详情：", "Error details: ")).append(ErrorDetails.describe(value.error));
        return sanitize(text.toString());
    }
    private String sanitize(String text) {
        if (!token.isEmpty()) text = text.replace(token, "[redacted]");
        return ErrorDetails.limit(text.replaceAll("(?i)Bearer\\s+[^\\s\"',;]+", "Bearer [redacted]")
            .replaceAll("\\b[A-Za-z0-9_-]{43}\\b", "[redacted]").replaceAll("(?i)\\bsk-[A-Za-z0-9_-]+", "[redacted]"));
    }
    private String network() {
        ConnectivityManager manager = (ConnectivityManager) activity.getSystemService(Context.CONNECTIVITY_SERVICE);
        NetworkCapabilities value = manager == null ? null : manager.getNetworkCapabilities(manager.getActiveNetwork());
        if (value == null) return tr("离线", "Offline");
        java.util.List<String> names = new java.util.ArrayList<>();
        if (value.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) names.add("Wi-Fi");
        if (value.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) names.add(tr("移动网络", "Cellular"));
        if (value.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) names.add(tr("以太网", "Ethernet"));
        if (value.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) names.add("VPN");
        return names.isEmpty() ? tr("其他网络", "Other network") : String.join(" / ", names);
    }
    private String version() {
        try { return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName; }
        catch (android.content.pm.PackageManager.NameNotFoundException ignored) { return "?"; }
    }
    private void copy() {
        if (report == null) return;
        ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("Camellia connection test", report));
            dialog.getButton(Dialog.BUTTON_POSITIVE).setText(tr("已复制", "Copied"));
        }
    }
    private void title(String value, int color) {
        TextView heading = dialog.getWindow().getDecorView().findViewWithTag("camelliaDialogTitle"); heading.setText(value); heading.setTextColor(color);
    }
    private void resize() {
        LinearLayout panel = dialog.getWindow().getDecorView().findViewWithTag("camelliaDialog");
        Runnable layout = () -> {
            if (closed || !dialog.isShowing()) return;
            // A quick failure can arrive before the first dialog layout. The activity's
            // visible frame stays full-sized when this sheet changes from progress to report.
            android.graphics.Rect visible = new android.graphics.Rect();
            activity.getWindow().getDecorView().getWindowVisibleDisplayFrame(visible);
            int availableWidth = visible.width() > 0 ? visible.width() : activity.getResources().getDisplayMetrics().widthPixels;
            int availableHeight = visible.height() > 0 ? visible.height() : activity.getResources().getDisplayMetrics().heightPixels;
            int width = Math.min(style.dp(560), availableWidth - style.dp(24));
            int limit = Math.max(style.dp(160), availableHeight - style.dp(32));
            // Reports are scrollable. Fix their viewport before Android measures newly
            // visible text, rather than reusing the compact progress sheet's cached height.
            if (report != null) { dialog.getWindow().setLayout(width, limit); return; }
            panel.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(limit, View.MeasureSpec.AT_MOST));
            dialog.getWindow().setLayout(width, Math.min(limit, panel.getMeasuredHeight()));
        };
        panel.setOnApplyWindowInsetsListener((view, insets) -> { view.post(layout); return insets; });
        panel.post(layout);
    }
    private String tr(String zh, String en) { return chinese ? zh : en; }
    private void stop() { closed = true; generation++; handler.removeCallbacksAndMessages(null); if (check != null) check.close(); }
    @Override public void close() { stop(); if (dialog.isShowing()) dialog.dismiss(); }
}
