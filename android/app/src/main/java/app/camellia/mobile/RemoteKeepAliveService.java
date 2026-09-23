package app.camellia.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

public final class RemoteKeepAliveService extends Service {
    static final long MAX_DURATION = 5 * 60_000L;
    private static final String CHANNEL = "remote-connection";
    private static final int NOTICE = 705;
    private static final Handler handler = new Handler(Looper.getMainLooper());
    private static long deadline;
    private static Runnable disconnect;
    private static RemoteKeepAliveService running;
    private static final Runnable expire = () -> endSession();
    private PowerManager.WakeLock wake;
    private long session;

    static boolean enabled(Context context) {
        return MobilePreferences.get(context, "remoteKeepAlive").equals("enabled");
    }

    static boolean eligible(Context context) {
        if (!enabled(context)) return false;
        try {
            for (var computer : new ComputerStore(new CredentialStore(context)).all()) {
                if (!computer.optString("address").isEmpty() && !computer.optString("token").isEmpty()) return true;
            }
        } catch (Exception ignored) { }
        return false;
    }

    static boolean active() { return deadline > SystemClock.elapsedRealtime(); }

    static boolean begin(Context context, Runnable onExpired) {
        if (!eligible(context)) return false;
        if (active()) return true;
        deadline = SystemClock.elapsedRealtime() + MAX_DURATION;
        disconnect = onExpired;
        handler.removeCallbacks(expire);
        handler.postDelayed(expire, MAX_DURATION);
        try {
            context.startForegroundService(new Intent(context, RemoteKeepAliveService.class).putExtra("deadline", deadline));
            return true;
        } catch (RuntimeException error) {
            endSession();
            return false;
        }
    }

    static void finish(Context context, boolean returning) {
        if (returning) disconnect = null;
        endSession();
    }

    private static void endSession() {
        deadline = 0;
        handler.removeCallbacks(expire);
        Runnable callback = disconnect;
        disconnect = null;
        if (callback != null) callback.run();
        if (running != null) running.stopSelf();
    }

    @Override public void onCreate() {
        super.onCreate();
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL,
            tr("远程连接", "Remote connection"), NotificationManager.IMPORTANCE_LOW));
        running = this;
    }

    private String tr(String zh, String en) {
        return MobilePreferences.wrap(this).getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh") ? zh : en;
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) {
            finish(this, false);
            return START_NOT_STICKY;
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content = PendingIntent.getActivity(this, NOTICE, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, NOTICE, new Intent(this, RemoteKeepAliveService.class).setAction("stop"),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            startForeground(NOTICE, new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_connection)
                .setContentTitle(tr("远程连接已暂时保留", "Remote connection kept active"))
                .setContentText(tr("离开后最多保持 5 分钟，返回即可继续。", "Kept for up to 5 minutes while away. Return to continue."))
                .setContentIntent(content).setOnlyAlertOnce(true).setOngoing(true)
                .addAction(new Notification.Action.Builder(null, tr("断开", "Disconnect"), stop).build()).build());
            session = intent == null ? 0 : intent.getLongExtra("deadline", 0);
            if (session != deadline) { if (!active()) stopSelf(); return START_NOT_STICKY; }
            if (!active() || !eligible(this)) { finish(this, false); return START_NOT_STICKY; }
            if (wake == null) {
                wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Camellia:remoteConnection");
            }
            if (wake.isHeld()) wake.release();
            wake.acquire(Math.max(1, deadline - SystemClock.elapsedRealtime()));
            handler.removeCallbacks(stopAtDeadline);
            handler.postDelayed(stopAtDeadline, Math.max(0, deadline - SystemClock.elapsedRealtime()));
        } catch (RuntimeException error) { finish(this, false); }
        return START_NOT_STICKY;
    }

    private final Runnable stopAtDeadline = () -> { if (session == deadline || !active()) finish(this, false); };

    @Override public void onTimeout(int startId, int foregroundServiceType) { finish(this, false); }
    @Override public void onTaskRemoved(Intent rootIntent) { finish(this, false); }
    @Override public void onDestroy() {
        if (running == this) running = null;
        if (session == deadline) endSession();
        handler.removeCallbacks(stopAtDeadline);
        if (wake != null && wake.isHeld()) wake.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
