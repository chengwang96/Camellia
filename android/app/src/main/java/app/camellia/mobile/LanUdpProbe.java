package app.camellia.mobile;

import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.util.Log;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;

final class LanUdpProbe {
    static final int PORT = 52638;
    private static final String TAG = "CamelliaLan";
    private static final String QUERY = "CAMELLIA_DISCOVER_V1";
    private static final String MULTICAST_ADDRESS = "239.192.52.63";
    private static final long QUERY_INTERVAL_MS = 1_000;

    interface Listener {
        void onLanService(LanMdnsProbe.Result service);
    }

    private final Listener listener;
    private volatile boolean running;
    private DatagramSocket socket;
    private Thread thread;

    LanUdpProbe(Listener listener) {
        this.listener = listener;
    }

    synchronized void start(Network network, LinkProperties properties) {
        stop();
        if (network == null) return;
        running = true;
        thread = new Thread(() -> probe(network, properties), "camellia-lan-broadcast");
        thread.setDaemon(true);
        thread.start();
    }

    synchronized void stop() {
        running = false;
        DatagramSocket current = socket;
        socket = null;
        if (current != null) {
            try { current.close(); } catch (Exception ignored) { }
        }
        Thread active = thread;
        thread = null;
        if (active != null && active != Thread.currentThread()) active.interrupt();
    }

    private void probe(Network network, LinkProperties properties) {
        DatagramSocket current = null;
        try {
            current = new DatagramSocket(0);
            current.setBroadcast(true);
            current.setSoTimeout(500);
            network.bindSocket(current);
            synchronized (this) {
                if (!running) {
                    current.close();
                    return;
                }
                socket = current;
            }
            byte[] query = QUERY.getBytes(StandardCharsets.US_ASCII);
            List<InetAddress> targets = broadcastAddresses(properties);
            byte[] buffer = new byte[4096];
            long nextQuery = 0;
            while (running) {
                long now = System.currentTimeMillis();
                if (now >= nextQuery) {
                    for (InetAddress target : targets) {
                        try {
                            current.send(new DatagramPacket(query, query.length, target, PORT));
                        } catch (Exception error) {
                            Log.w(TAG, "LAN broadcast send failed for " + target.getHostAddress(), error);
                        }
                    }
                    nextQuery = now + QUERY_INTERVAL_MS;
                }
                try {
                    DatagramPacket incoming = new DatagramPacket(buffer, buffer.length);
                    current.receive(incoming);
                    String source = incoming.getAddress().getHostAddress();
                    if (!privateIPv4(source)) continue;
                    LanMdnsProbe.Result result = parse(new String(incoming.getData(),
                        incoming.getOffset(), incoming.getLength(), StandardCharsets.UTF_8));
                    if (running && result != null && listener != null) listener.onLanService(result);
                } catch (SocketTimeoutException ignored) {
                }
            }
        } catch (Exception error) {
            if (running) Log.w(TAG, "LAN broadcast discovery unavailable", error);
        } finally {
            if (current != null) {
                try { current.close(); } catch (Exception ignored) { }
            }
            synchronized (this) {
                if (socket == current) socket = null;
            }
        }
    }

    static LanMdnsProbe.Result parse(String payload) {
        if (payload == null || payload.length() > 4096) return null;
        try {
            JSONObject json = new JSONObject(payload);
            if (json.optInt("v", 0) != 1) return null;
            String id = json.optString("id");
            String address = json.optString("ip");
            String fingerprint = json.optString("fp");
            int port = json.optInt("port", 0);
            if (id.isEmpty() || address.isEmpty() || port < 1 || port > 65535
                    || !LanTls.validFingerprint(fingerprint)) return null;
            new Endpoint("https://" + address + ":" + port);
            String name = json.optString("name");
            String shortId = id.length() >= 8 ? id.substring(0, 8) : id;
            return new LanMdnsProbe.Result("Camellia " + shortId, id,
                name.isEmpty() ? "Camellia" : name, address, port,
                LanTls.normalize(fingerprint), json.optInt("join", 1) != 0);
        } catch (Exception error) {
            return null;
        }
    }

    private static boolean privateIPv4(String address) {
        try {
            new Endpoint("https://" + address + ":1");
            return true;
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    private static List<InetAddress> broadcastAddresses(LinkProperties properties) throws Exception {
        Map<String, InetAddress> values = new LinkedHashMap<>();
        InetAddress global = InetAddress.getByName("255.255.255.255");
        values.put(global.getHostAddress(), global);
        InetAddress multicast = InetAddress.getByName(MULTICAST_ADDRESS);
        values.put(multicast.getHostAddress(), multicast);
        if (properties != null) {
            for (LinkAddress link : properties.getLinkAddresses()) {
                InetAddress address = link.getAddress();
                if (!(address instanceof Inet4Address)) continue;
                int prefix = link.getPrefixLength();
                if (prefix < 1 || prefix > 30) continue;
                byte[] raw = address.getAddress();
                long value = ((raw[0] & 0xFFL) << 24) | ((raw[1] & 0xFFL) << 16)
                    | ((raw[2] & 0xFFL) << 8) | (raw[3] & 0xFFL);
                long mask = 0xFFFFFFFFL << (32 - prefix);
                long broadcast = (value & mask) | (~mask & 0xFFFFFFFFL);
                byte[] target = {
                    (byte) (broadcast >>> 24), (byte) (broadcast >>> 16),
                    (byte) (broadcast >>> 8), (byte) broadcast
                };
                InetAddress resolved = InetAddress.getByAddress(target);
                values.put(resolved.getHostAddress(), resolved);
            }
        }
        return new ArrayList<>(values.values());
    }
}
