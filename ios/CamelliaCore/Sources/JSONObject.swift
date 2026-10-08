import Foundation

/// Tolerant reads from a decoded JSON object.
///
/// The desktop sends a living protocol: fields appear, disappear and change
/// type between versions, and a client that insists on every one of them stops
/// working the day the desktop adds one. Android reads this payload with
/// `JSONObject.optString` and friends, which never throw and fall back to a
/// default, and that tolerance is the reason an old phone keeps talking to a
/// new desktop. `Codable` inverts it: one missing key or one number that
/// arrives as a string and the whole snapshot decodes as `nil`, which reads to
/// the user as "the app forgot my conversation".
///
/// So this mirrors the Android accessors instead. Every read is optional, and
/// the callers decide what an absent field means.
///
/// `@unchecked Sendable` because the contents are whatever `JSONSerialization`
/// produced: immutable Foundation values, but not ones Swift can see the
/// sendability of. Nothing mutates `raw` after init, which is what makes
/// passing one across a queue safe.
public struct JSONObject: @unchecked Sendable {
    public let raw: [String: Any]

    public init?(_ value: Any?) {
        guard let dictionary = value as? [String: Any] else { return nil }
        raw = dictionary
    }

    public init() {
        raw = [:]
    }

    /// Wraps a dictionary that is already an object, for the callers that built
    /// one by copying `raw` and editing it.
    public init(dictionary: [String: Any]) {
        raw = dictionary
    }

    /// Whether the key is present at all.
    ///
    /// Mirrors Android's `JSONObject.has`, which counts an explicit null as
    /// present — that distinction is load-bearing for `nextBefore`, where
    /// "missing" and "explicitly null" mean opposite things. Use `isNull` to ask
    /// whether a present key carries a usable value.
    public func has(_ key: String) -> Bool {
        raw[key] != nil
    }

    /// Whether the key is absent, or present and null.
    public func isNull(_ key: String) -> Bool {
        guard let value = raw[key] else { return true }
        return value is NSNull
    }

    /// A non-empty string, or nil. Android's `optString` returns "" for both a
    /// missing key and an empty one; collapsing them here is fine because every
    /// caller treats empty as absent anyway.
    public func string(_ key: String) -> String? {
        if let value = raw[key] as? String, !value.isEmpty { return value }
        if let number = raw[key] as? NSNumber, !(raw[key] is NSNull) { return number.stringValue }
        return nil
    }

    /// A string that may legitimately be empty.
    public func text(_ key: String, fallback: String = "") -> String {
        (raw[key] as? String) ?? fallback
    }

    public func int(_ key: String, fallback: Int = 0) -> Int {
        number(key)?.intValue ?? fallback
    }

    public func long(_ key: String, fallback: Int64 = 0) -> Int64 {
        number(key)?.int64Value ?? fallback
    }

    public func double(_ key: String, fallback: Double = 0) -> Double {
        number(key)?.doubleValue ?? fallback
    }

    public func bool(_ key: String, fallback: Bool = false) -> Bool {
        Self.androidBoolean(raw[key], fallback: fallback)
    }

    /// Android `JSONObject.optBoolean` accepts JSON booleans and only the
    /// strings "true"/"false" (case-insensitively). JSON numbers are not
    /// booleans, even though Swift bridges `NSNumber(1)` to `Bool`.
    public static func androidBoolean(_ value: Any?, fallback: Bool) -> Bool {
        if let number = value as? NSNumber,
           CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue }
        if let text = value as? String {
            switch text.lowercased() {
            case "true": return true
            case "false": return false
            default: break
            }
        }
        return fallback
    }

    public func object(_ key: String) -> JSONObject? {
        JSONObject(raw[key])
    }

    public func objects(_ key: String) -> [JSONObject] {
        (raw[key] as? [Any])?.compactMap(JSONObject.init) ?? []
    }

    /// The raw array, for lists of scalars.
    public func array(_ key: String) -> [Any] {
        (raw[key] as? [Any]) ?? []
    }

    public func strings(_ key: String) -> [String] {
        array(key).compactMap { $0 as? String }
    }

    private func number(_ key: String) -> NSNumber? {
        if let value = raw[key] as? NSNumber { return value }
        if let value = raw[key] as? Int { return NSNumber(value: value) }
        if let value = raw[key] as? Double { return NSNumber(value: value) }
        if let value = raw[key] as? String {
            // Numeric fields occasionally arrive quoted; parsing them is safer
            // than dropping the whole snapshot over it.
            return NumberFormatter().number(from: value)
        }
        return nil
    }
}

extension JSONObject: Equatable {
    /// Compares the decoded object, not the bytes it came from.
    ///
    /// Key order and formatting differ between two serialisations of the same
    /// payload, and comparing the raw text would report them as different.
    public static func == (lhs: JSONObject, rhs: JSONObject) -> Bool {
        NSDictionary(dictionary: lhs.raw).isEqual(to: rhs.raw)
    }
}

/// Parsing the bytes a response arrived as.
public enum JSONBody {
    public static func parse(_ data: Data) throws -> Any {
        try JSONSerialization.jsonObject(with: data, options: [])
    }

    public static func object(_ data: Data) throws -> JSONObject {
        guard let value = try? parse(data), let object = JSONObject(value) else {
            throw JSONBodyError.notAnObject
        }
        return object
    }
}

public enum JSONBodyError: Error, CustomStringConvertible {
    case notAnObject

    public var description: String {
        switch self {
        case .notAnObject: return "Invalid JSON"
        }
    }
}
