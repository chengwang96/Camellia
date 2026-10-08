package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.LinkedHashSet;

/** Remembers request identities across snapshots, reconnects and page recreation. */
final class RemoteApprovalNotices {
    private static final int HISTORY_LIMIT = 256;
    private final LinkedHashSet<String> seen = new LinkedHashSet<>();

    RemoteApprovalNotices(String saved) {
        try {
            JSONArray values = new JSONArray(saved);
            for (int index = 0; index < values.length(); index++) {
                String key = values.optString(index);
                if (!key.isEmpty()) seen.add(key);
            }
        } catch (Exception ignored) { }
    }

    boolean observe(String scope, JSONArray requests) {
        if (scope == null || scope.isEmpty() || requests == null) return false;
        LinkedHashSet<String> current = new LinkedHashSet<>();
        for (int index = 0; index < requests.length(); index++) {
            JSONObject request = requests.optJSONObject(index);
            if (request == null) continue;
            String id = request.optString("requestId");
            if (id.isEmpty()) id = request.optString("fingerprint");
            if (id.isEmpty()) continue;
            current.add(new JSONArray().put(scope).put(request.optString("runId"))
                .put(request.optString("deliveryId")).put(request.optString("participantId")).put(id).toString());
        }
        boolean fresh = !seen.containsAll(current);
        seen.addAll(current);
        // Keep every currently pending request even if a batch exceeds the history limit.
        var oldest = seen.iterator();
        while (seen.size() > HISTORY_LIMIT && oldest.hasNext()) {
            if (!current.contains(oldest.next())) oldest.remove();
        }
        return fresh;
    }

    String serialize() { return new JSONArray(seen).toString(); }
}
