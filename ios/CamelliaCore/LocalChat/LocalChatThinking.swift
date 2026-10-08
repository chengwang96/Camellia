import Foundation

/// How much reasoning the phone asks a model for, and how it says so.
///
/// Ported from Android's `LocalChatThinking`. The phone offers three named
/// levels — auto, medium and high — while the desktop reports the provider's
/// own vocabulary (`low`, `xhigh`, `max`…). Both are mapped through one
/// `display` function so a label never means two different things depending on
/// which screen drew it.
///
/// Whether a level is even meaningful depends on the model. An OpenAI-compatible
/// endpoint takes a `reasoning_effort` field; Anthropic takes a `thinking` block
/// whose shape differs between the adaptive ("effort") and budget
/// ("budget_tokens") generations. Asking the wrong one is a 400, so the level
/// is dropped entirely rather than sent to a model that cannot read it.
public enum LocalChatThinking {
    /// The three levels this client offers.
    public static let levels = ["auto", "medium", "high"]

    public static func normalize(_ value: String) -> String {
        value == "medium" || value == "high" ? value : "auto"
    }

    public static func label(_ value: String, chinese: Bool = true) -> String {
        display(normalize(value), chinese: chinese)
    }

    /// Maps a provider-reported level name onto the shared wording.
    public static func display(_ value: String?, chinese: Bool = true) -> String {
        let trimmed = ComposerText.androidTrim(value ?? "")
        let level = trimmed.lowercased()
        switch level {
        case "", "auto", "default": return chinese ? "默认" : "Default"
        case "off", "none": return chinese ? "关闭" : "Off"
        case "minimal", "low": return chinese ? "快速" : "Fast"
        case "medium": return chinese ? "标准" : "Standard"
        case "high": return chinese ? "进阶" : "Advanced"
        case "xhigh", "max", "ultra": return chinese ? "极限" : "Extreme"
        default: return trimmed
        }
    }

    // MARK: - Model generations

    /// Newer Claude models take an `adaptive` thinking block plus an effort.
    static func adaptive(_ route: LocalChatRoute) -> Bool {
        let model = route.model.lowercased().replacingOccurrences(of: ".", with: "-")
        return model.contains("claude-mythos") || model.matches(#"^.*claude-(opus|sonnet)-(4-[6-9]|[5-9])(?:-.*)?$"#)
    }

    /// Older Claude models take an explicit `budget_tokens`.
    static func budget(_ route: LocalChatRoute) -> Bool {
        let model = route.model.lowercased().replacingOccurrences(of: ".", with: "-")
        if model.contains("claude-3-7-sonnet") { return true }
        return model.matches(#"^.*claude-(opus|sonnet)-4(?:-20[0-9]+)?$"#)
            || model.matches(#"^.*claude-(opus|sonnet|haiku)-4-[015](?:-.*)?$"#)
    }

    /// Whether the level can be expressed to this route at all.
    public static func supported(_ route: LocalChatRoute?) -> Bool {
        guard let route else { return false }
        return route.wireProtocol == "openai" || adaptive(route) || budget(route)
    }

    /// The level actually sent — `auto` for anything the route cannot express.
    public static func effective(_ route: LocalChatRoute, _ value: String) -> String {
        supported(route) ? normalize(value) : "auto"
    }

    /// Applies the level to a request body, if it means anything.
    public static func apply(_ route: LocalChatRoute, _ value: String, to body: inout [String: Any]) {
        let level = effective(route, value)
        if level == "auto" { return }
        if route.wireProtocol == "openai" {
            body["reasoning_effort"] = level
        } else if adaptive(route) {
            body["thinking"] = ["type": "adaptive"]
            body["output_config"] = ["effort": level]
            body["max_tokens"] = 16384
        } else {
            let tokens = level == "high" ? 8192 : 2048
            body["thinking"] = ["type": "enabled", "budget_tokens": tokens]
            body["max_tokens"] = tokens + 4096
        }
    }
}

extension String {
    /// Java's `String.matches`: the whole string, not a search.
    func matches(_ pattern: String) -> Bool {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return false }
        let range = NSRange(startIndex..<endIndex, in: self)
        return expression.firstMatch(in: self, options: [], range: range)?.range == range
    }
}
