package app.camellia.mobile;

import android.net.Network;
import android.util.Log;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.DatagramPacket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

final class LanMdnsProbe {
    private static final String TAG = "CamelliaLan";
    private static final String SERVICE_NAME = "_camellia._tcp.local";
    private static final String GROUP_ADDRESS = "224.0.0.251";
    private static final int MDNS_PORT = 5353;
    private static final long QUERY_INTERVAL_MS = 1_500;

    interface Listener {
        void onLanService(Result service);
    }

    static final class Result {
        final String serviceName;
        final String computerId;
        final String name;
        final String address;
        final int port;
        final String fingerprint;
        final boolean joinable;

        Result(String serviceName, String computerId, String name, String address, int port,
               String fingerprint, boolean joinable) {
            this.serviceName = serviceName;
            this.computerId = computerId;
            this.name = name;
            this.address = address;
            this.port = port;
            this.fingerprint = fingerprint;
            this.joinable = joinable;
        }
    }

    private final Listener listener;
    private volatile boolean running;
    private MulticastSocket socket;
    private Thread thread;

    LanMdnsProbe(Listener listener) {
        this.listener = listener;
    }

    synchronized void start(Network network, NetworkInterface networkInterface) {
        stop();
        if (network == null || networkInterface == null) return;
        running = true;
        thread = new Thread(() -> probe(network, networkInterface), "camellia-mdns-probe");
        thread.setDaemon(true);
        thread.start();
    }

    synchronized void stop() {
        running = false;
        MulticastSocket current = socket;
        socket = null;
        if (current != null) {
            try { current.close(); } catch (Exception ignored) { }
        }
        Thread active = thread;
        thread = null;
        if (active != null && active != Thread.currentThread()) active.interrupt();
    }

    private void probe(Network network, NetworkInterface networkInterface) {
        MulticastSocket current = null;
        try {
            current = createSocket(network, networkInterface);
            synchronized (this) {
                if (!running) {
                    current.close();
                    return;
                }
                socket = current;
            }
            byte[] query = buildQuery();
            byte[] buffer = new byte[9000];
            long nextQuery = 0;
            while (running) {
                long now = System.currentTimeMillis();
                if (now >= nextQuery) {
                    DatagramPacket outgoing = new DatagramPacket(query, query.length,
                        InetAddress.getByName(GROUP_ADDRESS), MDNS_PORT);
                    current.send(outgoing);
                    nextQuery = now + QUERY_INTERVAL_MS;
                }
                try {
                    DatagramPacket incoming = new DatagramPacket(buffer, buffer.length);
                    current.receive(incoming);
                    for (Result result : parse(incoming.getData(), incoming.getLength())) {
                        if (running && listener != null) listener.onLanService(result);
                    }
                } catch (SocketTimeoutException ignored) {
                }
            }
        } catch (Exception error) {
            if (running) Log.w(TAG, "Direct mDNS probe unavailable", error);
        } finally {
            if (current != null) {
                try { current.close(); } catch (Exception ignored) { }
            }
            synchronized (this) {
                if (socket == current) socket = null;
            }
        }
    }

    private static MulticastSocket createSocket(Network network, NetworkInterface networkInterface)
            throws IOException {
        MulticastSocket current = null;
        try {
            current = new MulticastSocket(null);
            current.setReuseAddress(true);
            current.bind(new InetSocketAddress(MDNS_PORT));
        } catch (IOException error) {
            if (current != null) current.close();
            current = new MulticastSocket(0);
            current.setReuseAddress(true);
        }
        current.setSoTimeout(650);
        current.setTimeToLive(1);
        network.bindSocket(current);
        current.setNetworkInterface(networkInterface);
        current.joinGroup(new InetSocketAddress(InetAddress.getByName(GROUP_ADDRESS), MDNS_PORT),
            networkInterface);
        return current;
    }

    private static byte[] buildQuery() throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream output = new DataOutputStream(bytes);
        output.writeShort(0);
        output.writeShort(0);
        output.writeShort(1);
        output.writeShort(0);
        output.writeShort(0);
        output.writeShort(0);
        for (String label : SERVICE_NAME.split("\\.")) {
            byte[] value = label.getBytes(StandardCharsets.US_ASCII);
            output.writeByte(value.length);
            output.write(value);
        }
        output.writeByte(0);
        output.writeShort(12);
        output.writeShort(0x8001);
        output.flush();
        return bytes.toByteArray();
    }

    static List<Result> parse(byte[] data, int length) {
        if (data == null || length < 12) return Collections.emptyList();
        try {
            DataInputStream input = new DataInputStream(new ByteArrayInputStream(data, 0, length));
            input.readUnsignedShort();
            input.readUnsignedShort();
            int questions = input.readUnsignedShort();
            int answers = input.readUnsignedShort();
            int authorities = input.readUnsignedShort();
            int additional = input.readUnsignedShort();
            int[] position = {12};
            for (int index = 0; index < questions; index++) {
                readName(data, position, length);
                skip(data, position, length, 4);
            }
            Map<String, Integer> ports = new HashMap<>();
            Map<String, String> targets = new HashMap<>();
            Map<String, Map<String, String>> records = new HashMap<>();
            Map<String, String> addresses = new HashMap<>();
            int count = answers + authorities + additional;
            for (int index = 0; index < count; index++) {
                String owner = normalize(readName(data, position, length));
                int type = readUnsignedShort(data, position, length);
                readUnsignedShort(data, position, length);
                skip(data, position, length, 4);
                int size = readUnsignedShort(data, position, length);
                if (position[0] + size > length) break;
                int start = position[0];
                if (type == 33 && size >= 7) {
                    int port = ((data[start + 4] & 0xFF) << 8) | (data[start + 5] & 0xFF);
                    int[] targetPosition = {start + 6};
                    String target = normalize(readName(data, targetPosition, length));
                    if (port > 0 && owner.endsWith("." + SERVICE_NAME)) {
                        ports.put(owner, port);
                        targets.put(owner, target);
                    }
                } else if (type == 16 && owner.endsWith("." + SERVICE_NAME)) {
                    records.put(owner, readTxt(data, start, size));
                } else if (type == 1 && size == 4) {
                    addresses.put(owner, (data[start] & 0xFF) + "." + (data[start + 1] & 0xFF)
                        + "." + (data[start + 2] & 0xFF) + "." + (data[start + 3] & 0xFF));
                }
                position[0] = start + size;
            }
            List<Result> results = new ArrayList<>();
            for (Map.Entry<String, Integer> entry : ports.entrySet()) {
                String instance = entry.getKey();
                Map<String, String> txt = records.get(instance);
                if (txt == null) continue;
                String id = value(txt, "id");
                String fingerprint = value(txt, "fp");
                String address = value(txt, "ip");
                if (address.isEmpty()) address = addresses.getOrDefault(targets.get(instance), "");
                if (id.isEmpty() || address.isEmpty() || !LanTls.validFingerprint(fingerprint)) continue;
                if (instance.length() <= SERVICE_NAME.length() + 1) continue;
                String serviceName = instance.substring(0, instance.length() - SERVICE_NAME.length() - 1);
                results.add(new Result(serviceName, id, value(txt, "name"), address, entry.getValue(),
                    LanTls.normalize(fingerprint), !"0".equals(value(txt, "join"))));
            }
            return results;
        } catch (Exception error) {
            Log.w(TAG, "Cannot parse direct mDNS response", error);
            return Collections.emptyList();
        }
    }

    private static Map<String, String> readTxt(byte[] data, int start, int size) {
        Map<String, String> values = new HashMap<>();
        int position = start;
        int end = start + size;
        while (position < end) {
            int length = data[position++] & 0xFF;
            if (length == 0 || position + length > end) break;
            String record = new String(data, position, length, StandardCharsets.UTF_8);
            position += length;
            int equals = record.indexOf('=');
            if (equals > 0) values.put(record.substring(0, equals), record.substring(equals + 1));
        }
        return values;
    }

    private static String value(Map<String, String> values, String key) {
        String value = values.get(key);
        return value == null ? "" : value;
    }

    private static String readName(byte[] data, int[] position, int limit) {
        StringBuilder name = new StringBuilder();
        int cursor = position[0];
        int returnPosition = -1;
        int steps = 0;
        while (cursor >= 0 && cursor < limit && steps++ < 128) {
            int length = data[cursor++] & 0xFF;
            if (length == 0) {
                if (returnPosition < 0) position[0] = cursor;
                else position[0] = returnPosition;
                return name.toString();
            }
            if ((length & 0xC0) == 0xC0) {
                if (cursor >= limit) break;
                int pointer = ((length & 0x3F) << 8) | (data[cursor++] & 0xFF);
                if (returnPosition < 0) returnPosition = cursor;
                cursor = pointer;
                continue;
            }
            if ((length & 0xC0) != 0 || cursor + length > limit) break;
            if (name.length() > 0) name.append('.');
            name.append(new String(data, cursor, length, StandardCharsets.UTF_8));
            cursor += length;
        }
        position[0] = Math.min(limit, Math.max(position[0], cursor));
        return name.toString();
    }

    private static int readUnsignedShort(byte[] data, int[] position, int limit) {
        if (position[0] + 2 > limit) throw new IllegalArgumentException("Truncated DNS record");
        int value = ((data[position[0]] & 0xFF) << 8) | (data[position[0] + 1] & 0xFF);
        position[0] += 2;
        return value;
    }

    private static void skip(byte[] data, int[] position, int limit, int count) {
        if (position[0] + count > limit) throw new IllegalArgumentException("Truncated DNS record");
        position[0] += count;
    }

    private static String normalize(String value) {
        String result = value == null ? "" : value.toLowerCase(Locale.ROOT);
        while (result.endsWith(".")) result = result.substring(0, result.length() - 1);
        return result;
    }
}
