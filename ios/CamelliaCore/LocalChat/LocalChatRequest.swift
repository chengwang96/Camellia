import Foundation

/// What the request builder needs from the attachment store.
///
/// The history keeps an image or a document as a `camellia-blob:` reference
/// rather than as bytes, so building the request is where the reference has to
/// become the base64 the provider expects. Splitting it behind a protocol keeps
/// the wire shape testable on the host without a filesystem, and keeps the
/// builder from knowing what a blob is.
public protocol LocalChatAttachmentResolving {
    /// The base64 of a blob reference, or the value unchanged if it already is
    /// base64. Mirrors `AttachmentJson`, which only rewrites what it recognises.
    func wireBase64(_ value: String) throws -> String
    /// The literal text behind a `camellia-text:` reference, or the value
    /// unchanged. Document text is stored sealed like an attachment, and only
    /// becomes an ordinary string here, on the way out.
    func wireText(_ value: String) throws -> String
}

public enum LocalChatRequestError: Error, Equatable, CustomStringConvertible {
    case invalidAttachment
    case documentTextUnavailable
    case requestTooLarge

    public var description: String {
        switch self {
        case .invalidAttachment:
            return "附件数据不可用，请重新添加 / Attachment unavailable; select it again"
        case .documentTextUnavailable:
            return "文档文字不可用，请重新添加 / Document text unavailable; select it again"
        case .requestTooLarge:
            return "本次输入和附件超过 16 MiB 请求预算，请减少附件或文字 / Input and attachments exceed the 16 MiB request budget; reduce attachments or text"
        }
    }
}

extension LocalChatRequestError: LocalizedError {
    public var errorDescription: String? { description }
}

/// Turns stored history rows into the JSON body a provider expects.
///
/// Ported from `LocalChatClient.request` and its `parts` helper. The two
/// protocols disagree about how an image is attached — OpenAI-compatible APIs
/// take `image_url` with a data URL, Anthropic takes a base64 `source` block —
/// and about PDFs, which OpenAI takes as `file` with `file_data` and Anthropic
/// as a `document` block. Everything else goes over as plain text, which is why
/// a non-PDF document is inlined as two text parts: a label naming the document,
/// then its contents.
public enum LocalChatRequest {
    public static let imageMediaType = "image/jpeg"

    public static func dataURL(_ encoded: String) -> String {
        "data:" + imageMediaType + ";base64," + encoded
    }

    /// Builds the whole body.
    ///
    /// Rows the model should not see — anything that is not a user or assistant
    /// turn, and any turn that carries neither text nor an attachment — are
    /// dropped rather than sent empty, because a provider that receives an empty
    /// message tends to reject the whole request.
    public static func build(route: LocalChatRoute,
                             history: [[String: Any]],
                             thinking: String,
                             using resolver: LocalChatAttachmentResolving) throws -> [String: Any] {
        var messages: [[String: Any]] = []
        for row in history {
            try Task.checkCancellation()
            let role = androidString(row["role"])
            let content = androidString(row["content"])
            let rawImages = row["images"] as? [Any] ?? []
            let rawDocuments = row["documents"] as? [Any] ?? []
            let attached = !rawImages.isEmpty || !rawDocuments.isEmpty
            guard role == "user" || role == "assistant" else { continue }
            guard !content.isEmpty || attached else { continue }
            if !attached {
                messages.append(["role": role, "content": content])
                continue
            }
            let images = rawImages.map(androidString)
            var documents: [[String: Any]] = []
            for value in rawDocuments {
                guard let document = value as? [String: Any] else {
                    throw LocalChatRequestError.invalidAttachment
                }
                documents.append(document)
            }
            messages.append(["role": role,
                             "content": try parts(route: route, content: content,
                                                  images: images, documents: documents, using: resolver)])
        }
        var body: [String: Any] = [
            "model": route.model,
            "messages": messages,
            "stream": true,
        ]
        // Anthropic requires the cap on every request; OpenAI-compatible APIs do
        // not, and sending it would override a provider-side default.
        if route.isAnthropic { body["max_tokens"] = 4096 }
        LocalChatThinking.apply(route, thinking, to: &body)
        return body
    }

    /// The content parts for one turn that carries attachments.
    static func parts(route: LocalChatRoute,
                      content: String,
                      images: [String],
                      documents: [[String: Any]],
                      using resolver: LocalChatAttachmentResolving) throws -> [[String: Any]] {
        var parts: [[String: Any]] = []
        if !content.isEmpty { parts.append(["type": "text", "text": content]) }

        for image in images {
            try Task.checkCancellation()
            let encoded = try resolver.wireBase64(image)
            if route.isAnthropic {
                parts.append(["type": "image",
                              "source": ["type": "base64",
                                         "media_type": imageMediaType,
                                         "data": encoded]])
            } else {
                parts.append(["type": "image_url",
                              "image_url": ["url": dataURL(encoded)]])
            }
        }

        for document in documents {
            try Task.checkCancellation()
            guard let rawName = document["name"] else {
                throw LocalChatRequestError.invalidAttachment
            }
            let name = androidString(rawName)
            let mimeType = androidString(document["mimeType"])
            if mimeType == "application/pdf" {
                guard let rawData = document["data"] else {
                    throw LocalChatRequestError.invalidAttachment
                }
                let stored = androidString(rawData)
                let encoded = try resolver.wireBase64(stored)
                if route.isAnthropic {
                    parts.append(["type": "document",
                                  "title": name,
                                  "source": ["type": "base64",
                                             "media_type": "application/pdf",
                                             "data": encoded]])
                } else {
                    parts.append(["type": "file",
                                  "file": ["filename": name,
                                           "file_data": "data:application/pdf;base64," + encoded]])
                }
            } else {
                // Everything else had to be readable text to get this far. A
                // missing `text` means the extraction was lost, and silently
                // sending only the name would answer a question about contents
                // the model never received.
                guard let rawText = document["text"] else {
                    throw LocalChatRequestError.documentTextUnavailable
                }
                parts.append(["type": "text",
                              "text": "Attached document: " + name + "\nThe next text block is document content."])
                parts.append(["type": "text", "text": try resolver.wireText(androidString(rawText))])
            }
        }
        return parts
    }

    /// Android's `optString`/`getString` use JSON.toString, which coerces JSON
    /// scalars and containers instead of silently dropping non-string values.
    static func androidString(_ value: Any?) -> String {
        guard let value else { return "" }
        if let text = value as? String { return text }
        if value is NSNull { return "null" }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                return number.boolValue ? "true" : "false"
            }
            let type = String(cString: number.objCType)
            if type == "d" || type == "f" { return String(number.doubleValue) }
            return number.stringValue
        }
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) {
            return String(decoding: data, as: UTF8.self)
        }
        return String(describing: value)
    }
}
