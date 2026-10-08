import Foundation

/// Resolves encrypted attachment references at the last boundary before a
/// remote command becomes JSON.
///
/// The state and UI intentionally carry `camellia-blob:` references instead
/// of Base64: this keeps multi-megabyte images out of drafts, logs and ordinary
/// memory. The desktop protocol, however, expects the bytes. Android performs
/// this exact walk in `AttachmentJson`; field names are allowlisted so a token,
/// prompt or other string that merely resembles a reference is never opened.
enum RemoteAttachmentJSON {
    private static let binaryFields: Set<String> = [
        "data", "file_data", "url", "images", "image",
    ]

    static func resolve(_ payload: [String: Any], using store: AttachmentStore?) throws -> [String: Any] {
        var result: [String: Any] = [:]
        result.reserveCapacity(payload.count)
        for (name, value) in payload {
            result[name] = try resolve(value, key: name, using: store)
        }
        return result
    }

    private static func resolve(_ value: Any, key: String,
                                using store: AttachmentStore?) throws -> Any {
        if let object = value as? [String: Any] {
            var result: [String: Any] = [:]
            result.reserveCapacity(object.count)
            for (name, nested) in object {
                result[name] = try resolve(nested, key: name, using: store)
            }
            return result
        }
        if let array = value as? [Any] {
            // Array elements inherit the field name: each entry under `images`
            // is binary even though it has no key of its own.
            return try array.map { try resolve($0, key: key, using: store) }
        }
        guard let text = value as? String else { return value }

        var prefix = ""
        var reference = text
        for candidate in ["data:image/jpeg;base64,", "data:application/pdf;base64,"]
            where text.hasPrefix(candidate) {
            prefix = candidate
            reference = String(text.dropFirst(candidate.count))
            break
        }

        if binaryFields.contains(key), AttachmentStore.isReference(reference) {
            guard let store else { throw AttachmentError.storageUnavailable }
            return prefix + (try store.open(reference)).base64EncodedString()
        }
        if key == "text", text.hasPrefix(AttachmentStore.textPrefix),
           AttachmentStore.isReference(text) {
            guard let store else { throw AttachmentError.storageUnavailable }
            return String(decoding: try store.open(text), as: UTF8.self)
        }
        return text
    }
}
