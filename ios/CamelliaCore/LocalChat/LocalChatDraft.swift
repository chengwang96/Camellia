import Foundation

/// What the composer is holding for one conversation.
///
/// Ported from `LocalChatDraft.java`. A local conversation's draft is three
/// things — the text, the attached images and the attached documents — and it
/// lives inside the conversation object so that switching away and back is
/// lossless, and so that closing the app does not lose a half-written message.
///
/// The one rule worth stating plainly: only the *last* user turn can be edited.
/// `editIndex` looks for the most recent user message and returns it only if it
/// is the one named, which is why asking to edit an earlier turn yields none —
/// and with no edit target the attachments come from the draft rather than from
/// a message that would otherwise be rewritten in place.
public enum LocalChatDraft {
    /// The message being edited, or nil.
    public static func editIndex(_ conversation: [String: Any]) -> Int? {
        let target = conversation["draftEditIndex"] as? Int ?? -1
        let messages = (conversation["messages"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
        guard target >= 0, target < messages.count else { return nil }
        for index in stride(from: messages.count - 1, through: 0, by: -1) {
            guard (messages[index]["role"] as? String ?? "") == "user" else { continue }
            return index == target ? target : nil
        }
        return nil
    }

    public static func text(_ conversation: [String: Any]) -> String {
        conversation["draft"] as? String ?? ""
    }

    public static func images(_ conversation: [String: Any]) -> [String] {
        if let saved = conversation["draftImages"] as? [Any] {
            return saved.compactMap { $0 as? String }
        }
        guard let target = editIndex(conversation) else { return [] }
        let messages = (conversation["messages"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
        return (messages[target]["images"] as? [Any])?.compactMap { $0 as? String } ?? []
    }

    public static func documents(_ conversation: [String: Any]) -> [[String: Any]] {
        if let saved = conversation["draftDocuments"] as? [Any] {
            return saved.compactMap { $0 as? [String: Any] }
        }
        guard let target = editIndex(conversation) else { return [] }
        let messages = (conversation["messages"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
        return (messages[target]["documents"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
    }

    /// Stores the text and the edit target.
    public static func save(_ conversation: inout [String: Any], text: String, editIndex: Int?) {
        conversation["draft"] = text
        if let editIndex, editIndex >= 0 {
            conversation["draftEditIndex"] = editIndex
        } else {
            conversation.removeValue(forKey: "draftEditIndex")
        }
    }

    /// Stores the text, the target and the attachments.
    ///
    /// The attachments are written even when empty, because an empty list is a
    /// deliberate "I removed the photo" — leaving the keys off would make the
    /// read fall back to the message being edited and bring it back.
    public static func save(_ conversation: inout [String: Any], text: String, editIndex: Int?,
                            images: [String], documents: [[String: Any]]) {
        save(&conversation, text: text, editIndex: editIndex)
        conversation["draftImages"] = images
        conversation["draftDocuments"] = documents
    }

    /// Throws the draft away, attachments and all.
    public static func clear(_ conversation: inout [String: Any]) {
        conversation.removeValue(forKey: "draft")
        conversation.removeValue(forKey: "draftEditIndex")
        conversation.removeValue(forKey: "draftImages")
        conversation.removeValue(forKey: "draftDocuments")
    }
}
