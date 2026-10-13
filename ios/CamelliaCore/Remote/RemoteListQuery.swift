import Foundation

/// The capability-gated list query uses Android's UTF-8 form encoding.
public struct RemoteListQuery {
    public let query: String
    public let limit: Int

    public init(query: String, limit: Int = 100) {
        self.query = ComposerText.androidTrim(query).lowercased()
        self.limit = min(1000, max(1, limit))
    }

    public func path(offset: Int) -> String {
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._*-".utf8)
        let encoded = query.utf8.map { byte -> String in
            if byte == 32 { return "+" }
            return allowed.contains(byte) ? String(UnicodeScalar(byte)) : String(format: "%%%02X", byte)
        }.joined()
        return "/v1/conversations?offset=\(max(0, offset))&limit=\(limit)&query=\(encoded)"
    }
}
