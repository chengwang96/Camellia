import Foundation

/// Validation failures produced by the manual provider editor before the
/// complete route validator runs.
public enum LocalProviderEditError: Error, Equatable, CustomStringConvertible {
    case missingName
    case missingKey
    case missingModel

    public var description: String {
        switch self {
        case .missingName: return "请输入供应商名称"
        case .missingKey: return "请填写 API Key"
        case .missingModel: return "至少填写一个模型 ID"
        }
    }
}

/// Pure mutations used by the provider settings screen.
///
/// Keeping these beside `LocalChatConfiguration` makes the manual editor obey
/// the same URL/key/model rules as pasted and desktop-imported bundles. The
/// merge is intentionally lossless for fields a newer desktop may add: known
/// fields are replaced, while unknown provider, key and model fields survive.
public enum LocalProviderEditor {
    public static func upsert(_ draft: [String: Any], in original: [String: Any]) throws -> [String: Any] {
        let name = ComposerText.androidTrim(string(draft["name"]))
        guard !name.isEmpty else { throw LocalProviderEditError.missingName }

        guard let draftKeys = draft["keys"] as? [Any], !draftKeys.isEmpty else {
            throw LocalProviderEditError.missingKey
        }
        guard let draftModels = draft["models"] as? [Any], !draftModels.isEmpty else {
            throw LocalProviderEditError.missingModel
        }

        var config = original
        if config["version"] == nil { config["version"] = LocalChatConfiguration.version }
        if config["enabled"] == nil { config["enabled"] = true }
        let entries = try dictionaries(config["providers"] ?? [Any]())

        let requestedID = string(draft["id"])
        let identifier = requestedID.isEmpty ? UUID().uuidString.lowercased() : requestedID
        let existingIndex = entries.firstIndex { string($0["id"]) == identifier }
        let existing = existingIndex.map { entries[$0] } ?? [:]

        var provider = existing
        provider["id"] = identifier
        provider["name"] = name
        provider["type"] = string(existing["type"]).isEmpty ? "custom" : existing["type"]
        provider["baseUrl"] = try LocalChatConfiguration.endpoint(string(draft["baseUrl"]))
        let alternate = ComposerText.androidTrim(string(draft["anthropicBaseUrl"]))
        provider["anthropicBaseUrl"] = alternate.isEmpty ? "" : try LocalChatConfiguration.endpoint(alternate)
        provider["protocol"] = string(draft["protocol"]).isEmpty ? "openai" : string(draft["protocol"])
        provider["enabled"] = JSONObject.androidBoolean(draft["enabled"], fallback: true)

        let oldKeys = try dictionaries(existing["keys"] ?? [Any]())
        provider["keys"] = try dictionaries(draftKeys).map { candidate -> [String: Any] in
            let requested = string(candidate["id"])
            let id = requested.isEmpty ? UUID().uuidString.lowercased() : requested
            var key = oldKeys.first(where: { string($0["id"]) == id }) ?? [:]
            key["id"] = id
            key["key"] = ComposerText.androidTrim(string(candidate["key"]))
            key["enabled"] = JSONObject.androidBoolean(candidate["enabled"], fallback: true)
            return key
        }

        let oldModels = try dictionaries(existing["models"] ?? [Any]())
        provider["models"] = try dictionaries(draftModels).map { candidate -> [String: Any] in
            let id = ComposerText.androidTrim(string(candidate["id"]))
            var model = oldModels.first(where: { string($0["id"]) == id }) ?? [:]
            model["id"] = id
            model["upstream"] = ComposerText.androidTrim(string(candidate["upstream"]))
            let wire = string(candidate["protocol"])
            model["protocol"] = wire.isEmpty ? "auto" : wire
            return model
        }

        var nextEntries = entries
        if let existingIndex { nextEntries[existingIndex] = provider } else { nextEntries.append(provider) }
        config["providers"] = nextEntries
        _ = try LocalChatConfiguration.routes(config)
        return config
    }

    public static func setEnabled(_ enabled: Bool, providerID: String,
                                  in original: [String: Any]) throws -> [String: Any] {
        var config = original
        var entries = try dictionaries(config["providers"] ?? [Any]())
        guard let index = entries.firstIndex(where: { string($0["id"]) == providerID }) else {
            return config
        }
        entries[index]["enabled"] = enabled
        config["providers"] = entries
        _ = try LocalChatConfiguration.routes(config)
        return config
    }

    public static func remove(providerID: String, from original: [String: Any]) throws -> [String: Any] {
        var config = original
        let entries = try dictionaries(config["providers"] ?? [Any]())
        config["providers"] = entries.filter { string($0["id"]) != providerID }
        _ = try LocalChatConfiguration.routes(config)
        return config
    }

    private static func dictionaries(_ value: Any) throws -> [[String: Any]] {
        guard let values = value as? [Any] else { throw LocalChatConfigError.invalidStructure }
        return try values.map {
            guard let dictionary = $0 as? [String: Any] else { throw LocalChatConfigError.invalidStructure }
            return dictionary
        }
    }

    private static func string(_ value: Any?) -> String { value as? String ?? "" }
}
