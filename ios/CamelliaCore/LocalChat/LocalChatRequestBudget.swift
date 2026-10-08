import Foundation

/// File lengths can be checked without decrypting the files they describe.
public protocol LocalChatAttachmentSizing: LocalChatAttachmentResolving {
    func base64ByteCount(_ value: String) throws -> Int64
    func textByteCount(_ value: String) throws -> Int64
}

/// The immutable part of a history row needed by a background request builder.
public struct LocalChatInputMessage: Sendable {
    public struct Document: Sendable {
        let name: String?
        let mimeType: String
        let data: String?
        let text: String?

        var json: [String: Any] {
            var value: [String: Any] = ["mimeType": mimeType]
            if let name { value["name"] = name }
            if let data { value["data"] = data }
            if let text { value["text"] = text }
            return value
        }
    }

    let role: String
    let content: String
    let images: [String]
    let documents: [Document]

    public static func history(_ rows: [[String: Any]]) throws -> [LocalChatInputMessage] {
        try rows.compactMap { row in
            let role = LocalChatRequest.androidString(row["role"])
            guard role == "user" || role == "assistant" else { return nil }
            let content = LocalChatRequest.androidString(row["content"])
            let images: [String] = (row["images"] as? [Any] ?? []).map { LocalChatRequest.androidString($0) }
            let rawDocuments = row["documents"] as? [Any] ?? []
            guard !content.isEmpty || !images.isEmpty || !rawDocuments.isEmpty else { return nil }
            let documents = try rawDocuments.map { raw -> Document in
                guard let value = raw as? [String: Any] else { throw LocalChatRequestError.invalidAttachment }
                return Document(name: value["name"].map { LocalChatRequest.androidString($0) },
                                mimeType: LocalChatRequest.androidString(value["mimeType"]),
                                data: value["data"].map { LocalChatRequest.androidString($0) },
                                text: value["text"].map { LocalChatRequest.androidString($0) })
            }
            return LocalChatInputMessage(role: role, content: content, images: images, documents: documents)
        }
    }

    var json: [String: Any] {
        ["role": role, "content": content, "images": images, "documents": documents.map(\.json)]
    }
}

public struct LocalChatPreparedRequest: Sendable {
    public let payload: Data
    public let includedHistoryTurns: Int
    public let omittedHistoryTurns: Int
}

public enum LocalChatRequestBudget {
    /// Bounds encoded requests, independently of the per-file selection limits.
    public static let maximumBytes = 16 * 1024 * 1024

    public static func prepare(route: LocalChatRoute, history: [LocalChatInputMessage],
                               thinking: String, using resolver: LocalChatAttachmentSizing,
                               maximumBytes: Int = maximumBytes) throws -> LocalChatPreparedRequest {
        // A user message and its following assistant messages form one turn.
        // The final turn is the current input and must always fit in full.
        var turns: [[LocalChatInputMessage]] = []
        for row in history {
            if row.role == "user" { turns.append([row]) }
            else if !turns.isEmpty { turns[turns.count - 1].append(row) }
        }
        guard let current = turns.last else { throw LocalChatRequestError.invalidAttachment }
        var remaining = Int64(maximumBytes) - 1024 - stringBytes(route.model) - stringBytes(thinking)
        let currentBytes = try bytes(current, using: resolver)
        guard currentBytes <= remaining else { throw LocalChatRequestError.requestTooLarge }
        remaining -= currentBytes
        var selected = [current]
        for turn in turns.dropLast().reversed() {
            try Task.checkCancellation()
            let size = try bytes(turn, using: resolver)
            guard size <= remaining else { break }
            selected.append(turn)
            remaining -= size
        }
        try Task.checkCancellation()
        let rows = selected.reversed().flatMap { $0 }.map(\.json)
        let body = try LocalChatRequest.build(route: route, history: rows, thinking: thinking, using: resolver)
        let payload = try JSONSerialization.data(withJSONObject: body, options: [.withoutEscapingSlashes])
        guard payload.count <= maximumBytes else { throw LocalChatRequestError.requestTooLarge }
        return LocalChatPreparedRequest(payload: payload, includedHistoryTurns: selected.count - 1,
                                        omittedHistoryTurns: turns.count - selected.count)
    }

    private static func bytes(_ turn: [LocalChatInputMessage],
                              using resolver: LocalChatAttachmentSizing) throws -> Int64 {
        var total: Int64 = 0
        for row in turn {
            try Task.checkCancellation()
            total += 128 + stringBytes(row.content)
            for image in row.images { total += 256 + (try resolver.base64ByteCount(image)) }
            for document in row.documents {
                guard let name = document.name else { throw LocalChatRequestError.invalidAttachment }
                total += 512 + stringBytes(name)
                if document.mimeType == "application/pdf" {
                    guard let data = document.data else { throw LocalChatRequestError.invalidAttachment }
                    total += try resolver.base64ByteCount(data)
                } else {
                    guard let text = document.text else { throw LocalChatRequestError.documentTextUnavailable }
                    // An encrypted text file can contain JSON control characters.
                    // Reserve their worst-case escaped size before decrypting it.
                    total += try resolver.textByteCount(text) * 6
                }
            }
        }
        return total
    }

    private static func stringBytes(_ value: String) -> Int64 {
        var result = Int64(value.utf8.count) + 2
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0x22, 0x5C, 0x08, 0x09, 0x0A, 0x0C, 0x0D: result += 1
            case 0..<0x20: result += 5
            default: break
            }
        }
        return result
    }
}
