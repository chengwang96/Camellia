import Foundation

/// Turns an HTTP failure from a provider into something worth showing, and
/// decides whether the next API key is worth trying.
///
/// Ported from Android's `LocalChatHttpError`. Providers answer a bad request
/// with a status code that is far less specific than the message beside it —
/// a 403 can mean "wrong key", "no access to this model", "quota exhausted" or
/// "your country is blocked", and retrying with another key is only sensible
/// for some of those. So the body is read, the key material is scrubbed out of
/// it, and the wording is matched against the handful of phrases providers
/// actually use.
///
/// Two cases deliberately stop the rotation: an HTML body and a region
/// complaint. Both mean the request never reached the model — a gateway or a
/// WAF answered — and trying the next key would burn it against the same wall.
public struct LocalChatHTTPError: Error, Equatable, CustomStringConvertible {
    public let message: String
    /// Whether the caller should advance to the provider's next key.
    public let tryNextKey: Bool

    public var description: String { message }
    public var errorDescription: String { message }

    public init(message: String, tryNextKey: Bool) {
        self.message = message
        self.tryNextKey = tryNextKey
    }

    /// Builds the user-facing error for one failed attempt.
    ///
    /// - Parameters:
    ///   - status: the HTTP status code.
    ///   - source: the raw error body, possibly empty.
    ///   - keys: every key this provider might have sent, so each can be
    ///     redacted from the body before it is shown.
    ///   - host: the host that answered, shown so a user can tell two
    ///     providers apart.
    ///   - attempt: 1-based index of the key just used.
    ///   - total: how many keys the provider has.
    public static func from(status: Int, source: String, keys: [String],
                            host: String, attempt: Int, total: Int) -> LocalChatHTTPError {
        var detail = ""
        var type = ""
        if let raw = try? JSONSerialization.jsonObject(with: Data(source.utf8)),
           let body = raw as? [String: Any] {
            if let error = body["error"] {
                if let nested = error as? [String: Any] {
                    detail = string(nested, "message")
                    type = string(nested, "code") + " " + string(nested, "type")
                } else if let text = error as? String {
                    detail = text
                }
            }
            if detail.isEmpty { detail = string(body, "message") }
            type += " " + string(body, "code") + " " + string(body, "type")
        }
        let evidence = redact(type + " " + detail, keys: keys).lowercased()
        var quota = evidence.matches("(?s).*(quota|limit|plan|entitle|subscription|exceed|credit|balance|upgrade_required|余额|额度).*")
        let explicitQuota = evidence.matches("(?s).*(insufficient[_ ]quota|quota[_ ]exceeded|insufficient[_ ]balance|insufficient[_ ]credit|credit[_ ]balance[^.]*too low|monthly[^.]*limit[^.]*(exceeded|reached)|月额度[^.]*(用完|耗尽|不足)|余额不足|额度耗尽).*")
        var authentication = evidence.matches("(?s).*(invalid[_ ]api[_ ]key|invalid[_ ]key|invalid api token|authentication_error|unauthorized|invalid_token).*")
        let html = source.lowercased().matches(#"(?s).*<(html|!doctype|head|body)\b.*"#)
        let networkRestriction = evidence.matches("(?s).*(region|country|ip address|firewall|cloudflare|waf|地区|地域|防火墙).*")
        if networkRestriction || html {
            quota = false
            authentication = false
        }
        let quotaRejection = !html && !networkRestriction && explicitQuota && status >= 400 && status < 500

        let reason: String
        if status == 401 || status == 403 && authentication {
            reason = "密钥认证被拒绝，请检查 API 密钥 / API key authentication rejected"
        } else if status == 402 || status == 403 && quota || quotaRejection {
            reason = "额度或套餐权限不足，请检查供应商账户 / Check provider quota or subscription"
        } else if status == 429 {
            reason = "达到额度或速率限制 / Quota or rate limit reached"
        } else if status == 403 {
            reason = html
                ? "服务商或网络网关拒绝访问；可能是 IP、地区或防护规则，并不能据此判断密钥错误 / Provider or gateway denied access; check network or region"
                : "服务商拒绝访问；可能涉及模型权限、账户或网络限制 / Access denied; check model access, account or network restrictions"
        } else if status >= 300 && status < 400 {
            reason = "API 地址发生重定向，为保护密钥未跟随 / API redirect blocked to protect credentials"
        } else if status >= 500 {
            reason = "上游服务暂时异常，未自动重发 / Upstream error; not automatically resent"
        } else {
            reason = "请检查 API 地址、模型及请求参数 / Check API URL, model and request parameters"
        }

        let safe = html ? "" : redact((type.trimmingCharacters(in: .whitespacesAndNewlines) + " " + detail)
            .trimmingCharacters(in: .whitespacesAndNewlines), keys: keys)
        let location = host + (total > 1 ? " · 密钥尝试 / Key attempt \(attempt)/\(total)" : "")
        let message = "API HTTP \(status) · \(location)\n\(reason)"
            + (safe.isEmpty ? "" : "\n服务商信息 / Provider: \(safe)")
        let retry = !html && !networkRestriction
            && (status == 401 || status == 402 || status == 429
                || status == 403 && (quota || authentication) || quotaRejection)
        return LocalChatHTTPError(message: message, tryNextKey: retry)
    }

    private static func string(_ object: [String: Any], _ key: String) -> String {
        object[key] as? String ?? ""
    }

    /// Removes every trace of a key from text bound for the screen.
    ///
    /// A provider that echoes the offending credential back — which several do
    /// — would otherwise put it in an error banner, and from there into a
    /// screenshot. Both the raw key and the JSON-escaped and URL-encoded forms
    /// are replaced, because the echo rarely comes back in the shape it was
    /// sent as.
    public static func redact(_ value: String, keys: [String]) -> String {
        var text = value
        for key in keys where !key.isEmpty {
            text = text.replacingOccurrences(of: key, with: "[redacted]")
            text = text.replacingOccurrences(of: escaped(key), with: "[redacted]")
            if let encoded = encoded(key) { text = text.replacingOccurrences(of: encoded, with: "[redacted]") }
        }
        text = replacing(text, #"(?i)Bearer\s+[^\s"<>]+"#, with: "Bearer [redacted]")
        text = replacing(text, #"(?i)\bsk-[a-z0-9_-]+"#, with: "[redacted]")
        text = replacing(text, #"(?i)(api[_-]?key|access[_-]?token|authorization)([\s"']*[:=][\s"']*)[^\s,"'<>]+"#, with: "$1$2[redacted]")
        text = replacing(text, #"[\p{Cntrl}\p{Cf}]"#, with: " ")
        text = replacing(text, #"\s+"#, with: " ")
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.count > 500 ? String(text.prefix(500)) + "…" : text
    }

    /// The inner body of `JSONObject.quote`, so a key echoed inside a JSON
    /// string is still matched after its quotes and backslashes were escaped.
    private static func escaped(_ key: String) -> String {
        var result = ""
        for character in key.unicodeScalars {
            switch character {
            case "\"": result += "\\\""
            case "\\": result += "\\\\"
            case "\n": result += "\\n"
            case "\r": result += "\\r"
            case "\t": result += "\\t"
            default:
                if character.value < 0x20 {
                    result += String(format: "\\u%04x", character.value)
                } else {
                    result.unicodeScalars.append(character)
                }
            }
        }
        return result
    }

    /// `URLEncoder.encode` with UTF-8: alphanumerics and `-*._` survive, a
    /// space becomes `+`, everything else is percent-encoded.
    private static func encoded(_ key: String) -> String? {
        var allowed = CharacterSet()
        allowed.insert(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-*._")
        return key.addingPercentEncoding(withAllowedCharacters: allowed)?
            .replacingOccurrences(of: "%20", with: "+")
    }

    private static func replacing(_ text: String, _ pattern: String, with replacement: String) -> String {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return expression.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: replacement)
    }
}
