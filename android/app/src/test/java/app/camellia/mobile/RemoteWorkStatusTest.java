package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class RemoteWorkStatusTest {
    @Test public void chatMovesFromReplyToToolApprovalAndBackToIdle() throws Exception {
        JSONObject conversation = new JSONObject().put("activity", "running");
        JSONObject tool = new JSONObject().put("type", "tool").put("status", "in_progress");
        JSONObject live = new JSONObject().put("process", new JSONArray().put(tool));
        assertEquals("Running tools…", RemoteWorkStatus.conversation(conversation, live, null, false));
        live.put("pendingApprovals", 1);
        assertEquals("Waiting for approval", RemoteWorkStatus.conversation(conversation, live, null, false));
        live.put("pendingApprovals", 0); tool.put("status", "completed");
        assertEquals("Replying…", RemoteWorkStatus.conversation(conversation, live, null, false));
        conversation.remove("activity");
        assertEquals("", RemoteWorkStatus.conversation(conversation, null, null, false));
    }

    @Test public void compactionWithoutALiveTurnDoesNotRequireUsageOrLeakTokens() throws Exception {
        JSONObject compact = new JSONObject().put("state", "running").put("used", 123456).put("cap", 222222);
        assertEquals("正在压缩上下文…", RemoteWorkStatus.conversation(null, null, compact, true));
        for (String terminal : new String[]{"completed", "failed", "cancelled"}) {
            compact.put("state", terminal);
            assertEquals("", RemoteWorkStatus.conversation(null, null, compact, true));
        }
    }

    @Test public void inputRequestsTakePriorityOverCompactionAndOtherAgents() throws Exception {
        JSONObject question = new JSONObject().put("questions", new JSONArray().put(new JSONObject().put("id", "choice")));
        JSONArray requests = new JSONArray().put(new JSONObject()).put(question);
        JSONObject live = new JSONObject().put("approvals", requests);
        JSONObject compact = new JSONObject().put("state", "running");
        assertEquals("等待你回答问题", RemoteWorkStatus.conversation(null, live, compact, true));
        JSONObject group = new JSONObject().put("active", true).put("pendingApprovals", requests);
        assertEquals("等待你回答问题", RemoteWorkStatus.discussion(group, true));
    }

    @Test public void readOnlyChatStillShowsHostWaitingState() throws Exception {
        assertEquals("等待审批", RemoteWorkStatus.conversation(new JSONObject().put("activity", "permission"), null, null, true));
        assertEquals("等待你回答问题", RemoteWorkStatus.conversation(new JSONObject().put("activity", "question"), null, null, true));
    }

    @Test public void finishedDiscussionToolsDoNotKeepTheStatusRunning() throws Exception {
        JSONObject old = new JSONObject().put("status", "completed").put("tools", new JSONArray()
            .put(new JSONObject().put("status", "running")));
        JSONObject current = new JSONObject().put("status", "preparing");
        JSONObject group = new JSONObject().put("deliveries", new JSONArray().put(old).put(current));
        assertEquals("Preparing reply…", RemoteWorkStatus.discussion(group, false));
        current.put("status", "running");
        assertEquals("Replying…", RemoteWorkStatus.discussion(group, false));
        current.put("tools", new JSONArray().put(new JSONObject().put("status", "running")));
        assertEquals("Running tools…", RemoteWorkStatus.discussion(group, false));
        current.put("status", "failed");
        assertEquals("", RemoteWorkStatus.discussion(group, false));
    }

    @Test public void discussionVerifyingAndStoppingAreNotGenericReplies() throws Exception {
        JSONObject group = new JSONObject().put("active", true).put("verifying", true);
        assertEquals("正在验证成员连接…", RemoteWorkStatus.discussion(group, true));
        group.put("stopping", true);
        assertEquals("正在停止…", RemoteWorkStatus.discussion(group, true));
    }
}
