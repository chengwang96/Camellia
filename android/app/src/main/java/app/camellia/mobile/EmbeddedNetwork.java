package app.camellia.mobile;

import android.content.Context;
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
    private static final Runnable shutdown = () -> new Thread(EmbeddedNetwork::close, "camellia-tailnet-close").start();

    public static void initialize(Context application) { context = application.getApplicationContext(); }
    public static boolean enabled() { return context != null && context.getSharedPreferences("network-mode", 0).getBoolean("embedded", true); }
    public static void setEnabled(boolean value) {
        if (!context.getSharedPreferences("network-mode", 0).edit().putBoolean("embedded", value).commit()) throw new IllegalStateException("Cannot save network mode");
        if (!value) new Thread(EmbeddedNetwork::close, "camellia-tailnet-close").start();
    }
    public static void foreground() { handler.removeCallbacks(shutdown); }
    public static void background() { handler.removeCallbacks(shutdown); handler.postDelayed(shutdown, 30_000); }

    public static Node node() throws IOException {
        synchronized (LOCK) {
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
                return node;
            } catch (Exception error) { throw new IOException("Embedded network could not start", error); }
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
            if (node != null) { node.close(); node = null; }
        }
    }
    public static void forget() throws Exception {
        synchronized (LOCK) { close(); new CredentialStore(context, "tailnet-private").clear(); }
    }
    private EmbeddedNetwork() {}
}
