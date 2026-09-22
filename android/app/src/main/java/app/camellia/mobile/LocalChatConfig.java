package app.camellia.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.net.URI;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;

final class LocalChatConfig {
    static final int MAX_IMPORT = 2 * 1024 * 1024;

    static String export(JSONObject config) throws Exception {
        JSONObject copy = new JSONObject(config.toString());
        if (!copy.has("providers")) copy.put("providers", new JSONArray());
        routes(copy);
        String result = new JSONObject().put("format", "camellia-api-routes").put("version", 2).put("config", copy).toString(2);
        if (result.length() > MAX_IMPORT) throw new IllegalArgumentException("配置超过 2 MiB / Configuration exceeds 2 MiB");
        return result;
    }

    static final class Route {
        final String id, label, model, protocol, baseUrl, key;
        final List<String> keys;
        Route(String id, String label, String model, String protocol, String baseUrl, String key) {
            this(id, label, model, protocol, baseUrl, java.util.Collections.singletonList(key));
        }
        Route(String id, String label, String model, String protocol, String baseUrl, List<String> keys) {
            if (keys.isEmpty()) throw new IllegalArgumentException("No enabled API keys");
            this.id = id; this.label = label; this.model = model; this.protocol = protocol; this.baseUrl = baseUrl;
            this.keys = java.util.Collections.unmodifiableList(new ArrayList<>(keys)); this.key = keys.get(0);
        }
        String displayName() { int split = label.lastIndexOf(" · "); return split < 0 ? model : label.substring(split + 3); }
        String providerName() { int split = label.lastIndexOf(" · "); return split < 0 ? label : label.substring(0, split); }
    }

    static JSONObject parse(String source) throws Exception {
        if (source.length() > MAX_IMPORT) throw new IllegalArgumentException("配置超过 2 MiB / Configuration exceeds 2 MiB");
        String cleaned = source.trim();
        if (cleaned.startsWith("\ufeff")) cleaned = cleaned.substring(1).trim();
        JSONObject bundle;
        try {
            JSONTokener tokenizer = new JSONTokener(cleaned);
            Object value = tokenizer.nextValue();
            if (!(value instanceof JSONObject) || tokenizer.nextClean() != 0) throw new IllegalArgumentException();
            bundle = (JSONObject) value;
        } catch (Exception error) { throw new IllegalArgumentException("请粘贴完整 JSON 配置 / Paste the complete JSON configuration"); }
        if (!bundle.optString("format").equals("camellia-api-routes") || bundle.optInt("version") != 2)
            throw new IllegalArgumentException("需要电脑导出的 Camellia API 配置（版本 2）/ Expected a Camellia API routes v2 export");
        JSONObject config = bundle.optJSONObject("config");
        if (config == null || config.optJSONArray("providers") == null)
            throw new IllegalArgumentException("配置缺少 providers / Missing providers");
        try {
            routes(config);
        } catch (org.json.JSONException error) {
            throw new IllegalArgumentException("供应商、模型或密钥格式不正确 / Invalid provider, model or key structure");
        }
        return new JSONObject(config.toString());
    }

    static List<Route> routes(JSONObject config) throws Exception {
        List<Route> result = new ArrayList<>();
        JSONArray providers = config.optJSONArray("providers");
        if (providers == null) return result;
        HashSet<String> ids = new HashSet<>();
        for (int providerIndex = 0; providerIndex < providers.length(); providerIndex++) {
            JSONObject provider = providers.getJSONObject(providerIndex);
            String providerId = provider.getString("id");
            if (providerId.isEmpty() || !ids.add(providerId)) throw new IllegalArgumentException("供应商 ID 重复或为空 / Duplicate or empty provider ID");
            String protocol = provider.optString("protocol", "openai");
            if (!protocol.equals("openai") && !protocol.equals("anthropic") && !protocol.equals("dual"))
                throw new IllegalArgumentException("不支持此 API 协议 / Unsupported API protocol");
            String base = endpoint(provider.getString("baseUrl"));
            String anthropic = provider.optString("anthropicBaseUrl");
            if (!anthropic.isEmpty()) anthropic = endpoint(anthropic);
            JSONArray keys = provider.getJSONArray("keys");
            List<String> enabledKeys = new ArrayList<>();
            for (int keyIndex = 0; keyIndex < keys.length(); keyIndex++) {
                JSONObject candidate = keys.getJSONObject(keyIndex);
                String secret = candidate.getString("key").trim();
                if (secret.isEmpty() || secret.matches("(?s).*[\\r\\n\\x00-\\x1f].*"))
                    throw new IllegalArgumentException("密钥为空或含非法字符 / Empty or invalid API key");
                if (candidate.optBoolean("enabled", true) && !enabledKeys.contains(secret)) enabledKeys.add(secret);
            }
            JSONArray models = provider.getJSONArray("models");
            HashSet<String> modelIds = new HashSet<>();
            for (int modelIndex = 0; modelIndex < models.length(); modelIndex++) {
                JSONObject model = models.getJSONObject(modelIndex);
                String id = model.getString("id"), upstream = model.getString("upstream");
                if (!validModel(id) || !validModel(upstream) || !modelIds.add(id))
                    throw new IllegalArgumentException("模型 ID 无效或重复 / Invalid or duplicate model ID");
                String wire = model.optString("protocol", "auto");
                if (wire.equals("auto")) wire = protocol.equals("anthropic") ? "anthropic" : "openai";
                if (!wire.equals("openai") && !wire.equals("anthropic"))
                    throw new IllegalArgumentException("不支持此模型协议 / Unsupported model protocol");
                if (provider.optBoolean("enabled", true) && !enabledKeys.isEmpty()) result.add(new Route(
                    providerId + "/" + id, provider.optString("name", providerId) + " · " + id, upstream, wire,
                    wire.equals("anthropic") && !anthropic.isEmpty() ? anthropic : base, enabledKeys));
            }
        }
        return result;
    }

    private static boolean validModel(String value) {
        return !value.isEmpty() && value.length() <= 200 && !value.matches("(?s).*[\\s\\x00-\\x1f].*");
    }

    static String endpoint(String value) throws Exception {
        URI uri;
        try { uri = new URI(value.trim()); } catch (Exception error) { throw new IllegalArgumentException("API 地址无效 / Invalid API URL"); }
        String host = uri.getHost();
        boolean local = "localhost".equals(host) || "127.0.0.1".equals(host) || "[::1]".equals(host);
        if (host == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                || !("https".equals(uri.getScheme()) || local && "http".equals(uri.getScheme())))
            throw new IllegalArgumentException("远程 API 必须使用 HTTPS，地址不能含凭据或查询参数 / Remote APIs require HTTPS without credentials or query parameters");
        return uri.toString().replaceAll("/+$", "");
    }
}
