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
    // The initiating reply can also carry the total for background follow-up
    // replies and native child agents in the same user request.
    public let requestTotal: Int64?
    public let requestMain: Int64?
    public let requestBackground: Int64?
    public let requestBackgroundTurns: Int64
    public let requestChildren: Int64?
    public let requestChildTasks: Int64
    public let requestInput: Int64?
    public let requestOutput: Int64?
    public let requestCacheRead: Int64?
    public let requestCacheWrite: Int64?

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
        let request = json.object("requestUsage") ?? JSONObject()
        requestTotal = Self.count(request, "total")
        requestMain = Self.count(request, "main")
        requestBackground = Self.count(request, "background")
        requestBackgroundTurns = Self.count(request, "backgroundTurns") ?? 0
        requestChildren = Self.count(request, "children")
        requestChildTasks = Self.count(request, "childTasks") ?? 0
        requestInput = Self.count(request, "input")
        requestOutput = Self.count(request, "output")
        requestCacheRead = Self.count(request, "cacheRead")
        requestCacheWrite = Self.count(request, "cacheWrite")
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
    public var hasRequestUsage: Bool { requestTotal != nil }
    public var hasUsage: Bool { hasRequestUsage || input != nil || output != nil || cacheRead != nil || cacheWrite != nil }
    public var total: Int64 { (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) }
    public var displayTotal: Int64 { hasRequestUsage ? (requestTotal ?? 0) : total }
    public var cacheHit: Double? {
        let sourceInput = hasRequestUsage ? requestInput : input
        let sourceRead = hasRequestUsage ? requestCacheRead : cacheRead
        guard let sourceInput, let sourceRead else { return nil }
        let sourceWrite = hasRequestUsage ? requestCacheWrite : cacheWrite
        let prompt = sourceInput + sourceRead + (sourceWrite ?? 0)
        return prompt == 0 ? 0 : Double(sourceRead) / Double(prompt) * 100
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
        if hasRequestUsage {
            var request: [String: Any] = ["total": requestTotal ?? 0, "backgroundTurns": requestBackgroundTurns, "childTasks": requestChildTasks]
            if let requestMain { request["main"] = requestMain }
            if let requestBackground { request["background"] = requestBackground }
            if let requestChildren { request["children"] = requestChildren }
            if let requestInput { request["input"] = requestInput }
            if let requestOutput { request["output"] = requestOutput }
            if let requestCacheRead { request["cacheRead"] = requestCacheRead }
            if let requestCacheWrite { request["cacheWrite"] = requestCacheWrite }
            result["requestUsage"] = request
        }
        return result
    }
    public static func tokens(_ count: Int64) -> String {
        let format = NumberFormatter(); format.locale = Locale(identifier: "en_US"); format.numberStyle = .decimal
        return (format.string(from: NSNumber(value: count)) ?? "\(count)") + " tok"
    }
}
