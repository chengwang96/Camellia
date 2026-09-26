package app.camellia.mobile;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONObject;
import tailnet.Node;
import tailnet.Storage;
import tailnet.Tailnet;
import java.io.IOException;
import java.net.URI;

public final class EmbeddedNetwork {
    private static final Object LOCK = new Object();
    private static final Handler handler = new Handler(Looper.getMainLooper());
    @android.annotation.SuppressLint("StaticFieldLeak")
    private static Context context;
    private static Node node;
    private static long nodeRevision;
    private static NetworkRoute route;
    private static ConnectivityManager connectivity;
    private static ConnectivityManager.NetworkCallback networkCallback;
    private static Runnable networkListener;
    private static boolean stale;
    private static final java.util.concurrent.ExecutorService networkWorker = java.util.concurrent.Executors.newSingleThreadExecutor();
    private static final Runnable recover = () -> {
        long revision = route.revision();
        networkWorker.execute(() -> {
            synchronized (LOCK) {
                if (node != null && nodeRevision != route.revision()) close();
            }
            handler.post(() -> {
                if (revision == route.revision() && networkListener != null) networkListener.run();
            });
        });
    };
    private static volatile long backgroundDeadline;
    private static int transfers;
    private static final Runnable shutdown = () -> new Thread(() -> {
        synchronized (LOCK) { if (retentionExpired()) close(); }
    }, "camellia-tailnet-close").start();

    private static boolean retentionExpired() {
        return node != null && transfers == 0 && backgroundDeadline > 0
            && android.os.SystemClock.elapsedRealtime() >= backgroundDeadline;
    }

    public static void initialize(Context application) {
        context = application.getApplicationContext();
        if (networkCallback != null) return;
        connectivity = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        Network active = connectivity.getActiveNetwork();
        LinkProperties links = active == null ? null : connectivity.getLinkProperties(active);
        route = new NetworkRoute(active, links == null ? null : links.toString());
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) { if (route.available(network)) routeChanged(); }
            @Override public void onLinkPropertiesChanged(Network network, LinkProperties properties) {
                if (route.links(network, properties.toString())) routeChanged();
            }
            @Override public void onLost(Network network) { if (route.lost(network)) routeChanged(); }
        };
        connectivity.registerDefaultNetworkCallback(networkCallback, handler);
    }

    private static void routeChanged() {
        handler.removeCallbacks(recover); handler.postDelayed(recover, 400);
    }

    public static void setNetworkListener(Runnable listener) { networkListener = listener; }
    public static boolean online() { return route == null || route.online(); }
    public static boolean enabled() { return context != null && context.getSharedPreferences("network-mode", 0).getBoolean("embedded", true); }
    public static void setEnabled(boolean value) {
        if (!context.getSharedPreferences("network-mode", 0).edit().putBoolean("embedded", value).commit()) throw new IllegalStateException("Cannot save network mode");
        if (!value) new Thread(EmbeddedNetwork::close, "camellia-tailnet-close").start();
    }
    public static void foreground() {
        synchronized (LOCK) {
            if (retentionExpired()) stale = true;
            backgroundDeadline = 0;
        }
        handler.removeCallbacks(shutdown);
        if (connectivity == null) return;
        Network active = connectivity.getActiveNetwork();
        boolean changed = route.available(active);
        LinkProperties links = active == null ? null : connectivity.getLinkProperties(active);
        if (route.links(active, links == null ? null : links.toString())) changed = true;
        if (changed) routeChanged();
    }
    public static void background() {
        synchronized (LOCK) { backgroundDeadline = android.os.SystemClock.elapsedRealtime() + 5 * 60_000; }
        handler.removeCallbacks(shutdown); handler.postDelayed(shutdown, 5 * 60_000);
    }

    static void endBackground() {
        synchronized (LOCK) { backgroundDeadline = android.os.SystemClock.elapsedRealtime(); }
        handler.removeCallbacks(shutdown);
        handler.post(shutdown);
    }

    static void retainTransfer() { synchronized (LOCK) { transfers++; } }
    static void releaseTransfer() {
        synchronized (LOCK) { transfers = Math.max(0, transfers - 1); }
        handler.post(() -> {
            if (backgroundDeadline > 0) {
                handler.removeCallbacks(shutdown);
                handler.postDelayed(shutdown, Math.max(0, backgroundDeadline - android.os.SystemClock.elapsedRealtime()));
            }
        });
    }

    public static Node node() throws IOException {
        synchronized (LOCK) {
            long revision = route == null ? 0 : route.revision();
            if (node != null && (stale || nodeRevision != revision)) close();
            if (node != null) return node;
            if (context == null || !enabled()) throw new IOException("Embedded network is disabled");
            try {
                registerInterfaces();
                CredentialStore storage = new CredentialStore(context, "tailnet-private");
                Storage encrypted = new Storage() {
                    @Override public synchronized String read(String key) throws Exception { return storage.load().optString(key, ""); }
                    @Override public synchronized void write(String key, String value) throws Exception {
                        JSONObject state = storage.load(); state.put(key, value); storage.save(state);
                    }
                };
                java.io.File directory = new java.io.File(context.getNoBackupFilesDir(), "tailnet");
                if (!directory.exists() && !directory.mkdirs()) throw new IOException("Cannot create private network directory");
                node = Tailnet.newNode(directory.getAbsolutePath(), encrypted);
                nodeRevision = revision; stale = false;
                return node;
            } catch (Exception error) { throw ConnectionFailure.failure(ConnectionFailure.Code.NETWORK_START_FAILED, error); }
        }
    }

    public static void registerInterfaces() {
        Tailnet.setInterfaces(() -> {
            org.json.JSONArray result = new org.json.JSONArray();
            var interfaces = java.net.NetworkInterface.getNetworkInterfaces();
            if (interfaces == null) return "[]";
            while (interfaces.hasMoreElements()) {
                var network = interfaces.nextElement();
                org.json.JSONArray addresses = new org.json.JSONArray();
                for (var address : network.getInterfaceAddresses()) {
                    String host = address.getAddress().getHostAddress();
                    if (host != null) addresses.put(host.split("%")[0] + "/" + address.getNetworkPrefixLength());
                }
                result.put(new JSONObject().put("Name", network.getName()).put("Index", network.getIndex()).put("MTU", network.getMTU())
                    .put("Up", network.isUp()).put("Loopback", network.isLoopback()).put("Addresses", addresses));
            }
            return result.toString();
        });
    }

    public static String loginUrl(String value) {
        try {
            URI uri = URI.create(value);
            if (!"https".equals(uri.getScheme()) || !"login.tailscale.com".equals(uri.getHost()) || uri.getRawUserInfo() != null || uri.getPort() != -1 || uri.getFragment() != null) return null;
            return uri.toString();
        } catch (Exception error) { return null; }
    }

    public static void close() {
        synchronized (LOCK) {
            stale = false;
            if (node != null) { node.close(); node = null; }
        }
    }
    public static void forget() throws Exception {
        synchronized (LOCK) { close(); new CredentialStore(context, "tailnet-private").clear(); }
    }
    private EmbeddedNetwork() {}
}
