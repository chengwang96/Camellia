import Foundation
import CoreFoundation

/// One provider-plus-model combination the phone can talk to directly.
///
/// Ported from Android's `LocalChatConfig.Route`. The desktop exports a bundle
/// of providers, each with several models and several API keys, and a route is
/// what you get when you cross one model with one provider's enabled keys. The
/// label is the provider name joined to the model id with ` · `, and the two
/// halves are split back out for display, which is why the separator has to be
/// exactly that string on both sides.
public struct LocalChatRoute: Equatable, Sendable {
    public let id: String
    public let label: String
    /// What goes in the request body's `model` field — the provider's own name
    /// for the model, not the id the desktop assigned it.
    public let model: String
    /// `openai` or `anthropic`; `dual` is resolved per model at parse time.
    public let wireProtocol: String
    public let baseURL: String
    public let keys: [String]

    public init(id: String, label: String, model: String, wireProtocol: String, baseURL: String, keys: [String]) {
        self.id = id
        self.label = label
        self.model = model
        self.wireProtocol = wireProtocol
        self.baseURL = baseURL
        self.keys = keys
    }

    /// The first key. Android exposes `key` beside `keys`; the rotation loop
    /// walks `keys` and this is only the common case.
    public var key: String { keys.first ?? "" }

    public var isAnthropic: Bool { wireProtocol == "anthropic" }

    /// The model half of the label — what the phone shows in the model menu.
    public var displayName: String {
        guard let split = label.range(of: " · ", options: .backwards) else { return model }
        return String(label[split.upperBound...])
    }

    /// The provider half of the label.
    public var providerName: String {
        guard let split = label.range(of: " · ", options: .backwards) else { return label }
        return String(label[..<split.lowerBound])
    }
}

public enum LocalChatConfigError: Error, Equatable, CustomStringConvertible {
    case tooLarge
    case malformedJSON
    case wrongFormat
    case missingProviders
    case invalidStructure
    case duplicateProvider
    case unsupportedProtocol
    case invalidKey
    case invalidModel
    case unsupportedModelProtocol
    case invalidURL
    case insecureURL
    case noKeys

    public var description: String {
        switch self {
        case .tooLarge: return "配置超过 2 MiB / Configuration exceeds 2 MiB"
        case .malformedJSON: return "请粘贴完整 JSON 配置 / Paste the complete JSON configuration"
        case .wrongFormat: return "需要电脑导出的 Camellia API 配置（版本 2）/ Expected a Camellia API routes v2 export"
        case .missingProviders: return "配置缺少 providers / Missing providers"
        case .invalidStructure: return "供应商、模型或密钥格式不正确 / Invalid provider, model or key structure"
        case .duplicateProvider: return "供应商 ID 重复或为空 / Duplicate or empty provider ID"
        case .unsupportedProtocol: return "不支持此 API 协议 / Unsupported API protocol"
        case .invalidKey: return "密钥为空或含非法字符 / Empty or invalid API key"
        case .invalidModel: return "模型 ID 无效或重复 / Invalid or duplicate model ID"
        case .unsupportedModelProtocol: return "不支持此模型协议 / Unsupported model protocol"
        case .invalidURL: return "API 地址无效 / Invalid API URL"
        case .insecureURL: return "远程 API 必须使用 HTTPS，地址不能含凭据或查询参数 / Remote APIs require HTTPS without credentials or query parameters"
        case .noKeys: return "没有启用的 API 密钥 / No enabled API keys"
        }
    }

    /// What the settings screen shows.
    public var message: String { description }
}

/// The `camellia-api-routes` v2 bundle the desktop exports.
///
/// Ported from Android's `LocalChatConfig`. The phone has no way to ask the
/// desktop for its provider list over a local connection — this happens before
/// any pairing exists — so the whole configuration is pasted in as JSON, and
/// this is the validator that decides whether what was pasted is usable. It is
/// deliberately unforgiving: a route with an empty key or a plaintext remote
/// URL is rejected rather than silently ignored, because a key that leaks over
/// HTTP is not recoverable.
public enum LocalChatConfiguration {
    public static let format = "camellia-api-routes"
    public static let version = 2
    public static let maxImport = 2 * 1024 * 1024

    // MARK: - Export

    /// Serialises a config back out as a v2 bundle, validating it first.
    ///
    /// Android's `export` runs `routes` over the copy, which means an export
    /// doubles as a self-check: a config that cannot produce a route cannot be
    /// exported either.
    public static func export(_ config: [String: Any]) throws -> String {
        var copy = config
        if copy["providers"] == nil { copy["providers"] = [Any]() }
        _ = try routes(copy)
        let bundle: [String: Any] = ["format": format, "version": version, "config": copy]
        let data = try JSONSerialization.data(withJSONObject: bundle,
                                              options: [.prettyPrinted, .sortedKeys])
        guard let text = String(data: data, encoding: .utf8) else { throw LocalChatConfigError.malformedJSON }
        guard text.utf16.count <= maxImport else { throw LocalChatConfigError.tooLarge }
        return text
    }

    // MARK: - Import

    /// Validates pasted JSON and returns the inner config object.
    public static func parse(_ source: String) throws -> [String: Any] {
        guard source.utf16.count <= maxImport else { throw LocalChatConfigError.tooLarge }
        var cleaned = ComposerText.androidTrim(source)
        if cleaned.hasPrefix("\u{feff}") {
            cleaned = ComposerText.androidTrim(String(cleaned.dropFirst()))
        }
        // Android parses with a JSONTokener and demands the object end the
        // input, so `{...} trailing` is rejected. JSONSerialization is happy
        // with trailing whitespace but not trailing content, which matches.
        let value: Any
        do {
            value = try JSONSerialization.jsonObject(with: Data(cleaned.utf8), options: [])
        } catch {
            throw LocalChatConfigError.malformedJSON
        }
        guard let bundle = value as? [String: Any] else { throw LocalChatConfigError.malformedJSON }
        guard (bundle["format"] as? String) == format,
              let number = bundle["version"] as? NSNumber, number.intValue == version
        else { throw LocalChatConfigError.wrongFormat }
        guard let config = bundle["config"] as? [String: Any],
              config["providers"] is [Any]
        else { throw LocalChatConfigError.missingProviders }
        _ = try routes(config)
        return config
    }

    // MARK: - Routes

    /// Every usable route in a config, in provider order.
    ///
    /// A provider that is disabled, or whose every key is disabled, produces
    /// nothing rather than an error — that is how the desktop expresses "I have
    /// this configured but I am not using it right now".
    public static func routes(_ config: [String: Any]) throws -> [LocalChatRoute] {
        var result: [LocalChatRoute] = []
        guard let providers = config["providers"] as? [Any] else { return result }
        var seenProviders = Set<String>()
        for entry in providers {
            guard let provider = entry as? [String: Any] else { throw LocalChatConfigError.invalidStructure }
            let providerID = try required(provider, "id")
            guard !providerID.isEmpty, seenProviders.insert(providerID).inserted else {
                throw LocalChatConfigError.duplicateProvider
            }
            let protocolName = (provider["protocol"] as? String) ?? "openai"
            guard protocolName == "openai" || protocolName == "anthropic" || protocolName == "dual" else {
                throw LocalChatConfigError.unsupportedProtocol
            }
            let base = try endpoint(try required(provider, "baseUrl"))
            var anthropicBase = (provider["anthropicBaseUrl"] as? String) ?? ""
            if !anthropicBase.isEmpty { anthropicBase = try endpoint(anthropicBase) }

            guard let keyEntries = provider["keys"] as? [Any] else { throw LocalChatConfigError.invalidStructure }
            var enabledKeys: [String] = []
            for keyEntry in keyEntries {
                guard let candidate = keyEntry as? [String: Any] else { throw LocalChatConfigError.invalidStructure }
                let secret = ComposerText.androidTrim(try required(candidate, "key"))
                if secret.isEmpty || secret.utf16.contains(where: { $0 < 0x20 }) {
                    throw LocalChatConfigError.invalidKey
                }
                let enabled = JSONObject.androidBoolean(candidate["enabled"], fallback: true)
                if enabled, !enabledKeys.contains(secret) { enabledKeys.append(secret) }
            }

            guard let models = provider["models"] as? [Any] else { throw LocalChatConfigError.invalidStructure }
            var seenModels = Set<String>()
            for modelEntry in models {
                guard let model = modelEntry as? [String: Any] else { throw LocalChatConfigError.invalidStructure }
                let id = try required(model, "id")
                let upstream = try required(model, "upstream")
                guard validModel(id), validModel(upstream), seenModels.insert(id).inserted else {
                    throw LocalChatConfigError.invalidModel
                }
                var wire = (model["protocol"] as? String) ?? "auto"
                if wire == "auto" { wire = protocolName == "anthropic" ? "anthropic" : "openai" }
                guard wire == "openai" || wire == "anthropic" else {
                    throw LocalChatConfigError.unsupportedModelProtocol
                }
                let providerEnabled = JSONObject.androidBoolean(provider["enabled"], fallback: true)
                if providerEnabled, !enabledKeys.isEmpty {
                    result.append(LocalChatRoute(
                        id: providerID + "/" + id,
                        label: ((provider["name"] as? String) ?? providerID) + " · " + id,
                        model: upstream,
                        wireProtocol: wire,
                        baseURL: wire == "anthropic" && !anthropicBase.isEmpty ? anthropicBase : base,
                        keys: enabledKeys))
                }
            }
        }
        return result
    }

    // MARK: - Details

    /// Validates a base URL and strips trailing slashes.
    ///
    /// Plain `http` is allowed only for the loopback addresses, which is what
    /// makes a locally hosted gateway workable while still refusing to send a
    /// key to a remote host in the clear. Credentials in the URL and query
    /// parameters are refused outright: the first would be logged by every
    /// proxy on the way, the second is how a key ends up in a referrer.
    public static func endpoint(_ value: String) throws -> String {
        let trimmed = ComposerText.androidTrim(value)
        guard let components = URLComponents(string: trimmed), let scheme = components.scheme,
              let host = components.host, !host.isEmpty
        else { throw LocalChatConfigError.invalidURL }
        guard components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil
        else { throw LocalChatConfigError.insecureURL }
        // Java's `URI.getHost` keeps the brackets around an IPv6 literal and
        // Foundation's strips them, so compare against both spellings.
        let local = host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
        guard scheme == "https" || (local && scheme == "http") else {
            throw LocalChatConfigError.insecureURL
        }
        return trimmed.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
    }

    /// Model ids go in a URL path and a JSON body, so anything a provider might
    /// mis-split — whitespace or a control character — is refused here.
    public static func validModel(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf16.count <= 200 else { return false }
        // Java's `[\s\x00-\x1f]` rejects C0 and ASCII space, not every
        // Unicode whitespace scalar or DEL.
        return !value.utf16.contains(where: { $0 <= 0x20 })
    }

    private static func required(_ object: [String: Any], _ key: String) throws -> String {
        guard let value = object[key] as? String else { throw LocalChatConfigError.invalidStructure }
        return value
    }
}

extension String {
    /// Whether the string carries a C0 control character or `DEL`.
    ///
    /// `\r` and `\n` are included, which is the point: a key with a newline in
    /// it would corrupt the header it is placed in.
    var containsControlCharacters: Bool {
        unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
    }
}
