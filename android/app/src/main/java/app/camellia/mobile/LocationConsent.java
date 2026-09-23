package app.camellia.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import java.util.Locale;
import java.util.function.Consumer;

final class LocationConsent {
    static final int REQUEST_CODE = 7401;
    private final Activity activity;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private AlertDialog dialog;
    private Consumer<String> pending;
    private LocationManager manager;
    private LocationListener listener;
    private boolean awaitingPermission;
    private final Runnable timeout = () -> finish(unavailable());

    LocationConsent(Activity activity) { this.activity = activity; }

    static boolean relevant(String prompt) {
        String text = prompt.trim().toLowerCase(Locale.ROOT);
        if (text.matches("(?s).*(不要定位|不使用.{0,4}位置|不用.{0,4}定位|不获取.{0,4}位置|不要.{0,4}位置|do not (use|access|share).{0,20}location|don't (use|access|share).{0,20}location|without.{0,10}location).*")
                || text.contains("```") || text.matches("(?s).*(翻译|引用|translate|quoted).*")) return false;
        if (text.matches("(?s).*(我在哪|我的位置|我现在.{0,6}(位置|哪里|哪儿)|我所在|当前位置|附近.{0,20}(推荐|餐厅|饭店|医院|药店|咖啡|酒店|停车|加油|天气|有什么|哪里)|周边.{0,12}(推荐|餐厅|医院|酒店)|这里.{0,12}(天气|气温|下雨)|near me|my (current )?location|where am i|weather (here|at my location)).*")) return true;
        return text.matches("(?s)^(?:请|帮我|请帮我)?(?:搜一搜|搜一下|搜索|查一查|查一下|查询|看看)?(?:最近)?(?:今天|今日|最近|近期|这几天|近几天).{0,8}(天气|气温|下雨).*$")
                || text.matches("(?s)^(?:please )?(?:search |check )?(?:today'?s weather|weather today|current weather).*$");
    }

    private String tr(String chinese, String english) {
        return activity.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh") ? chinese : english;
    }

    void request(String prompt, String destination, Consumer<String> complete) {
        if (pending != null) return;
        if (!relevant(prompt)) { complete.accept(""); return; }
        pending = complete;
        dialog = new AlertDialog.Builder(activity).setTitle(tr("本次回答使用大致位置？", "Use approximate location for this answer?"))
            .setMessage(tr("此问题可能需要当前位置。仅在你同意后向 Android 申请大致位置，单次获取，不后台追踪。\n\n发送至：", "This question may need your current location. Only with your consent will Android be asked for approximate location, once, with no background tracking.\n\nSend to: ")
                + destination + tr("\n\n不会自动再次定位。接收方可能保存位置，回答及后续会话上下文也可能包含它。", "\n\nNo automatic future location access. The recipient may retain the location, and answers or later conversation context may include it."))
            .setPositiveButton(tr("允许本次", "Allow once"), (choice, which) -> authorize())
            .setNegativeButton(tr("不提供位置，继续", "Continue without location"), (choice, which) -> finish(unavailable()))
            .setNeutralButton(tr("取消发送", "Cancel send"), (choice, which) -> cancel())
            .setOnCancelListener(choice -> cancel()).show();
    }

    private void authorize() {
        if (pending == null) return;
        if (activity.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            awaitingPermission = true;
            activity.requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION}, REQUEST_CODE);
        } else locate();
    }

    void permissionResult(int requestCode) {
        if (requestCode != REQUEST_CODE || pending == null || !awaitingPermission) return;
        awaitingPermission = false;
        if (activity.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) locate();
        else finish(unavailable());
    }

    private void locate() {
        if (pending == null) return;
        manager = (LocationManager) activity.getSystemService(Context.LOCATION_SERVICE);
        try {
            if (manager == null || !manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
                    || activity.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                finish(unavailable()); return;
            }
            dialog = new AlertDialog.Builder(activity).setTitle(tr("正在获取大致位置…", "Getting approximate location…"))
                .setMessage(tr("最多等待 10 秒；不会读取历史缓存位置。", "Wait up to 10 seconds. Cached past locations are not used."))
                .setNegativeButton(tr("不提供位置，继续", "Continue without location"), (choice, which) -> finish(unavailable()))
                .setNeutralButton(tr("取消发送", "Cancel send"), (choice, which) -> cancel())
                .setOnCancelListener(choice -> cancel()).show();
            listener = new LocationListener() {
                @Override public void onLocationChanged(Location location) {
                    if (pending != null && listener == this) finish(context(location));
                }
                @Override public void onProviderDisabled(String provider) { if (listener == this) finish(unavailable()); }
                @Override public void onProviderEnabled(String provider) {}
                @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
            };
            handler.postDelayed(timeout, 10000);
            manager.requestSingleUpdate(LocationManager.NETWORK_PROVIDER, listener, Looper.getMainLooper());
        } catch (RuntimeException error) { finish(unavailable()); }
    }

    static String context(Location location) {
        if (location == null || !location.hasAccuracy() || !Double.isFinite(location.getLatitude())
                || !Double.isFinite(location.getLongitude()) || !Float.isFinite(location.getAccuracy())
                || Math.abs(location.getLatitude()) > 90 || Math.abs(location.getLongitude()) > 180
                || location.getAccuracy() < 0) return unavailable();
        long age = android.os.SystemClock.elapsedRealtimeNanos() - location.getElapsedRealtimeNanos();
        if (age < 0 || age > 120_000_000_000L) return unavailable();
        return String.format(Locale.ROOT,
            "\n\n[本次经用户同意提供的大致设备位置 / Approximate device location shared with consent for this request]\n"
                + "Latitude: %.2f; longitude: %.2f; uncertainty: at least %.0f m.\n"
                + "仅用于回答本次位置相关问题，不是精确地址；不可据此声称获得实时天气或商家数据。 / "
                + "Use only for this location-related question, not as an exact address or proof of live weather/business data.",
            location.getLatitude(), location.getLongitude(), Math.max(2000, location.getAccuracy()));
    }

    private static String unavailable() {
        return "\n\n[本次未提供设备位置 / Device location was not provided for this request. "
            + "Do not guess the user's location; ask for a city or area if needed.]";
    }

    private void finish(String context) {
        Consumer<String> complete = pending;
        cancel();
        if (complete != null && !activity.isFinishing() && !activity.isDestroyed()) complete.accept(context);
    }

    void cancel() {
        pending = null; awaitingPermission = false; handler.removeCallbacks(timeout);
        if (manager != null && listener != null) {
            try { manager.removeUpdates(listener); } catch (RuntimeException ignored) {}
        }
        manager = null; listener = null;
        if (dialog != null) { dialog.dismiss(); dialog = null; }
    }
}
