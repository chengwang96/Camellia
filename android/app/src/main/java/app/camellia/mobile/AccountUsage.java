package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

/** Filter the desktop's already-aggregated periods without combining wallets. */
final class AccountUsage {
    static List<JSONObject> objects(JSONArray array) {
        List<JSONObject> rows = new ArrayList<>();
        if (array != null) for (int i = 0; i < array.length(); i++) {
            JSONObject row = array.optJSONObject(i); if (row != null) rows.add(row);
        }
        return rows;
    }
    static boolean valid(JSONObject data) {
        if (data == null || data.optInt("version") != 1 || data.optJSONArray("accounts") == null || data.optJSONObject("ranges") == null) return false;
        for (String range : new String[]{"1", "7", "30", "all"}) if (data.optJSONObject("ranges").optJSONArray(range) == null) return false;
        return true;
    }
    static boolean hasRange(JSONObject data, String range) {
        return data != null && data.optJSONObject("ranges") != null && data.optJSONObject("ranges").optJSONArray(range) != null;
    }
    static List<JSONObject> accounts(JSONObject data, String source) {
        List<JSONObject> rows = new ArrayList<>();
        if (data != null) for (JSONObject account : objects(data.optJSONArray("accounts"))) {
            if (source.isEmpty() || source.equals(account.optString("source"))) rows.add(account);
        }
        return rows;
    }
    static List<JSONObject> rows(JSONObject data, String range, String source, String accountId, String model) {
        List<JSONObject> result = new ArrayList<>();
        if (data == null || data.optJSONObject("ranges") == null) return result;
        var ids = new java.util.HashSet<String>();
        for (JSONObject account : accounts(data, source)) if (accountId.isEmpty() || accountId.equals(account.optString("id"))) ids.add(account.optString("id"));
        for (JSONObject row : objects(data.optJSONObject("ranges").optJSONArray(range))) {
            if (ids.contains(row.optString("accountId")) && (model.isEmpty() || model.equals(row.optString("model")))) result.add(row);
        }
        result.sort((a, b) -> Double.compare(b.optDouble("requests", 0), a.optDouble("requests", 0)));
        return result;
    }
    static double sum(List<JSONObject> rows, String... fields) {
        double result = 0;
        for (JSONObject row : rows) for (String field : fields) {
            double value = row.optDouble(field, 0); if (Double.isFinite(value) && value >= 0) result += value;
        }
        return result;
    }
}
