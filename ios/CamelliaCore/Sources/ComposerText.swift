import Foundation

/// Text rules used by Android's chat composers and text forms. Java `String.trim()`
/// removes code units through U+0020; Foundation's whitespace set removes
/// more, including non-breaking spaces that Android sends as message text.
enum ComposerText {
    static func utf16Length(_ text: String) -> Int { (text as NSString).length }

    /// Match Android's LengthFilter for a complete value. Never retain half
    /// a surrogate pair when a pasted value reaches the field limit.
    static func limited(_ text: String, to maximumLength: Int) -> String {
        let source = text as NSString
        guard source.length > maximumLength else { return text }
        var length = maximumLength
        if (0xD800...0xDBFF).contains(source.character(at: length - 1)) { length -= 1 }
        return source.substring(to: length)
    }

    static func androidTrim(_ text: String) -> String {
        let source = text as NSString
        var start = 0
        var end = source.length
        while start < end, source.character(at: start) <= 0x20 { start += 1 }
        while end > start, source.character(at: end - 1) <= 0x20 { end -= 1 }
        if start == 0, end == source.length { return text }
        return source.substring(with: NSRange(location: start, length: end - start))
    }

    /// Remote sends preserve nonblank draft text verbatim. Only an
    /// attachment-only draft gets Android's localized prompt in its place.
    static func remotePrompt(_ draft: String, chinese: Bool) -> String {
        androidTrim(draft).isEmpty
            ? (chinese ? "请查看这些附件。" : "Please review these attachments.")
            : draft
    }

    /// `composed` has already passed through `androidTrim`. Android blocks an
    /// unsupported bare slash only without attachments; an attachment still
    /// makes the composer sendable.
    static func remoteHasMessage(composed: String, hasAttachments: Bool) -> Bool {
        let bareSlash = composed.range(of: "^/[a-z]+$", options: [.regularExpression, .caseInsensitive]) != nil
            && composed.lowercased() != "/find"
        return (!composed.isEmpty && !bareSlash) || hasAttachments
    }

    /// Unlike the remote list, Android's local list searches the raw query,
    /// including leading and trailing spaces.
    static func localSearchMatches(title: String, query: String) -> Bool {
        title.lowercased().contains(query.lowercased())
    }

    /// `value` is the local chat's Java-trimmed message. Android takes at
    /// most 60 UTF-16 units before replacing line breaks in a new title.
    static func localTitle(_ value: String, chinese: Bool) -> String {
        guard !value.isEmpty else { return chinese ? "附件" : "Attachments" }
        let source = value as NSString
        var length = min(60, source.length)
        if length < source.length, (0xD800...0xDBFF).contains(source.character(at: length - 1)) {
            length -= 1 // Never persist half of a surrogate pair as a title.
        }
        return source.substring(to: length).replacingOccurrences(of: "\n", with: " ")
    }
}
