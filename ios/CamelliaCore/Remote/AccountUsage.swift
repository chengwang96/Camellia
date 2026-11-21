import Foundation

/// The desktop supplies bounded period aggregates; filtering never adds wallets
/// together or interprets an absent quota as zero.
public struct AccountUsage: Sendable {
    public let json: JSONObject
    public init?(_ json: JSONObject) {
        guard json.int("version") == 1, json.raw["accounts"] is [Any],
              let ranges = json.object("ranges"), ["1", "7", "30", "all"].allSatisfy({ ranges.raw[$0] is [Any] }) else { return nil }
        self.json = json
    }
    public func hasRange(_ range: String) -> Bool {
        guard let ranges = json.object("ranges") else { return false }
        return ranges.raw[range] is [Any]
    }
    public func accounts(source: String = "") -> [JSONObject] {
        json.objects("accounts").filter { source.isEmpty || $0.text("source") == source }
    }
    public func rows(range: String, source: String = "", account: String = "", model: String = "") -> [JSONObject] {
        let ids = Set(accounts(source: source).filter { account.isEmpty || $0.text("id") == account }.map { $0.text("id") })
        return (json.object("ranges")?.objects(range) ?? []).filter {
            ids.contains($0.text("accountId")) && (model.isEmpty || $0.text("model") == model)
        }.sorted { $0.double("requests") > $1.double("requests") }
    }
    public static func sum(_ rows: [JSONObject], _ fields: [String]) -> Double {
        rows.reduce(0) { total, row in total + fields.reduce(0) { sum, key in
            let value = row.double(key)
            return sum + (value.isFinite && value >= 0 ? value : 0)
        } }
    }
}
