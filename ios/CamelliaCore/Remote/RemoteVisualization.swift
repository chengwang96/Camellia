import Foundation

/// Transcript metadata only. The authenticated HTML is fetched after opening a card.
public struct RemoteVisualization: Sendable, Identifiable, Hashable {
    public let id: String
    public let title: String
    public let summary: String
    public let wide: Bool
    public let revision: Int

    public init?(_ json: JSONObject) {
        let id = json.text("cardId")
        guard UUID(uuidString: id) != nil, id == id.lowercased() else { return nil }
        self.id = id
        title = String(json.text("title").prefix(120))
        summary = String(json.text("summary").trimmingCharacters(in: .whitespacesAndNewlines).prefix(500))
        wide = json.text("mode") == "wide"
        revision = max(1, json.int("revision", fallback: 1))
    }

    public static func latest(_ cards: [RemoteVisualization]) -> [RemoteVisualization] {
        var positions: [String: Int] = [:]
        var result: [RemoteVisualization] = []
        for card in cards {
            if let index = positions[card.id] {
                if card.revision >= result[index].revision { result[index] = card }
            } else {
                positions[card.id] = result.count
                result.append(card)
            }
        }
        return result
    }

    public func path(conversationId: String, dark: Bool) -> String {
        "/v1/conversations/\(conversationId)/visualizations/\(id)?theme=\(dark ? "dark" : "light")"
    }

    var weight: Int { 80 + id.utf16.count + title.utf16.count + summary.utf16.count }

    // Includes JSON escaping and the document wrapper around a stored card of at most 20 MiB.
    public static let maximumResponseBytes = 24 * 1024 * 1024
}
