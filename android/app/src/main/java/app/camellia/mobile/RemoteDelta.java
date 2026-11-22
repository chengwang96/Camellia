package app.camellia.mobile;

import java.io.IOException;
import org.json.JSONException;
import org.json.JSONObject;

final class RemoteDelta {
    private RemoteDelta() {}

    static JSONObject merge(JSONObject previous, JSONObject patch) throws IOException {
        try {
            if (previous == null || !patch.optBoolean("delta")) return patch;
            JSONObject merged = new JSONObject(previous.toString());
            for (java.util.Iterator<String> keys = patch.keys(); keys.hasNext();) {
                String key = keys.next();
                merged.put(key, patch.opt(key));
            }
            JSONObject update = patch.optJSONObject("live");
            if (update != null) {
                JSONObject before = previous.optJSONObject("live");
                if (before != null && before.optLong("runId") == update.optLong("runId")
                        && !update.has("process") && before.has("process")) {
                    update.put("process", before.opt("process"));
                }
                if (update.has("textDelta")) {
                    if (before == null || before.optLong("runId") != update.optLong("runId")
                            || before.optLong("eventSeq") != update.optLong("baseEventSeq")
                            || before.optString("text").length() != update.optInt("textBaseLength")) {
                        throw new IOException("Live delta has no matching snapshot");
                    }
                    update.put("text", before.optString("text") + update.optString("textDelta"));
                    update.remove("textDelta");
                    update.remove("textBaseLength");
                    update.remove("baseEventSeq");
                }
                merged.put("live", update);
            }
            merged.remove("delta");
            return merged;
        } catch (JSONException error) {
            throw new IOException("Invalid snapshot delta", error);
        }
    }
}
