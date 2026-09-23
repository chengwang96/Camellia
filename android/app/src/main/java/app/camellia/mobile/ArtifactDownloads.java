package app.camellia.mobile;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class ArtifactDownloads {
    static final int SAVE_REQUEST = 704;
    private final Activity activity;
    private final ChatStyle style;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final boolean chinese;
    private RemoteApi client;
    private ArtifactSheet dialog;
    private JSONObject pending;
    private int generation;

    ArtifactDownloads(Activity activity, Bundle saved) {
        this.activity = activity;
        style = new ChatStyle(activity);
        chinese = activity.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
        try { if (saved != null && saved.containsKey("artifactSave")) pending = new JSONObject(saved.getString("artifactSave")); }
        catch (Exception ignored) { pending = null; }
    }

    private String tr(String zh, String en) { return chinese ? zh : en; }
    void save(Bundle saved) { if (pending != null) saved.putString("artifactSave", pending.toString()); }

    private TextView label(String value, int size) {
        TextView label = new TextView(activity); label.setText(value); label.setTextSize(size); label.setTextColor(style.ink);
        label.setPadding(style.dp(8), style.dp(10), style.dp(8), style.dp(10)); return label;
    }

    void show(String address, String token, String conversation) {
        stop();
        int ticket = generation;
        RemoteApi request = new RemoteApi(address); client = request;
        dialog = new ArtifactSheet(activity, tr("会话产物", "Conversation files"), tr("电脑上的成果，随身带走。", "Take your work with you."));
        ArtifactSheet sheet = dialog;
        if (!ArtifactDownloadService.snapshot().phase.equals("idle")) {
            LinearLayout task = sheet.style.group(sheet.content, tr("下载任务", "Download"));
            sheet.style.action(task, ArtifactDownloadService.snapshot().name, tr("查看进度与结果", "View progress and result"), "artifactCurrentTask", false, this::showProgress);
        }
        TextView status = label(tr("正在读取产物…", "Loading files…"), 13); status.setTextColor(sheet.style.secondary); sheet.content.addView(status);
        LinearLayout rows = sheet.column(); sheet.content.addView(rows);
        TextView more = sheet.action(tr("加载更多", "Load more"), false, () -> {}); more.setVisibility(View.GONE); sheet.content.addView(more);
        sheet.actions.addView(sheet.action(tr("完成", "Done"), false, sheet::dismiss));
        dialog.setOnDismissListener(ignored -> { if (ticket == generation) { request.cancel(); client = null; generation++; } });
        dialog.show();
        loadPage(request, address, token, conversation, 0, ticket, rows, status, more);
    }

    private void loadPage(RemoteApi request, String address, String token, String conversation, long offset, int ticket,
                          LinearLayout rows, TextView status, TextView more) {
        more.setEnabled(false);
        worker.submit(() -> {
            try {
                JSONObject result = request.json("/v1/conversations/" + conversation + "/artifacts?offset=" + offset, token, null);
                JSONArray files = result.getJSONArray("artifacts");
                handler.post(() -> {
                    if (ticket != generation || activity.isDestroyed()) return;
                    for (int index = 0; index < files.length(); index++) {
                        JSONObject file = files.optJSONObject(index);
                        if (file == null) continue;
                        ArtifactSheet sheet = dialog;
                        LinearLayout row = sheet.style.group(rows, ""); row.setPadding(style.dp(16), style.dp(16), style.dp(16), style.dp(14));
                        TextView type = sheet.text(file.optString("extension") + "  ·  " + android.text.format.Formatter.formatFileSize(activity, file.optLong("size")), 12, sheet.style.secondary);
                        row.addView(type);
                        TextView name = sheet.text(file.optString("name"), 17, sheet.style.ink); name.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
                        name.setMaxLines(2); name.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE); name.setPadding(0, style.dp(8), 0, style.dp(16)); row.addView(name);
                        TextView download = sheet.action(tr("下载到手机", "Save to phone"), true, () -> choose(file, address, conversation));
                        download.setContentDescription(file.optString("name") + " · " + download.getText());
                        row.addView(download);
                    }
                    status.setText(rows.getChildCount() == 0 ? tr("未找到可下载文件。只显示此会话已引用、仍存在且位于工作目录内的产物；若刚生成，请关闭后重新打开，或更新并重启电脑端。", "No downloadable files found. Files must be referenced by this conversation, still exist and be inside its workspace. Reopen this panel after generation, or update and restart the desktop.")
                        : tr("选择保存位置后可切换应用或锁屏，下载会继续。", "Choose a save location, then switch apps or lock your phone. Downloads continue."));
                    long next = result.optLong("nextOffset", -1);
                    more.setText(tr("加载更多", "Load more"));
                    more.setVisibility(next >= 0 ? View.VISIBLE : View.GONE); more.setEnabled(true);
                    more.setOnClickListener(view -> loadPage(request, address, token, conversation, next, ticket, rows, status, more));
                });
            } catch (Exception error) {
                handler.post(() -> {
                    if (ticket != generation || activity.isDestroyed()) return;
                    status.setText(error instanceof RemoteApi.Failure && ((RemoteApi.Failure) error).status == 404
                        ? tr("请更新并重启电脑端，或检查会话访问权限。", "Update and restart the desktop, or check conversation access.")
                        : RemoteApi.failureMessage(error, chinese));
                    more.setVisibility(View.VISIBLE); more.setEnabled(true); more.setText(tr("重试", "Retry"));
                    more.setOnClickListener(view -> loadPage(request, address, token, conversation, offset, ticket, rows, status, more));
                });
            }
        });
    }

    private void choose(JSONObject file, String address, String conversation) {
        if (ArtifactDownloadService.snapshot().active()) { showProgress(); return; }
        try {
            if (!notificationAsked && android.os.Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                notificationAsked = true;
                activity.requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 705);
                toast(tr("请设置通知权限后再次点击下载；拒绝通知也可下载。", "Set notification permission, then tap download again; downloads also work without notifications."));
                return;
            }
            pending = new JSONObject(file.toString()).put("address", address).put("conversation", conversation);
            String name = file.getString("name").replaceAll("[\\\\/\\p{Cntrl}]", "_");
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, name);
            activity.startActivityForResult(intent, SAVE_REQUEST);
            stop();
        } catch (Exception error) { pending = null; toast(tr("无法打开保存位置选择器。", "Cannot open the file picker.")); }
    }

    void result(int result, Intent data, String address, String token) {
        JSONObject file = pending; pending = null;
        if (result != Activity.RESULT_OK || data == null || data.getData() == null || file == null) return;
        Uri destination = data.getData();
        if (!address.equals(file.optString("address")) || token.isEmpty()) { cleanup(destination); return; }
        try {
            int flags = data.getFlags();
            boolean persistable = (flags & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0;
            boolean readable = (flags & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0;
            boolean writable = (flags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0;
            if (persistable && readable && writable)
                activity.getContentResolver().takePersistableUriPermission(destination, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            else if (persistable && readable)
                activity.getContentResolver().takePersistableUriPermission(destination, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            else if (persistable && writable)
                activity.getContentResolver().takePersistableUriPermission(destination, Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (SecurityException ignored) { }
        stop();
        try { ArtifactDownloadService.start(activity, file, token, destination); showProgress(); }
        catch (Exception error) { cleanup(destination); toast(tr("无法启动下载，可能已有任务或系统限制，请重试。", "Cannot start download. Another task or a system restriction may be active. Retry.")); }
    }

    private boolean notificationAsked;

    void showProgress() {
        stop();
        ArtifactDownloadService.State initial = ArtifactDownloadService.snapshot();
        if (initial.phase.equals("idle")) return;
        dialog = new ArtifactSheet(activity, tr("下载到手机", "Save to phone"), tr("离开此页面，下载也不会中断。", "Leave this page without interrupting your download."));
        ArtifactSheet sheet = dialog;
        LinearLayout card = sheet.style.group(sheet.content, ""); card.setPadding(style.dp(20), style.dp(22), style.dp(20), style.dp(22));
        TextView filename = sheet.text(initial.name, 18, sheet.style.ink); filename.setMaxLines(3); filename.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        filename.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)); card.addView(filename);
        TextView percentage = sheet.text("0%", 44, sheet.style.ink); percentage.setPadding(0, style.dp(24), 0, style.dp(12)); percentage.setTag("downloadPercent"); card.addView(percentage);
        android.widget.ProgressBar bar = sheet.style.progressBar(); bar.setTag("downloadProgress");
        card.addView(bar, new LinearLayout.LayoutParams(-1, style.dp(6)));
        TextView bytes = sheet.text("", 13, sheet.style.secondary); bytes.setPadding(0, style.dp(12), 0, 0); card.addView(bytes);
        TextView detail = sheet.text("", 14, sheet.style.secondary); detail.setPadding(style.dp(16), style.dp(8), style.dp(16), style.dp(18)); sheet.content.addView(detail);
        TextView background = sheet.action(tr("在后台继续", "Continue in background"), true, sheet::dismiss); sheet.actions.addView(background);
        TextView cancel = sheet.action(tr("取消下载", "Cancel download"), false, () -> ArtifactDownloadService.cancel(activity));
        LinearLayout.LayoutParams space = new LinearLayout.LayoutParams(-1, -2); space.topMargin = style.dp(10); sheet.actions.addView(cancel, space);
        sheet.setOnDismissListener(ignored -> handler.removeCallbacksAndMessages(null)); sheet.show();
        handler.post(new Runnable() {
            @Override public void run() {
                if (!sheet.isShowing() || activity.isDestroyed()) return;
                ArtifactDownloadService.State state = ArtifactDownloadService.snapshot();
                int percent = ArtifactDownloadService.percent(state.received, state.total);
                percentage.setText(state.phase.equals("complete") ? "100%" : percent + "%"); bar.setProgress(percent);
                bytes.setText(android.text.format.Formatter.formatFileSize(activity, state.received) + " / " + android.text.format.Formatter.formatFileSize(activity, state.total));
                detail.setText(state.active() ? tr("可切换应用或锁屏。通知栏可查看进度；网络中断需重新下载。", "Switch apps or lock your phone. Track progress in notifications; a network interruption requires downloading again.") : state.detail);
                background.setText(state.active() ? tr("在后台继续", "Continue in background") : tr("完成", "Done"));
                cancel.setVisibility(state.active() ? View.VISIBLE : View.GONE);
                handler.postDelayed(this, 500);
            }
        });
    }

    private void cleanup(Uri destination) {
        try { android.provider.DocumentsContract.deleteDocument(activity.getContentResolver(), destination); }
        catch (Exception ignored) {}
    }

    private void toast(String message) { Toast.makeText(activity, message, Toast.LENGTH_LONG).show(); }

    void stop() {
        generation++;
        handler.removeCallbacksAndMessages(null);
        if (client != null) { client.cancel(); client = null; }
        if (dialog != null) { dialog.dismiss(); dialog = null; }
    }

    void close() { stop(); worker.shutdownNow(); }
}
