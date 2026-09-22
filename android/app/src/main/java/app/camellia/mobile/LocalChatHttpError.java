package app.camellia.mobile;

import org.json.JSONObject;
import java.io.IOException;
import java.util.List;
import java.util.Locale;

final class LocalChatHttpError extends IOException {
    final boolean tryNextKey;

    private LocalChatHttpError(String message, boolean tryNextKey) {
        super(message); this.tryNextKey = tryNextKey;
    }

    static LocalChatHttpError from(int status, String source, List<String> keys, String host, int attempt, int total) {
        String detail = "", type = "";
        try {
            JSONObject body = new JSONObject(source);
            Object error = body.opt("error");
            if (error instanceof JSONObject) {
                JSONObject nested = (JSONObject) error;
                detail = string(nested, "message");
                type = string(nested, "code") + " " + string(nested, "type");
            } else if (error instanceof String) detail = (String) error;
            if (detail.isEmpty()) detail = string(body, "message");
            type += " " + string(body, "code") + " " + string(body, "type");
        } catch (Exception ignored) {}
        String evidence = redact(type + " " + detail, keys).toLowerCase(Locale.ROOT);
        boolean quota = evidence.matches("(?s).*(quota|limit|plan|entitle|subscription|exceed|credit|balance|upgrade_required|余额|额度).*");
        boolean explicitQuota = evidence.matches("(?s).*(insufficient[_ ]quota|quota[_ ]exceeded|insufficient[_ ]balance|insufficient[_ ]credit|credit[_ ]balance[^.]*too low|monthly[^.]*limit[^.]*(exceeded|reached)|月额度[^.]*(用完|耗尽|不足)|余额不足|额度耗尽).*");
        boolean authentication = evidence.matches("(?s).*(invalid[_ ]api[_ ]key|invalid[_ ]key|invalid api token|authentication_error|unauthorized|invalid_token).*");
        boolean html = source.toLowerCase(Locale.ROOT).matches("(?s).*<(html|!doctype|head|body)\\b.*");
        boolean networkRestriction = evidence.matches("(?s).*(region|country|ip address|firewall|cloudflare|waf|地区|地域|防火墙).*");
        if (networkRestriction || html) { quota = false; authentication = false; }
        boolean quotaRejection = !html && !networkRestriction && explicitQuota && status >= 400 && status < 500;
        String reason;
        if (status == 401 || status == 403 && authentication) reason = "密钥认证被拒绝，请检查 API 密钥 / API key authentication rejected";
        else if (status == 402 || status == 403 && quota || quotaRejection) reason = "额度或套餐权限不足，请检查供应商账户 / Check provider quota or subscription";
        else if (status == 429) reason = "达到额度或速率限制 / Quota or rate limit reached";
        else if (status == 403) reason = html
            ? "服务商或网络网关拒绝访问；可能是 IP、地区或防护规则，并不能据此判断密钥错误 / Provider or gateway denied access; check network or region"
            : "服务商拒绝访问；可能涉及模型权限、账户或网络限制 / Access denied; check model access, account or network restrictions";
        else if (status >= 300 && status < 400) reason = "API 地址发生重定向，为保护密钥未跟随 / API redirect blocked to protect credentials";
        else if (status >= 500) reason = "上游服务暂时异常，未自动重发 / Upstream error; not automatically resent";
        else reason = "请检查 API 地址、模型及请求参数 / Check API URL, model and request parameters";
        String safe = html ? "" : redact((type.trim() + " " + detail).trim(), keys);
        String location = host + (total > 1 ? " · 密钥尝试 / Key attempt " + attempt + "/" + total : "");
        return new LocalChatHttpError("API HTTP " + status + " · " + location + "\n" + reason
            + (safe.isEmpty() ? "" : "\n服务商信息 / Provider: " + safe),
            !html && !networkRestriction && (status == 401 || status == 402 || status == 429 || status == 403 && (quota || authentication) || quotaRejection));
    }

    private static String string(JSONObject object, String key) {
        Object value = object.opt(key); return value instanceof String ? (String) value : "";
    }

    static String redact(String value, List<String> keys) {
        for (String key : keys) {
            if (key.isEmpty()) continue;
            value = value.replace(key, "[redacted]");
            String escaped = JSONObject.quote(key);
            value = value.replace(escaped.substring(1, escaped.length() - 1), "[redacted]");
            try { value = value.replace(java.net.URLEncoder.encode(key, "UTF-8"), "[redacted]"); } catch (Exception ignored) {}
        }
        value = value.replaceAll("(?i)Bearer\\s+[^\\s\"<>]+", "Bearer [redacted]")
            .replaceAll("(?i)\\bsk-[a-z0-9_-]+", "[redacted]")
            .replaceAll("(?i)(api[_-]?key|access[_-]?token|authorization)([\\s\"']*[:=][\\s\"']*)[^\\s,\"'<>]+", "$1$2[redacted]")
            .replaceAll("[\\p{Cntrl}\\p{Cf}]", " ").replaceAll("\\s+", " ").trim();
        return value.length() > 500 ? value.substring(0, 500) + "…" : value;
    }
}
