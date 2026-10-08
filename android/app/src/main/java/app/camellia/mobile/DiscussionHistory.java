package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/** Phone presentation records only; the host owns durable history and native sessions. */
final class DiscussionHistory {
    static final int MAX_MESSAGES = 600;
    static final long MAX_BYTES = 4L * 1024 * 1024;
    private static final Set<String> OPEN = Set.of("queued", "preparing", "running", "stopping");
    private static final Set<String> FAILED = Set.of("failed", "cancelled", "interrupted");
    final TreeMap<Long, JSONObject> messages = new TreeMap<>();
    final LinkedHashMap<String, JSONObject> deliveries = new LinkedHashMap<>();
    final LinkedHashMap<String, JSONObject> requests = new LinkedHashMap<>();
    private final Map<Long, Long> messageWeights = new HashMap<>();
    private final Map<String, Long> deliveryWeights = new HashMap<>(), requestWeights = new HashMap<>();
    private final Set<String> protectedDeliveries = new HashSet<>(), protectedRequests = new HashSet<>();
    private long bytes, historyBytes;
    private int historyMessages;
    private boolean limited;
    JSONObject group;

    long estimatedBytes() { return bytes; }
    long historyBytes() { return historyBytes; }
    int historyMessages() { return historyMessages; }
    boolean limited() { return limited; }
    boolean protectedDelivery(String id) { return protectedDeliveries.contains(id); }

    void clear() {
        messages.clear(); deliveries.clear(); requests.clear();
        messageWeights.clear(); deliveryWeights.clear(); requestWeights.clear();
        protectedDeliveries.clear(); protectedRequests.clear();
        bytes = historyBytes = 0; historyMessages = 0; limited = false; group = null;
    }

    void merge(JSONObject incoming, boolean older) {
        Set<String> incomingDeliveries = new HashSet<>();
        for (JSONObject record : rows(incoming.optJSONArray("requests")))
            if (!older || !requests.containsKey(record.optString("id")))
                retain(requests, requestWeights, record.optString("id"), record);
        for (JSONObject record : rows(incoming.optJSONArray("deliveries"))) {
            String id = record.optString("id"); incomingDeliveries.add(id);
            // History pages may predate an SSE completion/retry. They cannot
            // replace a newer delivery or resurrect absent live work.
            if (older && (deliveries.containsKey(id) || OPEN.contains(record.optString("status")))) continue;
            retain(deliveries, deliveryWeights, id, record);
        }
        for (JSONObject record : rows(incoming.optJSONArray("messages"))) {
            long seq = record.optLong("seq");
            if (!older || !messages.containsKey(seq)) retain(messages, messageWeights, seq, record);
        }
        if (!older) {
            protectedDeliveries.clear(); protectedRequests.clear();
            for (JSONObject record : rows(incoming.optJSONArray("deliveries"))) {
                JSONObject request = requests.get(record.optString("requestId"));
                if (OPEN.contains(record.optString("status")) || request != null && request.optString("mode").equals("serial")
                    && FAILED.contains(record.optString("status")) && record.optString("serialResolution").isEmpty())
                    protect(record.optString("id"));
            }
            for (JSONObject approval : rows(incoming.optJSONArray("pendingApprovals"))) protect(approval.optString("deliveryId"));
            Iterator<Map.Entry<String, JSONObject>> stale = deliveries.entrySet().iterator();
            while (stale.hasNext()) {
                Map.Entry<String, JSONObject> entry = stale.next();
                if (OPEN.contains(entry.getValue().optString("status")) && !incomingDeliveries.contains(entry.getKey())) {
                    bytes -= deliveryWeights.remove(entry.getKey()); stale.remove();
                }
            }
            group = metadata(incoming);
        }
        removeOrphans();
        trim();
    }

    private void protect(String id) {
        protectedDeliveries.add(id);
        JSONObject delivery = deliveries.get(id);
        if (delivery != null && !delivery.optString("requestId").isEmpty()) protectedRequests.add(delivery.optString("requestId"));
    }

    private <K> void retain(Map<K, JSONObject> records, Map<K, Long> weights, K key, JSONObject record) {
        long weight = weight(record); Long previous = weights.put(key, weight);
        bytes += weight - (previous == null ? 0 : previous); records.put(key, record);
    }

    private void removeOrphans() {
        Set<String> neededRequests = new HashSet<>(protectedRequests), neededDeliveries = new HashSet<>(protectedDeliveries);
        for (JSONObject message : messages.values()) {
            if (!requestOf(message).isEmpty()) neededRequests.add(requestOf(message));
            if (!message.optString("deliveryId").isEmpty()) neededDeliveries.add(message.optString("deliveryId"));
        }
        Iterator<Map.Entry<String, JSONObject>> tasks = deliveries.entrySet().iterator();
        while (tasks.hasNext()) {
            Map.Entry<String, JSONObject> entry = tasks.next(); String requestId = entry.getValue().optString("requestId");
            if (neededDeliveries.contains(entry.getKey()) || neededRequests.contains(requestId)) {
                if (!requestId.isEmpty()) neededRequests.add(requestId);
            } else { bytes -= deliveryWeights.remove(entry.getKey()); tasks.remove(); }
        }
        Iterator<String> commands = requests.keySet().iterator();
        while (commands.hasNext()) {
            String id = commands.next();
            if (!neededRequests.contains(id)) { bytes -= requestWeights.remove(id); commands.remove(); }
        }
    }

    private static final class Bundle {
        final String requestId;
        final List<Long> messages = new ArrayList<>();
        final List<String> deliveries = new ArrayList<>();
        long bytes;
        boolean protectedRecord;
        Bundle(String requestId) { this.requestId = requestId; }
    }
    private String requestOf(JSONObject message) {
        String id = message.optString("requestId");
        JSONObject delivery = deliveries.get(message.optString("deliveryId"));
        return id.isEmpty() && delivery != null ? delivery.optString("requestId") : id;
    }
    private void trim() {
        LinkedHashMap<String, Bundle> bundles = new LinkedHashMap<>(); Map<String, Bundle> byDelivery = new HashMap<>();
        for (Map.Entry<Long, JSONObject> entry : messages.entrySet()) {
            String requestId = requestOf(entry.getValue());
            String key = requestId.isEmpty() ? "message:" + entry.getKey() : "request:" + requestId;
            Bundle bundle = bundles.computeIfAbsent(key, ignored -> new Bundle(requestId));
            bundle.messages.add(entry.getKey()); bundle.bytes += messageWeights.get(entry.getKey());
            String deliveryId = entry.getValue().optString("deliveryId");
            if (!deliveryId.isEmpty()) byDelivery.put(deliveryId, bundle);
            bundle.protectedRecord |= protectedRequests.contains(requestId) || protectedDeliveries.contains(deliveryId);
        }
        for (Map.Entry<String, JSONObject> entry : deliveries.entrySet()) {
            Bundle bundle = bundles.get("request:" + entry.getValue().optString("requestId"));
            if (bundle == null) bundle = byDelivery.get(entry.getKey());
            if (bundle != null) {
                bundle.deliveries.add(entry.getKey()); bundle.bytes += deliveryWeights.get(entry.getKey());
                bundle.protectedRecord |= protectedDeliveries.contains(entry.getKey());
            }
        }
        for (Map.Entry<String, Long> entry : requestWeights.entrySet()) {
            Bundle bundle = bundles.get("request:" + entry.getKey()); if (bundle != null) bundle.bytes += entry.getValue();
        }
        historyMessages = 0; historyBytes = 0;
        for (Bundle bundle : bundles.values()) if (!bundle.protectedRecord) {
            historyMessages += bundle.messages.size(); historyBytes += bundle.bytes;
        }
        for (Bundle bundle : bundles.values()) {
            if (historyMessages <= MAX_MESSAGES && historyBytes <= MAX_BYTES) break;
            if (bundle.protectedRecord) continue;
            for (Long seq : bundle.messages) { messages.remove(seq); bytes -= messageWeights.remove(seq); }
            for (String id : bundle.deliveries) { deliveries.remove(id); bytes -= deliveryWeights.remove(id); }
            if (requests.remove(bundle.requestId) != null) bytes -= requestWeights.remove(bundle.requestId);
            historyMessages -= bundle.messages.size(); historyBytes -= bundle.bytes; limited = true;
        }
        if (historyMessages >= MAX_MESSAGES || historyBytes >= MAX_BYTES) limited = true;
    }

    private JSONObject metadata(JSONObject incoming) {
        JSONObject result = new JSONObject();
        try {
            for (String key : new String[] {"id", "title", "pinned", "revision", "seq", "stopping", "verifying", "permissionMode", "participants", "active", "pendingApprovals"})
                if (incoming.has(key)) result.put(key, incoming.opt(key));
            JSONArray current = new JSONArray();
            for (JSONObject record : rows(incoming.optJSONArray("deliveries")))
                if (OPEN.contains(record.optString("status"))) current.put(record);
            result.put("deliveries", current);
        } catch (org.json.JSONException error) { throw new IllegalArgumentException(error); }
        return result;
    }

    private static List<JSONObject> rows(JSONArray array) {
        List<JSONObject> result = new ArrayList<>();
        for (int i = 0; array != null && i < array.length(); i++) if (array.optJSONObject(i) != null) result.add(array.optJSONObject(i));
        return result;
    }
    // UTF-16 text plus small structural weights: a retention budget, not a heap
    // measurement. Count only replaced input records; never serialize the cache.
    static long weight(Object value) {
        if (value instanceof String) return 24 + 2L * ((String) value).length();
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value; long bytes = 32 + 8L * array.length();
            for (int i = 0; i < array.length(); i++) bytes += weight(array.opt(i)); return bytes;
        }
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value; long bytes = 64; Iterator<String> keys = object.keys();
            while (keys.hasNext()) { String key = keys.next(); bytes += 16 + 2L * key.length() + weight(object.opt(key)); } return bytes;
        }
        return value == null || value == JSONObject.NULL ? 0 : 8;
    }
}
