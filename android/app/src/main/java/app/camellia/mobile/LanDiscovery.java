package app.camellia.mobile;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * DNS-SD discovery for Camellia LAN gateways. The advertised TXT record is a
 * hint only: a connection still requires the certificate fingerprint and a
 * device token or the shared LAN PIN.
 */
final class LanDiscovery {
    static final String SERVICE_TYPE = "_camellia._tcp.";
    private static final String NORMALIZED_SERVICE_TYPE = "_camellia._tcp";
    private static final String TAG = "CamelliaLan";
    private static final int MAX_START_ATTEMPTS = 3;
    private static final long STOP_TIMEOUT_MS = 2_000;
    private static final long RESOLVE_TIMEOUT_MS = 5_000;

    static final class Service {
        final String serviceName;
        final String computerId;
        final String name;
        final String url;
        final String fingerprint;
        final boolean joinable;

        Service(String serviceName, String computerId, String name, String url, String fingerprint, boolean joinable) {
            this.serviceName = serviceName;
            this.computerId = computerId;
            this.name = name;
            this.url = url;
            this.fingerprint = fingerprint;
            this.joinable = joinable;
        }
    }

    interface Listener {
        void onLanServices(List<Service> services);
        default void onLanDiscoveryStarted() {}
        default void onLanDiscoveryFailed(int errorCode) {}
    }

    private final Context context;
    private final Listener listener;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final LanMdnsProbe mdnsProbe = new LanMdnsProbe(this::onProbeService);
    private final LanUdpProbe udpProbe = new LanUdpProbe(this::onProbeService);
    private final Map<String, Service> services = new LinkedHashMap<>();
    private final ArrayDeque<NsdServiceInfo> resolveQueue = new ArrayDeque<>();
    private final Set<String> queuedServices = new HashSet<>();
    private NsdManager manager;
    private NsdManager.DiscoveryListener discovery;
    private WifiManager.MulticastLock multicast;
    private ConnectivityManager connectivity;
    private Network boundWifiNetwork;
    private boolean running;
    private boolean active;
    private boolean stopping;
    private boolean resolving;
    private boolean bindToWifi;
    private int generation;
    private int resolveGeneration;
    private int startAttempts;

    LanDiscovery(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    synchronized void start() {
        start(false);
    }

    synchronized void start(boolean wifi) {
        bindToWifi = wifi;
        runOnMain(this::startOnMain);
    }

    synchronized void restart() {
        restart(false);
    }

    synchronized void restart(boolean wifi) {
        bindToWifi = wifi;
        runOnMain(this::restartOnMain);
    }

    private void startOnMain() {
        synchronized (this) {
            running = true;
            if (active || stopping) return;
        }
        beginDiscovery();
    }

    private void restartOnMain() {
        boolean begin = false;
        synchronized (this) {
            running = true;
            services.clear();
            clearResolutionQueue();
            if (!active && !stopping) begin = true;
        }
        publish();
        if (begin) beginDiscovery();
        else stopDiscovery();
    }

    private void beginDiscovery() {
        final int token;
        synchronized (this) {
            if (!running || active || stopping) return;
            manager = context.getSystemService(NsdManager.class);
            if (manager == null) {
                running = false;
                notifyFailed(-1);
                return;
            }
            active = true;
            token = ++generation;
            acquireMulticastLock();
            startWifiDiscovery();
            discovery = createDiscoveryListener(token);
        }
        try {
            manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discovery);
        } catch (Exception error) {
            Log.w(TAG, "Cannot start LAN discovery", error);
            failedToStart(token, -1);
        }
    }

    private NsdManager.DiscoveryListener createDiscoveryListener(int token) {
        return new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String serviceType) {
                synchronized (LanDiscovery.this) {
                    if (token != generation) return;
                    active = true;
                    stopping = false;
                    startAttempts = 0;
                }
                Log.i(TAG, "LAN discovery started");
                notifyStarted();
            }

            @Override public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                Log.w(TAG, "LAN discovery failed to start: " + errorCode);
                failedToStart(token, errorCode);
            }

            @Override public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                Log.w(TAG, "LAN discovery failed to stop: " + errorCode);
                stopped(token);
            }

            @Override public void onDiscoveryStopped(String serviceType) {
                stopped(token);
            }

            @Override public void onServiceFound(NsdServiceInfo serviceInfo) {
                if (!matches(serviceInfo.getServiceType())) return;
                synchronized (LanDiscovery.this) {
                    if (token != generation || !running) return;
                    String key = serviceInfo.getServiceName();
                    if (services.containsKey(key) || !queuedServices.add(key)) return;
                    resolveQueue.add(serviceInfo);
                }
                resolveNext();
            }

            @Override public void onServiceLost(NsdServiceInfo serviceInfo) {
                synchronized (LanDiscovery.this) {
                    if (token != generation) return;
                    services.remove(serviceInfo.getServiceName());
                    removeQueued(serviceInfo.getServiceName());
                }
                publish();
            }
        };
    }

    private void failedToStart(int token, int errorCode) {
        boolean retry;
        synchronized (this) {
            if (token != generation) return;
            active = false;
            stopping = false;
            discovery = null;
            startAttempts++;
            retry = running && startAttempts < MAX_START_ATTEMPTS;
            if (!retry) running = false;
        }
        if (!retry) releaseDiscoveryResources();
        notifyFailed(errorCode);
        if (retry) {
            handler.postDelayed(() -> {
                synchronized (LanDiscovery.this) {
                    if (!running || active || stopping) return;
                }
                beginDiscovery();
            }, 500L * startAttempts);
        }
    }

    private void stopDiscovery() {
        final NsdManager.DiscoveryListener current;
        final int token;
        synchronized (this) {
            if (stopping) return;
            current = discovery;
            token = generation;
            if (current == null || manager == null) {
                active = false;
                stopping = false;
            } else {
                stopping = true;
            }
        }
        if (current == null || manager == null) {
            releaseDiscoveryResources();
            beginIfWanted();
            return;
        }
        try {
            manager.stopServiceDiscovery(current);
        } catch (Exception error) {
            Log.w(TAG, "Cannot stop LAN discovery", error);
            stopped(token);
            return;
        }
        handler.postDelayed(() -> stopped(token), STOP_TIMEOUT_MS);
    }

    private void stopped(int token) {
        boolean begin;
        synchronized (this) {
            if (token != generation) return;
            active = false;
            stopping = false;
            discovery = null;
            begin = running;
        }
        releaseDiscoveryResources();
        if (begin) beginDiscovery();
    }

    private void beginIfWanted() {
        boolean begin;
        synchronized (this) {
            begin = running && !active && !stopping;
        }
        if (begin) beginDiscovery();
    }

    private void resolveNext() {
        final NsdServiceInfo queued;
        final int token;
        synchronized (this) {
            if (!running || !active || resolving || resolveQueue.isEmpty()) return;
            queued = resolveQueue.removeFirst();
            resolving = true;
            token = ++resolveGeneration;
        }
        handler.postDelayed(() -> resolveTimedOut(token), RESOLVE_TIMEOUT_MS);
        try {
            manager.resolveService(queued, new NsdManager.ResolveListener() {
                @Override public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                    Log.w(TAG, "LAN service resolution failed: " + errorCode + " for " + serviceInfo.getServiceName());
                    finishResolve(token);
                }

                @Override public void onServiceResolved(NsdServiceInfo info) {
                    accept(info);
                    finishResolve(token);
                }
            });
        } catch (Exception error) {
            Log.w(TAG, "Cannot resolve LAN service", error);
            finishResolve(token);
        }
    }

    private void resolveTimedOut(int token) {
        synchronized (this) {
            if (token != resolveGeneration || !resolving) return;
            resolving = false;
        }
        resolveNext();
    }

    private void finishResolve(int token) {
        synchronized (this) {
            if (token != resolveGeneration || !resolving) return;
            resolving = false;
        }
        resolveNext();
    }

    private void accept(NsdServiceInfo info) {
        synchronized (this) {
            if (!running) return;
        }
        Map<String, byte[]> txt = info.getAttributes();
        String id = text(txt, "id");
        String ip = text(txt, "ip");
        String fingerprint = text(txt, "fp");
        String protocol = text(txt, "v");
        if (!protocol.isEmpty() && !"1".equals(protocol)) return;
        if (ip.isEmpty()) ip = hostAddress(info);
        if (id.isEmpty() || ip.isEmpty() || !LanTls.validFingerprint(fingerprint)) return;
        String url;
        try { url = new Endpoint("https://" + ip + ":" + info.getPort()).origin(); }
        catch (IllegalArgumentException error) { return; }
        Service service = new Service(info.getServiceName(), id, text(txt, "name"), url,
                LanTls.normalize(fingerprint), !"0".equals(text(txt, "join")));
        synchronized (this) {
            services.entrySet().removeIf(entry -> service.computerId.equals(entry.getValue().computerId));
            services.put(info.getServiceName(), service);
        }
        publish();
    }

    private static String hostAddress(NsdServiceInfo info) {
        InetAddress host = info.getHost();
        if (host == null) return "";
        String address = host.getHostAddress();
        if (address == null) return "";
        if (address.startsWith("::ffff:")) address = address.substring(7);
        try { new Endpoint("https://" + address + ":" + info.getPort()); }
        catch (IllegalArgumentException error) { return ""; }
        return address;
    }

    private static boolean matches(String serviceType) {
        if (serviceType == null) return false;
        String normalized = serviceType.endsWith(".")
                ? serviceType.substring(0, serviceType.length() - 1) : serviceType;
        return NORMALIZED_SERVICE_TYPE.equalsIgnoreCase(normalized);
    }

    private static String text(Map<String, byte[]> txt, String key) {
        byte[] value = txt == null ? null : txt.get(key);
        return value == null ? "" : new String(value, StandardCharsets.UTF_8);
    }

    private void acquireMulticastLock() {
        try {
            WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi == null) return;
            multicast = wifi.createMulticastLock("camellia-lan-discovery");
            multicast.setReferenceCounted(false);
            multicast.acquire();
        } catch (Exception error) {
            Log.w(TAG, "Multicast lock unavailable", error);
            multicast = null;
        }
    }

    private void startWifiDiscovery() {
        try {
            connectivity = context.getSystemService(ConnectivityManager.class);
            if (connectivity == null) return;
            Network wifi = null;
            for (Network network : connectivity.getAllNetworks()) {
                NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(network);
                if (capabilities == null || !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue;
                wifi = network;
                if (bindToWifi && boundWifiNetwork == null && connectivity.bindProcessToNetwork(network)) {
                    boundWifiNetwork = network;
                    Log.i(TAG, "LAN discovery bound to Wi-Fi");
                }
                break;
            }
            if (wifi == null) return;
            LinkProperties properties = connectivity.getLinkProperties(wifi);
            String interfaceName = properties == null ? null : properties.getInterfaceName();
            NetworkInterface networkInterface = interfaceName == null ? null : NetworkInterface.getByName(interfaceName);
            if (networkInterface != null) mdnsProbe.start(wifi, networkInterface);
            udpProbe.start(wifi, properties);
        } catch (Exception error) {
            Log.w(TAG, "Cannot start direct LAN discovery", error);
            boundWifiNetwork = null;
        }
    }

    private void onProbeService(LanMdnsProbe.Result result) {
        if (result == null) return;
        synchronized (this) {
            if (!running) return;
        }
        String url;
        try { url = new Endpoint("https://" + result.address + ":" + result.port).origin(); }
        catch (IllegalArgumentException error) { return; }
        Service service = new Service(result.serviceName, result.computerId, result.name, url,
            result.fingerprint, result.joinable);
        synchronized (this) {
            for (Service existing : services.values()) {
                if (service.computerId.equals(existing.computerId)
                        && service.url.equals(existing.url)
                        && service.fingerprint.equals(existing.fingerprint)
                        && service.name.equals(existing.name)
                        && service.joinable == existing.joinable) return;
            }
            services.entrySet().removeIf(entry -> service.computerId.equals(entry.getValue().computerId));
            services.put(result.serviceName, service);
        }
        publish();
    }

    private void unbindProcessFromWifi() {
        Network bound;
        ConnectivityManager manager;
        synchronized (this) {
            bound = boundWifiNetwork;
            manager = connectivity;
            boundWifiNetwork = null;
        }
        if (bound == null || manager == null) return;
        try { manager.bindProcessToNetwork(null); }
        catch (Exception error) { Log.w(TAG, "Cannot restore the default network", error); }
    }

    private void releaseDiscoveryResources() {
        udpProbe.stop();
        mdnsProbe.stop();
        unbindProcessFromWifi();
        WifiManager.MulticastLock lock;
        synchronized (this) {
            lock = multicast;
            multicast = null;
        }
        if (lock == null) return;
        try { if (lock.isHeld()) lock.release(); }
        catch (Exception ignored) { }
    }

    private void clearResolutionQueue() {
        resolveQueue.clear();
        queuedServices.clear();
        resolving = false;
        resolveGeneration++;
    }

    private void removeQueued(String serviceName) {
        queuedServices.remove(serviceName);
        Iterator<NsdServiceInfo> iterator = resolveQueue.iterator();
        while (iterator.hasNext()) {
            if (serviceName.equals(iterator.next().getServiceName())) iterator.remove();
        }
    }

    private void publish() {
        List<Service> copy;
        synchronized (this) {
            copy = Collections.unmodifiableList(new ArrayList<>(services.values()));
        }
        if (listener == null) return;
        if (Looper.myLooper() == Looper.getMainLooper()) listener.onLanServices(copy);
        else handler.post(() -> listener.onLanServices(copy));
    }

    private void notifyStarted() {
        if (listener == null) return;
        if (Looper.myLooper() == Looper.getMainLooper()) listener.onLanDiscoveryStarted();
        else handler.post(listener::onLanDiscoveryStarted);
    }

    private void notifyFailed(int errorCode) {
        if (listener == null) return;
        if (Looper.myLooper() == Looper.getMainLooper()) listener.onLanDiscoveryFailed(errorCode);
        else handler.post(() -> listener.onLanDiscoveryFailed(errorCode));
    }

    private void runOnMain(Runnable action) {
        if (Looper.myLooper() == Looper.getMainLooper()) action.run();
        else handler.post(action);
    }

    synchronized List<Service> current() {
        return new ArrayList<>(services.values());
    }

    synchronized boolean isRunning() { return running; }

    synchronized void stop() { stop(true); }

    synchronized void stop(boolean clear) {
        runOnMain(() -> {
            synchronized (LanDiscovery.this) {
                running = false;
                clearResolutionQueue();
                bindToWifi = false;
                if (clear) services.clear();
            }
            if (clear) publish();
            stopDiscovery();
        });
    }
}
