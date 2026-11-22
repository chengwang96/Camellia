package app.camellia.mobile;

import static org.junit.Assert.*;
import java.io.IOException;
import org.json.JSONObject;
import org.junit.Test;

public class RemoteDeltaTest {
    @Test public void appendsTextAndRetainsUnchangedFields() throws Exception {
        JSONObject first = new JSONObject("{\"instanceId\":\"server\",\"cursor\":1,\"settings\":{\"model\":\"fixture\"},"
            + "\"live\":{\"runId\":7,\"eventSeq\":1,\"text\":\"你好🙂\",\"process\":[{\"type\":\"tool\",\"text\":\"ready\"}]}}");
        int length = first.getJSONObject("live").getString("text").length();
        JSONObject patch = new JSONObject().put("instanceId", "server").put("cursor", 2).put("delta", true)
            .put("live", new JSONObject().put("runId", 7).put("eventSeq", 2).put("textDelta", " next")
                .put("textBaseLength", length).put("baseEventSeq", 1));
        JSONObject merged = RemoteDelta.merge(first, patch);
        assertEquals("你好🙂 next", merged.getJSONObject("live").getString("text"));
        assertEquals(1, merged.getJSONObject("live").getJSONArray("process").length());
        assertEquals("fixture", merged.getJSONObject("settings").getString("model"));
        assertFalse(merged.has("delta"));
    }

    @Test public void acceptsFullReplacementAndRejectsMismatchedBase() throws Exception {
        JSONObject first = new JSONObject().put("live", new JSONObject().put("runId", 7).put("eventSeq", 1).put("text", "old"));
        JSONObject full = new JSONObject().put("live", new JSONObject().put("runId", 8).put("text", "new run"));
        assertEquals("new run", RemoteDelta.merge(first, full).getJSONObject("live").getString("text"));
        JSONObject replacement = new JSONObject().put("delta", true).put("live", new JSONObject()
            .put("runId", 7).put("eventSeq", 2).put("text", "replacement"));
        first.getJSONObject("live").put("process", new org.json.JSONArray().put(new JSONObject().put("text", "step")));
        assertEquals(1, RemoteDelta.merge(first, replacement).getJSONObject("live").getJSONArray("process").length());
        JSONObject invalid = new JSONObject().put("delta", true).put("live", new JSONObject()
            .put("runId", 7).put("baseEventSeq", 2).put("textBaseLength", 3).put("textDelta", "bad"));
        assertThrows(IOException.class, () -> RemoteDelta.merge(first, invalid));
    }
}
