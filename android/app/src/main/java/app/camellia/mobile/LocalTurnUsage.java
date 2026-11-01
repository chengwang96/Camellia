package app.camellia.mobile;

import org.json.JSONObject;

/** Converts reported accounting to desktop's uncached input and cache buckets. */
final class LocalTurnUsage {
    private static final String[] KEYS = {"input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"};
    private JSONObject total;

    static JSONObject normalize(JSONObject raw, boolean anthropic) throws org.json.JSONException {
        JSONObject usage = new JSONObject(); if (raw == null) return usage;
        if (anthropic) {
            for (String key : KEYS) { Long value = count(raw, key); if (value != null) usage.put(key, value); }
        } else {
            Long prompt = count(raw, "prompt_tokens"), output = count(raw, "completion_tokens"), cached = count(raw, "prompt_cache_hit_tokens");
            if (cached == null) cached = count(raw.optJSONObject("prompt_tokens_details"), "cached_tokens");
            if (prompt != null && (cached == null || cached <= prompt)) usage.put("input_tokens", prompt - (cached == null ? 0 : cached));
            if (output != null) usage.put("output_tokens", output);
            if (cached != null) usage.put("cache_read_input_tokens", cached);
        }
        return usage;
    }
    private static Long count(JSONObject raw, String key) {
        Double value = TurnDetails.number(raw, key);
        return value != null && value == Math.floor(value) ? value.longValue() : null;
    }

    JSONObject add(JSONObject usage) throws org.json.JSONException {
        if (total == null) total = new JSONObject(usage.toString());
        else for (String key : KEYS) {
            if (total.has(key) && usage.has(key)) total.put(key, total.getLong(key) + usage.getLong(key));
            else total.remove(key); // Missing in any call means the turn's bucket is unknown.
        }
        return new JSONObject(total.toString());
    }
}
