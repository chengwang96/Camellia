import Foundation

/// How much reasoning the phone asks a model for, and how it says so.
///
/// Mirrors Android's model-specific ladder and shared desktop labels.
///
/// Whether a level is even meaningful depends on the model. An OpenAI-compatible
/// endpoint takes a `reasoning_effort` field; Anthropic takes a `thinking` block
/// whose shape differs between the adaptive ("effort") and budget
/// ("budget_tokens") generations. Asking the wrong one is a 400, so the level
/// is dropped entirely rather than sent to a model that cannot read it.
public enum LocalChatThinking {
    private static let defaultLevels = ["low", "medium", "high"]
    private static let xhighLevels = defaultLevels + ["xhigh"]
    private static let maxLevels = xhighLevels + ["max"]
    private static let ultraLevels = maxLevels + ["ultra"]
    private static let anthropicLevels = ["off", "low", "medium", "high", "max"]
    private static let knownLevels = Set(ultraLevels + ["off"])

    // The ordering and slug boundaries match shared/model-levels.js and Android.
    private static let modelLevels: [(String, [String])] = [
        ("gpt-daybreak-blue-latest", ultraLevels), ("gpt-daybreak-red-latest", ultraLevels),
        ("gpt-6.1-sol", ultraLevels), ("gpt-6-astra", ultraLevels),
        ("gpt-5.6-luna", maxLevels), ("gpt-5.6-sol", ultraLevels),
        ("gpt-5.6-terra", ultraLevels), ("gpt-6-luna", maxLevels),
        ("gpt-6-sol", ultraLevels), ("gpt-5.5", xhighLevels),
        ("codex-auto-review", maxLevels),
    ]

    public static func levels(for route: LocalChatRoute?) -> [String] {
        guard let route else { return defaultLevels }
        if route.wireProtocol == "anthropic" { return anthropicLevels }
        let model = route.model.lowercased().components(separatedBy: "/").last ?? ""
        return modelLevels.first { model == $0.0 || model.hasPrefix($0.0 + "-") }?.1 ?? defaultLevels
    }

    public static func menu(for route: LocalChatRoute?) -> [String] {
        ["auto"] + levels(for: route)
    }

    public static func normalize(_ value: String) -> String {
        let level = ComposerText.androidTrim(value).lowercased()
        return knownLevels.contains(level) ? level : "auto"
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
        case "off": return chinese ? "关闭" : "Off"
        case "low": return chinese ? "低" : "Low"
        case "medium": return chinese ? "中" : "Medium"
        case "high": return chinese ? "高" : "High"
        case "xhigh": return chinese ? "极高" : "Extra high"
        case "max": return chinese ? "最高" : "Max"
        case "ultra": return "Ultra"
        case "none": return chinese ? "无" : "None"
        case "minimal": return chinese ? "最小" : "Minimal"
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
        guard supported(route) else { return "auto" }
        let level = normalize(value)
        return level == "auto" || levels(for: route).contains(level) ? level : "auto"
    }

    /// Applies the level to a request body, if it means anything.
    public static func apply(_ route: LocalChatRoute, _ value: String, to body: inout [String: Any]) {
        let level = effective(route, value)
        if level == "auto" { return }
        if level == "off" {
            body["thinking"] = ["type": "disabled"]
        } else if route.wireProtocol == "openai" {
            body["reasoning_effort"] = level
        } else if adaptive(route) {
            body["thinking"] = ["type": "adaptive"]
            body["output_config"] = ["effort": level]
            body["max_tokens"] = 16384
        } else {
            let tokens = level == "high" || level == "max" ? 8192 : 2048
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
