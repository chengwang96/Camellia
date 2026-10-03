package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

/** Work state from the host, independent of connection messages and token usage. */
final class RemoteWorkStatus {
    private static String label(boolean zh, String chinese, String english) { return zh ? chinese : english; }
    private static int size(JSONArray value) { return value == null ? 0 : value.length(); }

    static String approval(JSONArray requests, boolean zh) {
        for (int i = 0; i < size(requests); i++) {
            JSONObject request = requests.optJSONObject(i);
            if (request != null && size(request.optJSONArray("questions")) > 0) return label(zh, "等待你回答问题", "Waiting for your answer");
        }
        return label(zh, "等待审批", "Waiting for approval");
    }

    private static boolean workingTool(JSONArray process, boolean typed) {
        for (int i = 0; i < size(process); i++) {
            JSONObject item = process.optJSONObject(i); if (item == null) continue;
            if (typed && !item.optString("type").equals("tool")) continue;
            String status = item.optString("status");
            if (status.equals("running") || status.equals("in_progress")) return true;
        }
        return false;
    }

    static String conversation(JSONObject conversation, JSONObject live, JSONObject compaction, boolean zh) {
        String activity = conversation == null ? "" : conversation.optString("activity");
        if (live != null && (live.optInt("pendingApprovals") > 0 || size(live.optJSONArray("approvals")) > 0))
            return approval(live.optJSONArray("approvals"), zh);
        if (activity.equals("question")) return label(zh, "等待你回答问题", "Waiting for your answer");
        if (activity.equals("permission")) return label(zh, "等待审批", "Waiting for approval");
        if (compaction != null && compaction.optString("state").equals("running")) return label(zh, "正在压缩上下文…", "Compacting context…");
        if (live != null && workingTool(live.optJSONArray("process"), true)) return label(zh, "正在执行工具…", "Running tools…");
        if (live != null || activity.equals("running")) return label(zh, "正在回复…", "Replying…");
        return "";
    }

    static String discussion(JSONObject group, boolean zh) {
        if (group == null) return "";
        if (group.optBoolean("stopping")) return label(zh, "正在停止…", "Stopping…");
        if (size(group.optJSONArray("pendingApprovals")) > 0) return approval(group.optJSONArray("pendingApprovals"), zh);
        if (group.optBoolean("verifying")) return label(zh, "正在验证成员连接…", "Verifying member connections…");
        boolean running = false, preparing = false, queued = false, tools = false;
        JSONArray deliveries = group.optJSONArray("deliveries");
        for (int i = 0; i < size(deliveries); i++) {
            JSONObject delivery = deliveries.optJSONObject(i); if (delivery == null) continue;
            switch (delivery.optString("status")) {
                case "stopping": return label(zh, "正在停止…", "Stopping…");
                case "preparing": preparing = true; break;
                case "queued": queued = true; break;
                case "running":
                    if (delivery.optString("phase").equals("approval")) return label(zh, "等待审批", "Waiting for approval");
                    running = true; tools |= workingTool(delivery.optJSONArray("tools"), false); break;
                default: break; // Old tools in completed deliveries are not current work.
            }
        }
        if (tools) return label(zh, "正在执行工具…", "Running tools…");
        if (running) return label(zh, "正在回复…", "Replying…");
        if (preparing) return label(zh, "正在准备回复…", "Preparing reply…");
        if (queued) return label(zh, "等待成员回复…", "Waiting for replies…");
        if (group.optBoolean("active")) return label(zh, "正在回复…", "Replying…");
        return "";
    }
}
