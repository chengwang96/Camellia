import Foundation

/// Each completed provider call contributes once; a missing bucket stays unknown.
struct LocalTurnUsage {
    private static let keys = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
    private var total: [String: Int64]?

    static func normalize(_ raw: JSONObject?, anthropic: Bool) -> [String: Int64] {
        guard let raw else { return [:] }
        var usage: [String: Int64] = [:]
        if anthropic {
            for key in keys { if let value = TurnDetails.count(raw, key) { usage[key] = value } }
        } else {
            let prompt = TurnDetails.count(raw, "prompt_tokens")
            let cached = TurnDetails.count(raw, "prompt_cache_hit_tokens")
                ?? raw.object("prompt_tokens_details").flatMap { TurnDetails.count($0, "cached_tokens") }
            if let prompt, (cached ?? 0) <= prompt { usage["input_tokens"] = prompt - (cached ?? 0) }
            if let output = TurnDetails.count(raw, "completion_tokens") { usage["output_tokens"] = output }
            if let cached { usage["cache_read_input_tokens"] = cached }
        }
        return usage
    }

    mutating func add(_ usage: [String: Int64]) -> [String: Int64] {
        guard let previous = total else { total = usage; return usage }
        var next: [String: Int64] = [:]
        for key in Self.keys {
            if let before = previous[key], let value = usage[key] { next[key] = before + value }
        }
        total = next
        return next
    }
}
