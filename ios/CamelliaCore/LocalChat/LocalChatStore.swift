import Foundation

public enum LocalChatStoreError: Error, Equatable, CustomStringConvertible {
    case storageFull
    case storageUnavailable
    case corruptState
    case conversationNotFound
    case workspaceNotFound

    public var description: String {
        switch self {
        case .storageFull:
            return "本机聊天存储已满，请删除旧会话 / Local storage limit reached; delete old conversations"
        case .storageUnavailable:
            return "本机聊天存储不可用 / Local chat storage unavailable"
        case .corruptState:
            return "本机聊天存储已损坏 / Local chat storage is damaged"
        case .conversationNotFound: return "会话不存在 / Conversation not found"
        case .workspaceNotFound: return "Workspace not found"
        }
    }
}

/// Cached local state with one serial persistence owner.
///
/// The cache is published only after an encrypted manifest commits. Conversation
/// history and drafts have independent immutable record versions; legacy sealed
/// JSON remains readable and migrates on its first successful mutation. Readers
/// take a brief cache lock and never wait behind encryption or disk I/O.
/// Mutable persistence bookkeeping belongs exclusively to `writer`.
public final class LocalChatStore: @unchecked Sendable {
    /// The logical state keeps the existing 8 MiB bound after splitting files.
    public static let maximumBytes = 8 * 1024 * 1024
    /// Bound into the ciphertext, so a local-chat state cannot be opened as a
    /// credential blob or an attachment.
    public static let context = "camellia.localchat.v1"

    private let disk: LocalChatDisk
    private let attachments: AttachmentStore?
    private let lock = NSLock()
    private let writer = DispatchQueue(label: "app.camellia.localchat.persistence", qos: .userInitiated)
    private let writerKey = DispatchSpecificKey<Bool>()
    private var draftRevisions: [String: Int] = [:]
    private var writtenBytes = 0

    public var lastWriteBytes: Int { lock.lock(); defer { lock.unlock() }; return writtenBytes }

    /// App mutations enter the same serial writer as the synchronous host checks.
    public func perform<T>(_ operation: @escaping (LocalChatStore) throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            writer.async {
                do { continuation.resume(returning: try operation(self)) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    private func onWriter<T>(_ operation: () throws -> T) rethrows -> T {
        if DispatchQueue.getSpecific(key: writerKey) == true { return try operation() }
        return try writer.sync(execute: operation)
    }

    private func snapshot() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return state
    }

    private var state: [String: Any]

    /// Opens the store, or creates an empty one.
    ///
    /// A file that is present but unopenable is an error rather than a silent
    /// reset: overwriting it would destroy conversations the user can still see
    /// a reason to recover, and the caller can offer to start over explicitly.
    public init(directory: URL, keys: SecretKeyStore, attachments: AttachmentStore? = nil) throws {
        self.disk = LocalChatDisk(directory: directory, keys: keys)
        self.attachments = attachments

        let loaded = Self.normalized(try disk.load())
        state = loaded
        attachments?.updateReferences(owner: "local", references: AttachmentStore.references(in: loaded))
        writer.setSpecific(key: writerKey, value: true)
    }

    // MARK: - Reading

    public func config() -> [String: Any] {
        snapshot()["config"] as? [String: Any] ?? [:]
    }

    public func workspaces() -> [[String: Any]] {
        Self.list(snapshot(), "workspaces")
    }

    public func conversations() -> [[String: Any]] {
        Self.list(snapshot(), "conversations")
    }

    public func conversation(_ id: String) -> [String: Any]? {
        Self.conversation(in: snapshot(), id)
    }

    /// A workspace's conversations, pinned first, then in the user's own order,
    /// then most recently touched first.
    ///
    /// Conversations that were never dragged have no `order` and tie at the
    /// largest value, which puts them after every arranged one and leaves
    /// `updatedAt` to sort them — which is how a new conversation lands at the
    /// top of the unarranged block.
    public func orderedConversations(_ workspace: String) -> [[String: Any]] {
        Self.ordered(in: snapshot(), workspace: workspace)
    }

    private static func ordered(in state: [String: Any], workspace: String) -> [[String: Any]] {
        list(state, "conversations")
            .filter { !($0["archived"] as? Bool ?? false) && ($0["workspaceId"] as? String ?? "") == workspace }
            .sorted { left, right in
                let leftPinned = left["pinned"] as? Bool ?? false
                let rightPinned = right["pinned"] as? Bool ?? false
                if leftPinned != rightPinned { return leftPinned }
                let leftOrder = int64(left, "order", fallback: Int64.max)
                let rightOrder = int64(right, "order", fallback: Int64.max)
                if leftOrder != rightOrder { return leftOrder < rightOrder }
                return int64(left, "updatedAt") > int64(right, "updatedAt")
            }
    }

    // MARK: - Writing

    /// Commits the current state and updates this store's attachment ownership.
    public func save() throws {
        try onWriter { try commit(snapshot(), changed: nil) }
    }

    public func importConfig(_ config: [String: Any]) throws {
        try applying(changed: []) { $0["config"] = config }
    }

    /// Old asynchronous draft completions must not restore a consumed draft.
    @discardableResult
    public func updateDraft(_ id: String, revision: Int, _ body: (inout [String: Any]) -> Void) throws -> Bool {
        try onWriter {
            guard revision > draftRevisions[id, default: -1] else { return false }
            try update(id, body)
            draftRevisions[id] = revision
            return true
        }
    }

    /// Preparation can be cancelled while its durable commit is already running.
    /// Restore replaced history and unsent input without replacing a newer draft.
    public func rollbackPreparedSend(_ id: String, runID: String, consumedRevision: Int,
                                     restoredRevision: Int, previousMessages: [[String: Any]]? = nil,
                                     restore: (inout [String: Any]) -> Void) throws {
        try onWriter {
            guard let current = conversation(id),
                  let rows = current["messages"] as? [[String: Any]],
                  rows.count >= 2, rows.last?["runId"] as? String == runID else { return }
            let restoreDraft = draftRevisions[id, default: -1] <= consumedRevision
            try update(id) { entry in
                entry["messages"] = previousMessages ?? Array(rows.dropLast(2))
                if restoreDraft { restore(&entry) }
            }
            if restoreDraft { draftRevisions[id] = restoredRevision }
        }
    }

    public func createWorkspace(name: String) throws -> [String: Any] {
        let workspace: [String: Any] = ["id": Self.identifier(), "name": name]
        try applying { state in
            var list = Self.list(state, "workspaces")
            list.append(workspace)
            state["workspaces"] = list
        }
        return workspace
    }

    public func createConversation(workspaceId: String, routeId: String) throws -> [String: Any] {
        let conversation: [String: Any] = [
            "id": Self.identifier(),
            "title": "",
            "workspaceId": workspaceId,
            "routeId": routeId,
            "messages": [Any](),
            "updatedAt": Self.nowMillis(),
            "draft": "",
        ]
        try applying { state in
            var list = Self.list(state, "conversations")
            list.append(conversation)
            state["conversations"] = list
        }
        return conversation
    }

    public func deleteConversation(_ id: String) throws {
        try applying { state in
            state["conversations"] = Self.list(state, "conversations").filter { ($0["id"] as? String ?? "") != id }
        }
    }

    public func deleteConversations(_ ids: Set<String>) throws {
        try applying { state in
            state["conversations"] = Self.list(state, "conversations").filter { !ids.contains($0["id"] as? String ?? "") }
        }
    }

    public func archiveConversation(_ id: String, archived: Bool) throws {
        try update(id) { $0["archived"] = archived }
    }

    public func pinConversation(_ id: String, pinned: Bool) throws {
        try update(id) { $0["pinned"] = pinned }
    }

    /// Turns the web tools on or off for one conversation, and drops the legacy
    /// key the old search setting used to live under.
    public func configureTools(_ id: String, enabled: Bool) throws {
        try applying { state in
            guard var conversation = Self.conversation(in: state, id) else {
                throw LocalChatStoreError.conversationNotFound
            }
            state.removeValue(forKey: "webSearchKey")
            conversation["webTools"] = enabled
            Self.replace(state: &state, conversation: conversation)
        }
    }

    public func deleteWorkspace(_ id: String) throws {
        try applying { state in
            state["workspaces"] = Self.list(state, "workspaces").filter { ($0["id"] as? String ?? "") != id }
            // Conversations are not deleted with their workspace; they fall back
            // to the unfiled list, which is where the user can find them again.
            state["conversations"] = Self.list(state, "conversations").map { conversation in
                var updated = conversation
                if (updated["workspaceId"] as? String ?? "") == id { updated["workspaceId"] = "" }
                return updated
            }
        }
    }

    /// Renames a workspace in place.
    ///
    /// Android renames by mutating the live `JSONObject` its `workspaces()`
    /// returns; a Swift value type cannot be edited that way, so the write is
    /// its own method. The conversation list is untouched — a rename must not
    /// resequence anything, or a drag the user made earlier would be undone by
    /// a rename they made later.
    public func renameWorkspace(_ id: String, to name: String) throws {
        try applying { state in
            var list = Self.list(state, "workspaces")
            guard let index = list.firstIndex(where: { ($0["id"] as? String ?? "") == id }) else {
                throw LocalChatStoreError.workspaceNotFound
            }
            list[index]["name"] = name
            state["workspaces"] = list
        }
    }

    // MARK: - Details

    /// Applies a change to one conversation and writes it.
    ///
    public func update(_ id: String, _ body: (inout [String: Any]) -> Void) throws {
        try applying(changed: [id]) { state in
            guard var conversation = Self.conversation(in: state, id) else {
                throw LocalChatStoreError.conversationNotFound
            }
            body(&conversation)
            Self.replace(state: &state, conversation: conversation)
        }
    }

    /// Applies a value mutation on the writer; failed commits never reach readers.
    private func applying(changed: Set<String>? = nil, _ body: (inout [String: Any]) throws -> Void) throws {
        try onWriter {
            var next = snapshot()
            try body(&next)
            try commit(next, changed: changed)
        }
    }

    private func commit(_ next: [String: Any], changed: Set<String>?) throws {
        let result = try disk.commit(next, changed: changed)
        lock.lock()
        state = next
        writtenBytes = result.bytes
        lock.unlock()
        attachments?.updateReferences(owner: "local", references: result.references)
    }

    private static func list(_ state: [String: Any], _ key: String) -> [[String: Any]] {
        (state[key] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
    }

    private static func conversation(in state: [String: Any], _ id: String) -> [String: Any]? {
        list(state, "conversations").first { ($0["id"] as? String ?? "") == id }
    }

    private static func replace(state: inout [String: Any], conversation: [String: Any]) {
        var conversations = list(state, "conversations")
        guard let index = conversations.firstIndex(where: {
            ($0["id"] as? String ?? "") == (conversation["id"] as? String ?? "")
        }) else { return }
        conversations[index] = conversation
        state["conversations"] = conversations
    }

    private static func normalized(_ loaded: [String: Any]) -> [String: Any] {
        var state = loaded
        if !(state["workspaces"] is [Any]) { state["workspaces"] = [Any]() }
        if !(state["conversations"] is [Any]) { state["conversations"] = [Any]() }
        if !(state["config"] is [String: Any]) { state["config"] = [String: Any]() }
        return state
    }

    private static func int64(_ object: [String: Any], _ key: String, fallback: Int64 = 0) -> Int64 {
        if let number = object[key] as? NSNumber { return number.int64Value }
        if let text = object[key] as? String, let value = Int64(text) { return value }
        return fallback
    }

    /// Lowercased, as Java's `UUID.toString` is — the ids are shown in exports
    /// and compared between the two clients.
    static func identifier() -> String { UUID().uuidString.lowercased() }

    static func nowMillis() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

}
