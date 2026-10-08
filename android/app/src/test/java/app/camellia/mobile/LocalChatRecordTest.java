package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class LocalChatRecordTest {
    @Test public void detachedSnapshotKeepsStringsWithoutSerializingThem() throws Exception {
        String content = "large history".repeat(10000);
        JSONObject original = new JSONObject().put("content", content).put("nested", new JSONArray().put(new JSONObject().put("state", "running")));
        JSONObject snapshot = LocalChatRecord.object(original);
        original.getJSONArray("nested").getJSONObject(0).put("state", "complete");
        assertEquals("running", snapshot.getJSONArray("nested").getJSONObject(0).getString("state"));
        assertSame(content, snapshot.getString("content"));
    }

    @Test public void migrationComparisonAcceptsJsonNumericRepresentations() throws Exception {
        JSONObject original = new JSONObject().put("small", 1L).put("at", 1791360000000L)
            .put("values", new JSONArray().put(1.0).put(JSONObject.NULL));
        assertTrue(LocalChatRecord.same(original, new JSONObject(original.toString())));
        assertFalse(LocalChatRecord.same(original, new JSONObject(original.toString()).put("small", 2)));
    }
}
