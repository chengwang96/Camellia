import Foundation
import CoreFoundation

/// Presentation facts recorded with this reply. Missing accounting stays unknown.
public struct TurnDetails: Sendable, Hashable {
    public let state: String
    public let model: String
    public let duration: Double?
    public let cost: Double?
    public let input: Int64?
    public let output: Int64?
    public let cacheRead: Int64?
    public let cacheWrite: Int64?

    public init(_ json: JSONObject) {
        state = json.text("state")
        model = json.text("model")
        duration = Self.number(json, "duration_ms")
        cost = Self.number(json, "total_cost_usd")
        let usage = json.object("usage") ?? JSONObject()
        input = Self.count(usage, "input_tokens")
        output = Self.count(usage, "output_tokens")
        cacheRead = Self.count(usage, "cache_read_input_tokens")
        cacheWrite = Self.count(usage, "cache_creation_input_tokens")
    }

    private static func number(_ json: JSONObject, _ key: String) -> Double? {
        guard let number = json.raw[key] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let value = number.doubleValue
        return value.isFinite && value >= 0 && value <= 9_007_199_254_740_991 ? value : nil
    }
    static func count(_ json: JSONObject, _ key: String) -> Int64? {
        guard let value = number(json, key), value.rounded(.down) == value else { return nil }
        return Int64(value)
    }

    public var completed: Bool { state == "complete" }
    public var hasUsage: Bool { input != nil || output != nil || cacheRead != nil || cacheWrite != nil }
    public var total: Int64 { (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) }
    public var cacheHit: Double? {
        guard let input, let cacheRead else { return nil }
        let prompt = input + cacheRead + (cacheWrite ?? 0)
        return prompt == 0 ? 0 : Double(cacheRead) / Double(prompt) * 100
    }
    public var elapsed: String {
        let seconds = Int64(((duration ?? 0) / 1000).rounded())
        return seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
    }
    public var json: [String: Any] {
        var result: [String: Any] = ["state": state]
        if !model.isEmpty { result["model"] = model }
        if let duration { result["duration_ms"] = duration }
        if let cost { result["total_cost_usd"] = cost }
        var usage: [String: Any] = [:]
        if let input { usage["input_tokens"] = input }
        if let output { usage["output_tokens"] = output }
        if let cacheRead { usage["cache_read_input_tokens"] = cacheRead }
        if let cacheWrite { usage["cache_creation_input_tokens"] = cacheWrite }
        if !usage.isEmpty { result["usage"] = usage }
        return result
    }
    public static func tokens(_ count: Int64) -> String {
        let format = NumberFormatter(); format.locale = Locale(identifier: "en_US"); format.numberStyle = .decimal
        return (format.string(from: NSNumber(value: count)) ?? "\(count)") + " tok"
    }
}
