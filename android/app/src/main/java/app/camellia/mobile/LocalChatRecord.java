package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.Set;

/** Detached record snapshots; copying strings does not serialize the chat history. */
final class LocalChatRecord {
    static final Set<String> DRAFT = Set.of("draft", "draftEditIndex", "draftImages", "draftDocuments");

    static Object copy(Object value) throws JSONException {
        if (value instanceof JSONObject) {
            JSONObject result = new JSONObject();
            var keys = ((JSONObject) value).keys();
            while (keys.hasNext()) { String key = keys.next(); result.put(key, copy(((JSONObject) value).get(key))); }
            return result;
        }
        if (value instanceof JSONArray) {
            JSONArray result = new JSONArray();
            for (int index = 0; index < ((JSONArray) value).length(); index++) result.put(copy(((JSONArray) value).get(index)));
            return result;
        }
        return value;
    }

    static JSONObject object(JSONObject value) throws JSONException { return (JSONObject) copy(value); }

    static JSONObject metadata(JSONObject conversation) throws JSONException {
        JSONObject result = new JSONObject();
        var keys = conversation.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (!key.equals("messages") && !DRAFT.contains(key)) result.put(key, copy(conversation.get(key)));
        }
        return result;
    }

    static JSONObject draft(JSONObject conversation) throws JSONException {
        JSONObject result = new JSONObject();
        for (String key : DRAFT) if (conversation.has(key)) result.put(key, copy(conversation.get(key)));
        return result;
    }

    static boolean same(Object left, Object right) throws JSONException {
        if (left == right) return true;
        if (left instanceof Number && right instanceof Number) return new java.math.BigDecimal(left.toString()).compareTo(new java.math.BigDecimal(right.toString())) == 0;
        if (left instanceof JSONObject && right instanceof JSONObject) {
            JSONObject a = (JSONObject) left, b = (JSONObject) right;
            if (a.length() != b.length()) return false;
            var keys = a.keys();
            while (keys.hasNext()) { String key = keys.next(); if (!b.has(key) || !same(a.get(key), b.get(key))) return false; }
            return true;
        }
        if (left instanceof JSONArray && right instanceof JSONArray) {
            JSONArray a = (JSONArray) left, b = (JSONArray) right;
            if (a.length() != b.length()) return false;
            for (int index = 0; index < a.length(); index++) if (!same(a.get(index), b.get(index))) return false;
            return true;
        }
        return left == null ? right == null : left.equals(right);
    }
}
