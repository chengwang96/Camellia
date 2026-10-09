package app.camellia.mobile;

import org.json.JSONObject;
import org.json.JSONException;

/** Durable requests are scoped to a conversation; stop has an independent slot. */
final class RemotePendingCommands {
    private static String slot(boolean stop) { return stop ? "pendingStops" : "pendingCommands"; }
    static JSONObject get(JSONObject profile, String conversation, boolean stop) {
        JSONObject all = profile.optJSONObject(slot(stop));
        JSONObject value = all == null || conversation == null ? null : all.optJSONObject(conversation);
        if (value != null || stop) return value;
        JSONObject legacy = profile.optJSONObject("pendingCommand");
        return legacy != null && legacy.optString("conversationId").equals(conversation) ? legacy : null;
    }
    static JSONObject find(JSONObject profile, String request) {
        for (String name : new String[]{"pendingCommands", "pendingStops"}) {
            JSONObject all = profile.optJSONObject(name);
            if (all == null) continue;
            var keys = all.keys();
            while (keys.hasNext()) {
                JSONObject value = all.optJSONObject(keys.next());
                if (matches(value, request)) return value;
            }
        }
        JSONObject legacy = profile.optJSONObject("pendingCommand");
        return matches(legacy, request) ? legacy : null;
    }
    private static boolean matches(JSONObject value, String request) {
        JSONObject payload = value == null ? null : value.optJSONObject("payload");
        return payload != null && request.equals(payload.optString("requestId"));
    }
    static void put(JSONObject profile, JSONObject value, boolean stop) throws JSONException {
        if (stop) {
            JSONObject stops = profile.optJSONObject("pendingStops");
            if (stops == null) { stops = new JSONObject(); profile.put("pendingStops", stops); }
            stops.put(value.getString("conversationId"), value); return;
        }
        JSONObject legacy = profile.optJSONObject("pendingCommand");
        JSONObject all = profile.optJSONObject("pendingCommands");
        if (all == null && (legacy == null || legacy.optString("conversationId").equals(value.getString("conversationId")))) {
            profile.put("pendingCommand", value); return;
        }
        if (all == null) { all = new JSONObject(); profile.put("pendingCommands", all); }
        if (legacy != null) {
            if (!all.has(legacy.optString("conversationId"))) all.put(legacy.optString("conversationId"), legacy);
        }
        profile.remove("pendingCommand");
        all.put(value.getString("conversationId"), value);
    }
    static void remove(JSONObject profile, String request) {
        for (String name : new String[]{"pendingCommands", "pendingStops"}) {
            JSONObject all = profile.optJSONObject(name);
            if (all == null) continue;
            var keys = new java.util.ArrayList<String>(); all.keys().forEachRemaining(keys::add);
            for (String key : keys) if (matches(all.optJSONObject(key), request)) all.remove(key);
            if (all.length() == 0) profile.remove(name);
        }
        if (matches(profile.optJSONObject("pendingCommand"), request)) profile.remove("pendingCommand");
    }
    private RemotePendingCommands() { }
}
