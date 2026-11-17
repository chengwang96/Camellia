import Foundation
import CoreFoundation

/// How much reasoning the phone asks a model for, and how it says so.
///
/// Mirrors the reported desktop API metadata and shared labels.
///
/// Whether a level is even meaningful depends on the model. An OpenAI-compatible
/// endpoint takes a `reasoning_effort` field; Anthropic takes a `thinking` block
/// whose shape differs between the adaptive ("effort") and budget
/// ("budget_tokens") generations. Asking the wrong one is a 400, so the level
/// is dropped entirely rather than sent to a model that cannot read it.
public enum LocalChatThinking {
    private static let defaultLevels = ["low", "medium", "high"]
    private static let knownLevels = Set(defaultLevels + ["off", "none", "minimal", "xhigh", "max", "ultra"])

    public struct Metadata: Equatable, Sendable {
        public let levels: [String]
        public let booleanOnly: Bool
        public let onLabel: Bool
    }

    /// Same validation, order and boolean aliases as shared/model-levels.js.
    /// An explicit empty list disables controls; missing/invalid data is unknown.
    public static func metadata(_ source: Any?) -> Metadata? {
        guard let object = source as? [String: Any], let values = object["values"] as? [Any],
              values.count <= 32 else { return nil }
        var levels: [String] = []
        var booleanOnly = !values.isEmpty, hasTrue = false, hasHigh = false
        for value in values {
            let level: String
            if let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() {
                level = number.boolValue ? "high" : "none"
                hasTrue = hasTrue || number.boolValue
            } else if let name = value as? String, valid(name) {
                level = name
                booleanOnly = false
                hasHigh = hasHigh || name == "high"
            } else { return nil }
            if !levels.contains(level) { levels.append(level) }
        }
        return Metadata(levels: levels, booleanOnly: booleanOnly, onLabel: hasTrue && !hasHigh)
    }

    private static func valid(_ value: String) -> Bool { value.matches(#"(?i)[a-z][a-z0-9_-]{0,63}"#) }

    public static func levels(for route: LocalChatRoute?) -> [String] {
        route?.thinking?.levels ?? defaultLevels
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

    public static func label(_ value: String, route: LocalChatRoute?, chinese: Bool = true) -> String {
        if value == "none" { return chinese ? "关闭" : "Off" }
        if value == "high", route?.thinking?.onLabel == true { return chinese ? "开启" : "On" }
        if let route, levels(for: route).contains(value) { return display(value, chinese: chinese) }
        return label(value, chinese: chinese)
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
        if let thinking = route.thinking { return !thinking.levels.isEmpty }
        return route.wireProtocol == "openai" || adaptive(route) || budget(route)
    }

    /// The level actually sent — `auto` for anything the route cannot express.
    public static func effective(_ route: LocalChatRoute, _ value: String) -> String {
        guard supported(route) else { return "auto" }
        let trimmed = ComposerText.androidTrim(value)
        let level = levels(for: route).contains(trimmed) ? trimmed : normalize(value)
        return level == "auto" || levels(for: route).contains(level) ? level : "auto"
    }

    /// Applies the level to a request body, if it means anything.
    public static func apply(_ route: LocalChatRoute, _ value: String, to body: inout [String: Any]) {
        let level = effective(route, value)
        if level == "auto" { return }
        let off = level == "off" || level == "none"
        let host = URLComponents(string: route.baseURL)?.host ?? ""
        if route.thinking?.booleanOnly == true {
            body["thinking"] = ["type": off ? "disabled" : "enabled"]
            if route.wireProtocol == "openai", route.providerType == "ollama" || host == "ollama.com" {
                body["reasoning_effort"] = level
            }
            return
        }
        if route.wireProtocol == "openai" {
            body["reasoning_effort"] = level
            let deepseek = route.providerType == "deepseek" || host == "api.deepseek.com"
                || (["commandcode", "opencode", "opencode-go"].contains(route.providerType)
                    || host == "api.commandcode.ai" || host == "opencode.ai")
                && route.model.lowercased().matches(#"(?:.*/)?deepseek-.*"#)
            if deepseek {
                body["thinking"] = ["type": off ? "disabled" : "enabled"]
                if off { body.removeValue(forKey: "reasoning_effort") }
            }
        } else if off {
            body["thinking"] = ["type": "disabled"]
        } else if adaptive(route) || route.thinking != nil && !budget(route) {
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
