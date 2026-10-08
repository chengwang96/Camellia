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
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;

public final class EmbeddedNetwork {
    private static final Handler handler = new Handler(Looper.getMainLooper());
    @android.annotation.SuppressLint("StaticFieldLeak")
    private static Context context;
    private static volatile NetworkLifecycle<Node> lifecycle;
    private static volatile NetworkRoute route;
    private static ConnectivityManager connectivity;
    private static ConnectivityManager.NetworkCallback networkCallback;
    private static Runnable networkListener;
    private static final java.util.concurrent.ExecutorService networkWorker = java.util.concurrent.Executors.newSingleThreadExecutor(
        action -> new Thread(action, "camellia-tailnet-lifecycle"));
    private static final Runnable recover = () -> {
        long revision = route.revision();
        lifecycle.routeChanged().whenComplete((ignored, error) -> {
            handler.post(() -> {
                if (revision == route.revision() && networkListener != null) networkListener.run();
            });
        });
    };
    private static final Runnable shutdown = () -> lifecycle.expire();

    public static void initialize(Context application) {
        context = application.getApplicationContext();
        if (networkCallback != null) return;
        connectivity = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        Network active = connectivity.getActiveNetwork();
        LinkProperties links = active == null ? null : connectivity.getLinkProperties(active);
        route = new NetworkRoute(active, links == null ? null : links.toString());
        lifecycle = new NetworkLifecycle<>(new NetworkLifecycle.Backend<Node>() {
            @Override public Node create() throws Exception { return createNode(); }
            @Override public void close(Node value) { value.close(); }
            @Override public void saveMode(boolean value) throws IOException {
                if (!context.getSharedPreferences("network-mode", 0).edit().putBoolean("embedded", value).commit())
                    throw new IOException("Cannot save network mode");
            }
            @Override public void forget() throws Exception { new CredentialStore(context, "tailnet-private").clear(); }
        }, networkWorker, android.os.SystemClock::elapsedRealtime, () -> route.revision(),
            context.getSharedPreferences("network-mode", 0).getBoolean("embedded", true));
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
        lifecycle.routeChanged();
        handler.removeCallbacks(recover); handler.postDelayed(recover, 400);
    }

    public static void setNetworkListener(Runnable listener) { networkListener = listener; }
    public static boolean online() { return route == null || route.online(); }
    public static boolean enabled() { return lifecycle != null && lifecycle.enabled(); }
    public static CompletableFuture<Void> setEnabled(boolean value) { return lifecycle.setEnabled(value); }
    public static void foreground() {
        lifecycle.foreground();
        handler.removeCallbacks(shutdown);
        if (connectivity == null) return;
        Network active = connectivity.getActiveNetwork();
        boolean changed = route.available(active);
        LinkProperties links = active == null ? null : connectivity.getLinkProperties(active);
        if (route.links(active, links == null ? null : links.toString())) changed = true;
        if (changed) routeChanged();
    }
    public static void background() {
        lifecycle.background();
        handler.removeCallbacks(shutdown); handler.postDelayed(shutdown, 5 * 60_000);
    }

    static void endBackground() {
        lifecycle.endBackground();
        handler.removeCallbacks(shutdown);
        handler.post(shutdown);
    }

    static void retainTransfer() { lifecycle.retainTransfer(); }
    static void releaseTransfer() {
        lifecycle.releaseTransfer();
        handler.post(() -> {
            long backgroundDeadline = lifecycle.backgroundDeadline();
            if (backgroundDeadline > 0) {
                handler.removeCallbacks(shutdown);
                handler.postDelayed(shutdown, Math.max(0, backgroundDeadline - android.os.SystemClock.elapsedRealtime()));
            }
        });
    }

    public static Node node() throws IOException {
        if (Looper.myLooper() == Looper.getMainLooper()) throw new IOException("Embedded network initialization requires a background thread");
        if (lifecycle == null) throw new IOException("Embedded network is disabled");
        try { return lifecycle.node().get(); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException("Cancelled", error); }
        catch (ExecutionException error) {
            if (error.getCause() instanceof IOException failure) throw failure;
            throw ConnectionFailure.failure(ConnectionFailure.Code.NETWORK_START_FAILED, error.getCause());
        }
    }

    private static Node createNode() throws IOException {
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
            return Tailnet.newNode(directory.getAbsolutePath(), encrypted);
        } catch (Exception error) { throw ConnectionFailure.failure(ConnectionFailure.Code.NETWORK_START_FAILED, error); }
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

    public static CompletableFuture<Void> close() { return lifecycle.close(); }
    public static CompletableFuture<Void> forget() { return lifecycle.forget(); }
    private EmbeddedNetwork() {}
}
