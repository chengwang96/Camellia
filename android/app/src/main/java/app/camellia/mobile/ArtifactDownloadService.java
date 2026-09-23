package app.camellia.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.IBinder;
import android.os.PowerManager;
import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.Executors;

public final class ArtifactDownloadService extends Service {
    private static final String CHANNEL = "artifact-downloads";
    private static final int NOTICE = 704;
    private static final Object LOCK = new Object();
    private static Job current;
    private static volatile State state = new State("", "", 0, 0, "idle", "");
    private RemoteApi client;
    private Job job;
    private PowerManager.WakeLock wake;
    private boolean retained, finished;
    private final java.util.concurrent.ExecutorService worker = Executors.newSingleThreadExecutor();

    static final class State {
        final String name, address, phase, detail;
        final long received, total;
        State(String name, String address, long received, long total, String phase, String detail) {
            this.name = name; this.address = address; this.received = received; this.total = total; this.phase = phase; this.detail = detail;
        }
        boolean active() { return phase.equals("running"); }
    }
    private static final class Job {
        final String name, address, token, path;
        final long size;
        final Uri destination;
        volatile boolean cancelled;
        Job(JSONObject file, String token, Uri destination) throws Exception {
            name = file.getString("name"); address = file.getString("address"); this.token = token;
            path = "/v1/conversations/" + file.getString("conversation") + "/artifacts/" + file.getString("id");
            new Endpoint(address).uri(path);
            size = file.getLong("size");
            if (size < 0 || !token.matches("[A-Za-z0-9_-]{43}") || !"content".equals(destination.getScheme())) throw new IOException("Invalid download");
            this.destination = destination;
        }
    }

    static State snapshot() { return state; }

    static void start(Context context, JSONObject file, String token, Uri destination) throws Exception {
        Job next = new Job(file, token, destination);
        synchronized (LOCK) {
            if (current != null) throw new IOException("A download is already running");
            current = next;
            state = new State(next.name, next.address, 0, next.size, "running", "");
            try {
                Intent intent = new Intent(context, ArtifactDownloadService.class).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                intent.setClipData(android.content.ClipData.newRawUri("download", destination));
                context.startForegroundService(intent);
            }
            catch (Exception error) { current = null; state = new State(next.name, next.address, 0, next.size, "failed", ""); throw error; }
        }
    }

    static void cancel(Context context) {
        synchronized (LOCK) { if (current != null) current.cancelled = true; }
        context.stopService(new Intent(context, ArtifactDownloadService.class));
    }

    @Override public void onCreate() {
        super.onCreate();
        EmbeddedNetwork.initialize(getApplicationContext());
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL,
            tr("文件下载", "File downloads"), NotificationManager.IMPORTANCE_LOW));
    }

    private String tr(String zh, String en) {
        return MobilePreferences.wrap(this).getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh") ? zh : en;
    }

    private Notification notification(State value) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra("showDownload", true);
        PendingIntent content = PendingIntent.getActivity(this, NOTICE, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String description = value.active() ? android.text.format.Formatter.formatFileSize(this, value.received) + " / "
            + android.text.format.Formatter.formatFileSize(this, value.total) : value.detail;
        Notification.Builder builder = new Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(value.name).setContentText(description).setStyle(new Notification.BigTextStyle().bigText(description))
            .setContentIntent(content).setOnlyAlertOnce(true).setOngoing(value.active()).setAutoCancel(!value.active());
        if (value.active()) {
            Intent cancel = new Intent(this, ArtifactDownloadService.class).setAction("cancel");
            builder.setProgress(100, percent(value.received, value.total), value.total == 0)
                .addAction(new Notification.Action.Builder(null, tr("取消", "Cancel"), PendingIntent.getService(this, NOTICE, cancel,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)).build());
        }
        return builder.build();
    }

    static int percent(long received, long total) { return total <= 0 ? 0 : (int) Math.min(100, received * 100.0 / total); }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "cancel".equals(intent.getAction())) { cancel(this); return START_NOT_STICKY; }
        if (job != null) return START_NOT_STICKY;
        synchronized (LOCK) { job = current; }
        if (job == null) { stopSelf(); return START_NOT_STICKY; }
        try {
            startForeground(NOTICE, notification(state));
            EmbeddedNetwork.retainTransfer(); retained = true;
            wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Camellia:artifactDownload");
            wake.acquire(6 * 60 * 60_000L);
            client = new RemoteApi(job.address);
            worker.execute(this::download);
        } catch (Exception error) {
            worker.execute(() -> { cleanup(job.destination); finish("failed", tr("无法启动后台下载，请重新选择文件。", "Cannot start background download. Select the file again.")); });
        }
        return START_NOT_STICKY;
    }

    private void download() {
        String phase = "complete", detail = tr("已保存到所选位置，可在文件管理器查看。", "Saved to your chosen location. Open your file manager to view it.");
        try {
            if (job.cancelled) throw new IOException("Cancelled");
            try (var output = getContentResolver().openOutputStream(job.destination, "wt")) {
                if (output == null) throw new IOException("Cannot open destination");
                client.download(job.path, job.token, output, job.size, (received, total) -> {
                    state = new State(job.name, job.address, received, total, "running", "");
                    getSystemService(NotificationManager.class).notify(NOTICE, notification(state));
                });
            }
            if (job.cancelled) throw new IOException("Cancelled");
        } catch (Exception error) {
            phase = job.cancelled ? "cancelled" : "failed";
            detail = job.cancelled ? tr("下载已取消。", "Download cancelled.")
                : RemoteApi.failureMessage(error, tr("zh", "en").equals("zh")) + tr(" 请重新下载；也请检查保存位置的空间和权限。", " Download again; also check storage space and permissions.");
            if (!cleanup(job.destination)) detail += tr(" 未完成文件可能仍在保存位置，请手动删除。", " A partial file may remain; delete it manually.");
        } finally { if (client != null) client.cancel(); }
        finish(phase, detail);
    }

    private boolean cleanup(Uri destination) {
        try { return android.provider.DocumentsContract.deleteDocument(getContentResolver(), destination); }
        catch (Exception ignored) { return false; }
    }

    private void finish(String phase, String detail) {
        new android.os.Handler(getMainLooper()).post(() -> {
            finished = true;
            state = new State(job.name, job.address, state.received, job.size, phase, detail);
            synchronized (LOCK) { if (current == job) current = null; }
            stopForeground(STOP_FOREGROUND_REMOVE);
            getSystemService(NotificationManager.class).notify(NOTICE, notification(state));
            try { getContentResolver().releasePersistableUriPermission(job.destination, Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION); }
            catch (SecurityException ignored) { }
            releaseResources(); stopSelf();
        });
    }

    private void releaseResources() {
        if (wake != null && wake.isHeld()) wake.release();
        if (retained) { retained = false; EmbeddedNetwork.releaseTransfer(); }
    }

    @Override public void onTimeout(int startId, int foregroundServiceType) { cancel(this); }
    @Override public void onDestroy() {
        if (!finished && job != null) {
            job.cancelled = true;
            if (client != null) new Thread(client::cancel, "camellia-download-cancel").start();
        }
        releaseResources(); worker.shutdown(); super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
