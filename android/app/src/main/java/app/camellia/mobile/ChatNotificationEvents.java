package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

/** Baselines history, then emits only new events from snapshots actually received. */
final class ChatNotificationEvents {
    private static final int LIMIT = 512;
    private final Map<String, Marker> markers = new LinkedHashMap<>();
    private final LinkedHashSet<String> seen = new LinkedHashSet<>();
    private RemoteApprovalNotices approvals;
    int revision;

    private static final class Marker {
        long reply, seq;
        boolean details;
    }

    ChatNotificationEvents(String saved) {
        JSONObject json;
        try { json = new JSONObject(saved); } catch (Exception ignored) { json = new JSONObject(); }
        approvals = new RemoteApprovalNotices(json.optString("approvals", "[]"));
        JSONArray keys = json.optJSONArray("seen");
        for (int i = 0; keys != null && i < keys.length(); i++) if (!keys.optString(i).isEmpty()) seen.add(keys.optString(i));
        trim(seen);
    }

    List<String> conversation(String scope, JSONObject conversation, JSONObject live, JSONArray rows) {
        ArrayList<String> result = new ArrayList<>();
        long reply = Math.max(0, conversation.optLong("lastReplyAt"));
        long seq = 0; String state = "";
        for (int i = 0; rows != null && i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null || !row.optString("role").equals("assistant")) continue;
            TurnDetails details = new TurnDetails(row.optJSONObject("turnDetails"));
            if (details.terminal() && row.optLong("seq") > seq) { seq = row.optLong("seq"); state = details.state; }
        }
        Marker previous = markers.get(scope);
        boolean freshReply = previous != null && reply > previous.reply;
        boolean freshTerminal = previous != null && previous.details && seq > previous.seq;
        if (state.equals("error") && (freshTerminal || freshReply) || freshReply && conversation.optString("activity").equals("error")) {
            if (claim(scope, "error", seq > 0 ? "seq:" + seq : "reply:" + reply)) result.add("error");
        } else if (!state.equals("stopped") && !state.equals("error") && (freshReply || freshTerminal && reply == 0 && state.equals("complete"))) {
            if (claim(scope, "reply", reply > 0 ? "reply:" + reply : "seq:" + seq)) result.add("reply");
        }
        if (previous == null) previous = new Marker();
        previous.reply = Math.max(previous.reply, reply); previous.seq = Math.max(previous.seq, seq);
        previous.details |= rows != null;
        markers.put(scope, previous); trimMarkers();
        JSONArray pending = live == null ? null : live.optJSONArray("approvals");
        if (approvals.observe(scope, pending)) { result.add("approval"); revision++; }
        return result;
    }

    List<String> discussion(String scope, JSONObject group) {
        ArrayList<String> result = new ArrayList<>();
        boolean baseline = !markers.containsKey(scope);
        JSONArray deliveries = group.optJSONArray("deliveries");
        for (int i = 0; deliveries != null && i < deliveries.length(); i++) {
            JSONObject delivery = deliveries.optJSONObject(i); if (delivery == null) continue;
            String status = delivery.optString("status"), id = delivery.optString("id");
            if (id.isEmpty()) continue;
            String type = status.equals("completed") ? "reply" : status.equals("failed") || status.equals("interrupted") ? "error" : "";
            if (!type.isEmpty() && claim(scope, type, id + ":" + delivery.optLong("runId") + ":" + status) && !baseline && !result.contains(type)) result.add(type);
        }
        markers.put(scope, new Marker()); trimMarkers();
        if (approvals.observe(scope, group.optJSONArray("pendingApprovals"))) { result.add("approval"); revision++; }
        return result;
    }

    boolean claim(String scope, String type, String id) {
        boolean fresh = seen.add(new JSONArray().put(scope).put(type).put(id).toString());
        if (fresh) revision++;
        trim(seen); return fresh;
    }

    private void trimMarkers() { while (markers.size() > LIMIT) markers.remove(markers.keySet().iterator().next()); }
    private static void trim(LinkedHashSet<String> values) { while (values.size() > LIMIT) values.remove(values.iterator().next()); }
    String serialize() {
        try { return new JSONObject().put("seen", new JSONArray(seen)).put("approvals", approvals.serialize()).toString(); }
        catch (Exception ignored) { return "{}"; }
    }
}
