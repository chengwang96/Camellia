import Foundation
import SwiftUI
import UIKit

/// A conversation as the list shows it.
struct LocalChatConversation: Identifiable, Equatable {
    let id: String
    let title: String
    let pinned: Bool
    let workspaceId: String
    let updatedAt: Int64

    func displayTitle(in locale: Locale, archived: Bool = false) -> String {
        guard title.isEmpty else { return title }
        if locale.identifier.lowercased().hasPrefix("zh") { return "新会话" }
        return archived ? "New chat" : "New conversation"
    }
}

/// A workspace as the list shows it.
///
/// The store keeps workspaces as dictionaries; this is the typed view of one,
/// so `ForEach` has an identity and the header does not look a name up by
/// string on every redraw.
struct LocalChatWorkspace: Identifiable, Equatable {
    let id: String
    let name: String

    var displayName: String { name.isEmpty ? "未命名工作区" : name }
}

/// One provider entry as the settings editor sees it. Unlike `LocalChatRoute`,
/// this keeps disabled providers and disabled keys, because hiding either would
/// make it impossible to turn them back on without re-importing the config.
struct LocalProviderDefinition: Identifiable, Equatable {
    struct Key: Identifiable, Equatable {
        var id: String
        var secret: String
        var enabled: Bool

        var masked: String {
            guard secret.count > 4 else { return "••••" }
            return "•••• " + secret.suffix(4)
        }
    }

    struct Model: Identifiable, Equatable {
        var id: String
        var upstream: String
        var wireProtocol: String
    }

    var id: String
    var name: String
    var baseURL: String
    var anthropicBaseURL: String
    var protocolName: String
    var enabled: Bool
    var keys: [Key]
    var models: [Model]
}

/// A turn as the chat shows it.
///
/// The store keeps turns as dictionaries because the state is one JSON object;
/// this is the typed view of one, so `ForEach` has an identity and the fields
/// a row needs are named rather than looked up by string.
struct LocalChatMessage: Identifiable, Equatable {
    let id: Int
    var role: String
    var text: String
    var images: [String]
    var documents: [[String: Any]]
    var process: [[String: Any]]
    var notice: String
    var at: Int64
    var state: String

    var isUser: Bool { role == "user" }

    /// Written out rather than synthesised: `documents` and `process` are
    /// `[[String: Any]]`, and `Any` has no `==`, so the compiler cannot derive
    /// this. The dictionaries hold only property-list values, so a deep
    /// `NSArray` comparison is exact here — two turns are equal when their
    /// decoded contents are.
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id
            && lhs.role == rhs.role
            && lhs.text == rhs.text
            && lhs.images == rhs.images
            && lhs.notice == rhs.notice
            && lhs.at == rhs.at
            && lhs.state == rhs.state
            && (lhs.documents as NSArray).isEqual(to: rhs.documents)
            && (lhs.process as NSArray).isEqual(to: rhs.process)
    }

    init(index: Int, raw: [String: Any]) {
        id = index
        role = raw["role"] as? String ?? ""
        text = raw["content"] as? String ?? ""
        images = (raw["images"] as? [Any])?.compactMap { $0 as? String } ?? []
        documents = (raw["documents"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
        process = (raw["process"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
        notice = raw["notice"] as? String ?? ""
        at = (raw["at"] as? NSNumber)?.int64Value ?? 0
        state = raw["state"] as? String ?? ""
    }

    var dictionary: [String: Any] {
        var raw: [String: Any] = ["role": role, "content": text, "at": at]
        if !images.isEmpty { raw["images"] = images }
        if !documents.isEmpty { raw["documents"] = documents }
        if !process.isEmpty { raw["process"] = process }
        if !notice.isEmpty { raw["notice"] = notice }
        if !state.isEmpty { raw["state"] = state }
        return raw
    }
}

/// Reads a stored `camellia-blob:` / `camellia-text:` reference back into the
/// bytes or the text a provider expects.
///
/// This is the seam the request builder was written against: the history holds
/// references, the wire wants base64, and this is where one becomes the other.
/// Document text is sealed like an attachment and only becomes an ordinary
/// string here, on the way out.
struct LocalChatBlobs: LocalChatAttachmentSizing, Sendable {
    let store: AttachmentStore

    func wireBase64(_ value: String) throws -> String {
        guard AttachmentStore.isReference(value) else { return value }
        return try store.open(value).base64EncodedString()
    }

    func wireText(_ value: String) throws -> String {
        guard value.hasPrefix(AttachmentStore.textPrefix) else { return value }
        let reference = AttachmentStore.prefix + value.dropFirst(AttachmentStore.textPrefix.count)
        return String(decoding: try store.open(reference), as: UTF8.self)
    }

    func base64ByteCount(_ value: String) throws -> Int64 {
        guard AttachmentStore.isReference(value) else { return Int64(value.utf8.count) }
        return (try store.size(value) + 2) / 3 * 4
    }

    func textByteCount(_ value: String) throws -> Int64 {
        guard value.hasPrefix(AttachmentStore.textPrefix) else { return Int64(value.utf8.count) }
        return try store.size(AttachmentStore.prefix + value.dropFirst(AttachmentStore.textPrefix.count))
    }
}

/// Everything the local-chat screens share.
///
/// Local chat is the half of the app that has no desktop behind it: the
/// conversations, the imported provider configuration and the replies all live
/// on this phone. So the model is both the store's façade and the run's state
/// machine — it holds what is being typed, what is being streamed, and which
/// request is allowed to write to the screen, and it drops the callbacks of a
/// run the user has already left.
@MainActor
final class LocalChatModel: ObservableObject {
    private(set) var store: LocalChatStore
    let attachments: AttachmentStore

    @Published var conversations: [LocalChatConversation] = []
    /// The conversations the list is told not to show.
    ///
    /// Kept beside `conversations` rather than filtered on demand so the
    /// archived screen is live: archiving from the list moves one array to the
    /// other and the screen that is open behind the sheet redraws.
    @Published var archived: [LocalChatConversation] = []
    @Published var workspaces: [LocalChatWorkspace] = []
    @Published var routes: [LocalChatRoute] = []
    @Published private(set) var routeError: String?

    @Published var openId: String?
    @Published var messages: [LocalChatMessage] = []
    @Published var editingIndex: Int?
    @Published var draft = ""
    @Published var images: [String] = []
    @Published var documents: [[String: Any]] = []
    @Published var imagePreviews: [String: UIImage] = [:]

    @Published var running = false
    @Published private(set) var loading = true
    @Published private(set) var needsSaveRetry = false
    @Published private(set) var preparing = false
    @Published private(set) var contextSummary: String?
    /// The conversation whose provider request is in flight.
    ///
    /// `openId` follows navigation and becomes nil on the list. A reply may
    /// keep running there, so its owner cannot be inferred from the screen.
    @Published private(set) var runningConversationId: String?
    @Published var liveText = ""
    @Published var busy = false
    @Published var notice: Notice?

    /// The consent sheet waiting on the person, when the message being sent
    /// looks like it needs to know where they are.
    @Published var locationConsent: LocationConsent?
    /// The send waiting on that sheet.
    private var pendingSend: PreparedSend?
    private let location = LocationService()

    struct Notice: Identifiable, Equatable {
        let id = UUID()
        let text: String
        let serious: Bool
    }

    private struct ActiveRun {
        let conversationId: String
        var text: String
        var process: [[String: Any]]
    }

    private var client: LocalChatClient?
    private var generation = 0
    private var lastCheckpoint: TimeInterval = 0
    private var activeRun: ActiveRun?
    private var draftSaveTask: Task<Void, Never>?
    @Published private(set) var committingAttachments = false
    private var attachmentCommitTask: Task<Bool, Never>?
    private var attachmentCommitID: String?
    private var previewLoadTask: Task<Void, Never>?
    private var previewBuildTask: Task<[String: UIImage], Never>?
    private var requestBuildTask: Task<LocalChatPreparedRequest, Error>?
    private var requestCompletionTask: Task<Void, Never>?
    private var initialLoadTask: Task<Void, Never>?
    private var draftRevision = 0
    private struct DraftSnapshot {
        let text: String
        let editIndex: Int?
        let images: [String]
        let documents: [[String: Any]]
        let revision: Int
    }
    private struct PreparationRollback {
        let id: String
        let runID: String
        let consumedRevision: Int
        let draft: DraftSnapshot
        let previousMessages: [[String: Any]]
        let attachmentHold: AttachmentStore.ReferenceHold
    }
    private var pendingPreparationRollback: PreparationRollback?
    private var preparationRollbackTask: Task<Void, Never>?
    private var pendingDrafts: [String: DraftSnapshot] = [:]
    private var checkpointTask: Task<Void, Never>?
    private var pendingCheckpoint: ActiveRun?
    private var finishing = false
    private var pendingFinish: (problem: String?, state: String)?
    private var finishTask: Task<Void, Never>?
    private var saveGrant: UIBackgroundTaskIdentifier = .invalid
    private var saveGrantToken: UUID?
    private var saveFlushRevision = 0
    private let blobs: LocalChatBlobs

    init(store supplied: LocalChatStore? = nil, attachments: AttachmentStore = AppStores.attachmentStore) {
        store = supplied ?? AppStores.placeholderLocalChatStore()
        self.attachments = attachments
        blobs = LocalChatBlobs(store: attachments)
        initialLoadTask = Task { [weak self] in
            let loaded: LocalChatStore
            if let supplied { loaded = supplied }
            else {
                loaded = await Task.detached(priority: .userInitiated) {
                    let store = AppStores.localChatStore
                    AppStores.reconcileAttachments()
                    return store
                }.value
            }
            guard let self else { return }
            self.store = loaded
            await self.refresh()
            self.loading = false
            self.initialLoadTask = nil
        }
    }

    private func withStorage<T>(_ operation: @escaping (LocalChatStore) throws -> T) async throws -> T {
        await initialLoadTask?.value
        return try await store.perform(operation)
    }

    private func nextDraftRevision() -> Int { draftRevision += 1; return draftRevision }

    // MARK: - Loading

    /// Reads the store back and repairs any reply the last run left running.
    ///
    /// A reply in `running` state is one the process did not live to finish —
    /// the app was killed, or it never came back from the background. It is
    /// marked interrupted rather than resent, because resending is a request
    /// the user did not make.
    func refresh() async {
        if AppStores.localChatRecovered {
            notice = Notice(text: "本机聊天文件已损坏，原文件已保留，并建立新的空存储。", serious: true)
        } else if AppStores.localChatUnavailable {
            notice = Notice(text: "本机聊天暂时无法读取，原文件未被修改。请解锁设备并重启 App；在此之前无法保存本机聊天。", serious: true)
        }
        do {
            let recovered = try await store.perform { store in
                var recovered = false
                for conversation in store.conversations() {
                    guard let id = conversation["id"] as? String else { continue }
                    let turns = (conversation["messages"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
                    guard turns.contains(where: { $0["state"] as? String == "running" }) else { continue }
                    try store.update(id) { entry in
                        var updated = (entry["messages"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
                        for index in updated.indices where updated[index]["state"] as? String == "running" {
                            updated[index]["state"] = "interrupted"
                            updated[index]["notice"] = "上次回复已中断，未自动重发。"
                            var process = (updated[index]["process"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
                            for step in process.indices where process[step]["status"] as? String == "running" {
                                process[step]["status"] = "cancelled"
                            }
                            if !process.isEmpty { updated[index]["process"] = process }
                        }
                        entry["messages"] = updated
                    }
                    recovered = true
                }
                return recovered
            }
            if recovered, notice == nil { notice = Notice(text: "上次回复已中断，未自动重发。", serious: false) }
            reloadWorkspaces()
            reloadList()
            try reloadRoutes()
        } catch {
            notice = Notice(text: Self.describe(error), serious: true)
        }
    }

    func reloadWorkspaces() {
        workspaces = store.workspaces().compactMap { raw in
            guard let id = raw["id"] as? String else { return nil }
            return LocalChatWorkspace(id: id, name: raw["name"] as? String ?? "")
        }
    }

    func workspace(_ id: String) -> LocalChatWorkspace? {
        workspaces.first { $0.id == id }
    }

    private func reloadRoutes() throws {
        do {
            routes = try LocalChatConfiguration.routes(store.config())
            routeError = nil
        } catch {
            routeError = Self.describe(error)
            routes = []
            throw error
        }
    }

    func reloadList() {
        var live: [LocalChatConversation] = []
        var filed: [LocalChatConversation] = []
        for raw in store.conversations() {
            guard let id = raw["id"] as? String else { continue }
            let conversation = LocalChatConversation(
                id: id,
                title: raw["title"] as? String ?? "",
                pinned: raw["pinned"] as? Bool ?? false,
                workspaceId: raw["workspaceId"] as? String ?? "",
                updatedAt: (raw["updatedAt"] as? NSNumber)?.int64Value ?? 0)
            if raw["archived"] as? Bool ?? false {
                filed.append(conversation)
            } else {
                live.append(conversation)
            }
        }
        conversations = live
        archived = filed
    }

    /// Puts an archived conversation back into the list.
    func restore(_ id: String) {
        archive(id, archived: false)
    }

    /// What a workspace holds, in the order the store decided.
    func conversations(in workspace: String) -> [LocalChatConversation] {
        let ids = store.orderedConversations(workspace).compactMap { $0["id"] as? String }
        return ids.compactMap { id in conversations.first { $0.id == id } }
    }

    var unfiled: [LocalChatConversation] { conversations(in: "") }

    // MARK: - Opening

    func open(_ id: String) {
        if preparing, openId != id { cancelRequestPreparation() }
        contextSummary = nil
        openId = id
        messages = read(id)
        var conversation = store.conversation(id) ?? [:]
        if let pending = pendingDrafts[id] {
            LocalChatDraft.save(&conversation, text: pending.text, editIndex: pending.editIndex,
                                images: pending.images, documents: pending.documents)
        }
        draft = LocalChatDraft.text(conversation)
        editingIndex = LocalChatDraft.editIndex(conversation)
        images = LocalChatDraft.images(conversation)
        documents = LocalChatDraft.documents(conversation)
        liveText = runningConversationId == id ? (messages.last?.text ?? "") : ""
        loadPreviews()
    }

    func close() {
        cancelRequestPreparation()
        contextSummary = nil
        stashDraft()
        previewLoadTask?.cancel()
        previewBuildTask?.cancel()
        openId = nil
        messages = []
        draft = ""
        images = []
        documents = []
        imagePreviews = [:]
        editingIndex = nil
        liveText = ""
    }

    private func read(_ id: String) -> [LocalChatMessage] {
        let turns = (store.conversation(id)?["messages"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
        return turns.enumerated().map { LocalChatMessage(index: $0.offset, raw: $0.element) }
    }

    // MARK: - Conversation actions

    @discardableResult
    func createConversation(workspace: String) async -> LocalChatConversation? {
        guard let route = routes.first else {
            notice = Notice(text: "请先导入 API 配置，再新建会话。", serious: false)
            return nil
        }
        do {
            let id = try await withStorage { store in
                try store.createConversation(workspaceId: workspace, routeId: route.id)["id"] as! String
            }
            reloadList()
            guard let conversation = conversations.first(where: { $0.id == id }) else { return nil }
            open(id)
            return conversation
        } catch {
            notice = Notice(text: Self.describe(error), serious: true)
            return nil
        }
    }

    @discardableResult
    func createWorkspace(name: String) async -> Bool {
        do {
            _ = try await withStorage { try $0.createWorkspace(name: name)["id"] as? String }
            reloadWorkspaces()
            return true
        } catch {
            notice = Notice(text: Self.describe(error), serious: true)
            return false
        }
    }

    @discardableResult
    func rename(_ id: String, to title: String) async -> Bool {
        guard id != runningConversationId else {
            notice = Notice(text: "请先停止此会话的回复。", serious: false)
            return false
        }
        let trimmed = ComposerText.androidTrim(title)
        guard !trimmed.isEmpty, ComposerText.utf16Length(trimmed) <= 100 else {
            notice = Notice(text: "请输入 1–100 字的标题。", serious: false)
            return false
        }
        return await mutate(id) { $0["title"] = trimmed }
    }

    func togglePin(_ id: String, pinned: Bool) {
        guard id != runningConversationId else {
            notice = Notice(text: "请先停止此会话的回复。", serious: false)
            return
        }
        Task { await mutate(id) { $0["pinned"] = pinned } }
    }

    func archive(_ id: String, archived: Bool) {
        guard id != runningConversationId else {
            notice = Notice(text: "请先停止此会话的回复。", serious: false)
            return
        }
        Task { await mutate(id) { $0["archived"] = archived } }
    }

    @discardableResult
    func delete(_ ids: [String]) async -> Bool {
        if let rollback = pendingPreparationRollback, ids.contains(rollback.id) {
            retryPreparationRollback()
            await preparationRollbackTask?.value
            guard pendingPreparationRollback == nil else { return false }
        }
        if let attachmentCommitID, ids.contains(attachmentCommitID) {
            _ = await attachmentCommitTask?.value
        }
        if preparing, let id = runningConversationId, ids.contains(id) {
            cancelRequestPreparation()
            await requestCompletionTask?.value
        }
        if let runningConversationId, ids.contains(runningConversationId) {
            notice = Notice(text: "请先停止所选会话的回复。", serious: false)
            return false
        }
        do {
            try await withStorage { try $0.deleteConversations(Set(ids)) }
            for id in ids { pendingDrafts.removeValue(forKey: id) }
            if let open = openId, ids.contains(open) { close() }
            reloadList()
            return true
        } catch {
            notice = Notice(text: Self.describe(error), serious: true)
            return false
        }
    }

    @discardableResult
    func renameWorkspace(_ id: String, to name: String) async -> Bool {
        let trimmed = ComposerText.androidTrim(name)
        guard !trimmed.isEmpty, ComposerText.utf16Length(trimmed) <= 80 else {
            notice = Notice(text: "请输入 1–80 字的名称。", serious: false)
            return false
        }
        do {
            try await withStorage { try $0.renameWorkspace(id, to: trimmed) }
            reloadWorkspaces()
            return true
        } catch {
            notice = Notice(text: Self.describe(error), serious: true)
            return false
        }
    }

    func deleteWorkspace(_ id: String) {
        Task {
            do {
                try await withStorage { try $0.deleteWorkspace(id) }
                reloadWorkspaces()
                reloadList()
            } catch {
                notice = Notice(text: Self.describe(error), serious: true)
            }
        }
    }

    @discardableResult
    private func mutate(_ id: String, _ body: @escaping (inout [String: Any]) -> Void) async -> Bool {
        do {
            try await withStorage { try $0.update(id, body) }
            reloadList()
            return true
        } catch {
            notice = Notice(text: Self.describe(error), serious: true)
            return false
        }
    }

    // MARK: - Route and tools

    func conversation(_ id: String?) -> [String: Any] {
        guard let id else { return [:] }
        return store.conversation(id) ?? [:]
    }

    func selectedRoute() -> LocalChatRoute? {
        let id = conversation(openId)["routeId"] as? String ?? ""
        return routes.first { $0.id == id } ?? routes.first
    }

    var thinking: String {
        LocalChatThinking.normalize(conversation(openId)["thinking"] as? String ?? "auto")
    }

    var webTools: Bool { conversation(openId)["webTools"] as? Bool ?? false }

    func selectRoute(_ route: LocalChatRoute) {
        guard !running, let id = openId else { return }
        // Changing the model resets the thinking level, because a level the new
        // model does not take would be sent anyway.
        let current = conversation(id)
        let thinking = route.id == (current["routeId"] as? String ?? "")
            ? (current["thinking"] as? String ?? "auto") : "auto"
        saveModel(route.id, thinking: thinking)
    }

    func selectThinking(_ level: String) {
        guard !running, let id = openId else { return }
        saveModel(conversation(id)["routeId"] as? String ?? "", thinking: level)
    }

    private func saveModel(_ routeId: String, thinking: String) {
        guard let id = openId else { return }
        Task {
            do {
                try await withStorage { store in
                    try store.update(id) { conversation in
                        conversation["routeId"] = routeId
                        conversation["thinking"] = LocalChatThinking.normalize(thinking)
                    }
                }
                objectWillChange.send()
            } catch {
                notice = Notice(text: Self.describe(error), serious: true)
            }
        }
    }

    func setTools(_ enabled: Bool) async -> String? {
        guard !running, let id = openId else { return "当前会话不可用。" }
        do {
            try await withStorage { try $0.configureTools(id, enabled: enabled) }
            objectWillChange.send()
            return nil
        } catch {
            let message = Self.describe(error)
            notice = Notice(text: message, serious: true)
            return message
        }
    }

    // MARK: - Attachments

    func addImages(_ picked: [UIImage]) {
        addImages(count: picked.count) { try AttachmentImage.encode(picked[$0]) }
    }

    func addEncodedImages(_ picked: [AttachmentImage.Encoded]) {
        addImages(count: picked.count) { picked[$0] }
    }

    private func addImages(count: Int, encode: @escaping (Int) throws -> AttachmentImage.Encoded) {
        guard count > 0, !running, !busy, let id = openId else { return }
        let room = AttachmentLimits.maxCount - images.count - documents.count
        guard room > 0, count <= room else {
            notice = Notice(text: "最多 \(AttachmentLimits.maxCount) 个附件。", serious: false)
            return
        }
        busy = true
        let store = attachments
        let existing = attachmentsFor(images: images, documents: documents)
        DispatchQueue.global(qos: .userInitiated).async {
            var added: [String] = []
            var previews: [String: UIImage] = [:]
            var failure: String?
            for index in 0..<count {
                do {
                    let encoded = try encode(index)
                    let reference = try store.save(encoded.data)
                    added.append(reference)
                    try store.savePreview(reference, encoded.preview)
                    if let preview = UIImage(data: encoded.preview) { previews[reference] = preview }
                } catch {
                    failure = Self.describe(error)
                    break
                }
            }
            if failure == nil {
                do {
                    let candidates = existing + added.enumerated().map {
                        RemoteAttachment(name: "mobile-image-\($0.offset + 1).jpg",
                                         data: $0.element, isImage: true)
                    }
                    var sizes: [String: Int64] = [:]
                    for attachment in candidates { sizes[attachment.data] = try store.size(attachment.data) }
                    try AttachmentRules.validate(candidates, sizes: sizes)
                } catch {
                    failure = Self.describe(error)
                }
            }
            DispatchQueue.main.async {
                self.busy = false
                guard failure == nil, self.openId == id else {
                    for reference in added { store.remove(reference) }
                    if let failure, self.openId == id {
                        self.notice = Notice(text: failure, serious: false)
                    }
                    return
                }
                self.commitAttachments(id: id, images: added, documents: [], previews: previews)
            }
        }
    }

    func addFiles(_ picked: [PickedFile]) {
        guard !picked.isEmpty, !running, !busy, let id = openId else { return }
        let room = AttachmentLimits.maxCount - images.count - documents.count
        guard room > 0, picked.count <= room else {
            notice = Notice(text: "最多 \(AttachmentLimits.maxCount) 个附件。", serious: false)
            return
        }
        busy = true
        let store = attachments
        let existing = attachmentsFor(images: images, documents: documents)
        DispatchQueue.global(qos: .userInitiated).async {
            var addedImages: [String] = []
            var previews: [String: UIImage] = [:]
            var addedDocuments: [[String: Any]] = []
            var failure: String?
            for file in picked {
                do {
                    if file.isImage {
                        let encoded = try AttachmentImage.encode(file.loadImage())
                        let reference = try store.save(encoded.data)
                        addedImages.append(reference)
                        try store.savePreview(reference, encoded.preview)
                        if let preview = UIImage(data: encoded.preview) { previews[reference] = preview }
                    } else {
                        addedDocuments.append(try Self.seal(file, into: store))
                    }
                } catch {
                    failure = Self.describe(error)
                    break
                }
            }
            if failure == nil {
                do {
                    let candidates = existing + addedImages.enumerated().map {
                        RemoteAttachment(name: "mobile-image-\($0.offset + 1).jpg",
                                         data: $0.element, isImage: true)
                    } + addedDocuments.map {
                        RemoteAttachment(name: $0["name"] as? String ?? "document",
                                         data: $0["data"] as? String ?? "", isImage: false)
                    }
                    var sizes: [String: Int64] = [:]
                    for attachment in candidates { sizes[attachment.data] = try store.size(attachment.data) }
                    try AttachmentRules.validate(candidates, sizes: sizes)
                } catch {
                    failure = Self.describe(error)
                }
            }
            DispatchQueue.main.async {
                self.busy = false
                guard failure == nil, self.openId == id else {
                    for reference in addedImages { store.remove(reference) }
                    Self.discard(documents: addedDocuments, from: store)
                    if let failure, self.openId == id {
                        self.notice = Notice(text: failure, serious: false)
                    }
                    return
                }
                self.commitAttachments(id: id, images: addedImages, documents: addedDocuments, previews: previews)
            }
        }
    }

    /// Extracts a document's text and seals both it and its bytes.
    ///
    /// A PDF keeps its native bytes and goes over as a document; everything
    /// else is read to text here and sealed under a text reference, so the
    /// request builder only ever has to swap a prefix.
    nonisolated private static func seal(_ document: PickedFile, into store: AttachmentStore) throws -> [String: Any] {
        let read = try ChatDocument.read(name: document.name, data: document.readData(), local: true)
        var saved: [String] = []
        do {
            let reference = try store.save(read.bytes)
            saved.append(reference)
            var entry: [String: Any] = [
                "name": read.name,
                "data": reference,
                "size": read.bytes.count,
                "mimeType": read.isPDF ? "application/pdf" : "text/plain",
                "isImage": false,
            ]
            if let text = read.text {
                let blob = try store.save(Data(text.utf8))
                saved.append(blob)
                entry["text"] = blob.replacingOccurrences(of: AttachmentStore.prefix,
                                                           with: AttachmentStore.textPrefix)
            }
            return entry
        } catch {
            for reference in saved { store.remove(reference) }
            throw error
        }
    }

    func removeImage(_ reference: String) {
        guard !busy, !preparing else { return }
        images.removeAll { $0 == reference }
        imagePreviews.removeValue(forKey: reference)
        stashDraft()
    }

    func removeDocument(_ name: String, at index: Int) {
        guard !busy, !preparing, documents.indices.contains(index) else { return }
        documents.remove(at: index)
        stashDraft()
    }

    nonisolated private static func discard(documents: [[String: Any]], from store: AttachmentStore) {
        for document in documents {
            if let reference = document["data"] as? String { store.remove(reference) }
            if let reference = document["text"] as? String { store.remove(reference) }
        }
    }

    private func loadPreviews() {
        previewLoadTask?.cancel()
        previewBuildTask?.cancel()
        imagePreviews = [:]
        let selected = images
        let id = openId
        let attachments = attachments
        let work = Task.detached(priority: .userInitiated) {
            var loaded: [String: UIImage] = [:]
            for reference in selected {
                if Task.isCancelled { break }
                guard let data = try? attachments.preview(reference), let image = UIImage(data: data) else { continue }
                loaded[reference] = image
            }
            return loaded
        }
        previewBuildTask = work
        previewLoadTask = Task { [weak self] in
            let loaded = await work.value
            guard !Task.isCancelled, let self, self.openId == id else { return }
            for (reference, image) in loaded where self.images.contains(reference) {
                self.imagePreviews[reference] = image
            }
        }
    }

    /// Newly sealed files remain leased until the candidate draft commits.
    /// The composer pauses edits during this short commit so rollback cannot
    /// conflict with a later draft containing the same uncommitted files.
    private func commitAttachments(id: String, images addedImages: [String],
                                   documents addedDocuments: [[String: Any]], previews: [String: UIImage]) {
        draftSaveTask?.cancel()
        draftSaveTask = nil
        let original = DraftSnapshot(text: draft, editIndex: editingIndex, images: images,
                                     documents: documents, revision: nextDraftRevision())
        let candidate = DraftSnapshot(text: original.text, editIndex: original.editIndex,
            images: original.images + addedImages, documents: original.documents + addedDocuments,
            revision: nextDraftRevision())
        pendingDrafts[id] = candidate
        committingAttachments = true
        attachmentCommitID = id
        busy = true
        attachmentCommitTask = Task { [weak self] in
            guard let self else { return false }
            defer {
                self.committingAttachments = false
                self.attachmentCommitID = nil
                self.attachmentCommitTask = nil
                self.busy = false
            }
            do {
                let committed = try await self.withStorage { store in
                    try store.updateDraft(id, revision: candidate.revision) { conversation in
                        LocalChatDraft.save(&conversation, text: candidate.text, editIndex: candidate.editIndex,
                                            images: candidate.images, documents: candidate.documents)
                    }
                }
                guard committed else { throw LocalChatStoreError.storageUnavailable }
                if self.pendingDrafts[id]?.revision == candidate.revision { self.pendingDrafts.removeValue(forKey: id) }
                if self.openId == id {
                    self.images = candidate.images
                    self.documents = candidate.documents
                    for (reference, image) in previews { self.imagePreviews[reference] = image }
                }
                return true
            } catch {
                for reference in addedImages { self.attachments.remove(reference) }
                Self.discard(documents: addedDocuments, from: self.attachments)
                let restored = DraftSnapshot(text: original.text, editIndex: original.editIndex, images: original.images,
                                             documents: original.documents, revision: self.nextDraftRevision())
                self.pendingDrafts[id] = restored
                if self.openId == id {
                    self.images = original.images
                    self.documents = original.documents
                    self.loadPreviews()
                }
                self.notice = Notice(text: Self.describe(error), serious: true)
                return false
            }
        }
    }

    // MARK: - Draft

    /// Writes the composer back into the conversation.
    ///
    /// Edits debounce for 500 ms; navigation and backgrounding flush immediately.
    /// A failed write keeps the captured draft available for recovery and retry.
    @discardableResult
    func stashDraft() -> Task<Bool, Never>? {
        draftSaveTask?.cancel()
        draftSaveTask = nil
        if attachmentCommitID == openId, committingAttachments { return attachmentCommitTask }
        guard let id = openId, store.conversation(id) != nil else { return nil }
        let snapshot = DraftSnapshot(text: draft, editIndex: editingIndex, images: images,
                                     documents: documents, revision: nextDraftRevision())
        pendingDrafts[id] = snapshot
        return Task { [weak self] in
            guard let self else { return false }
            do {
                let committed = try await self.withStorage { store in
                    try store.updateDraft(id, revision: snapshot.revision) { conversation in
                        LocalChatDraft.save(&conversation, text: snapshot.text, editIndex: snapshot.editIndex,
                                            images: snapshot.images, documents: snapshot.documents)
                    }
                }
                if self.pendingDrafts[id]?.revision == snapshot.revision {
                    self.pendingDrafts.removeValue(forKey: id)
                }
                return committed
            } catch {
                if self.pendingDrafts[id]?.revision == snapshot.revision {
                    self.notice = Notice(text: Self.describe(error), serious: true)
                }
                return false
            }
        }
    }

    /// Coalesces keystrokes into one write.
    ///
    /// The draft's small encrypted record is flushed when the conversation is
    /// left or closed, including edits still inside the debounce window.
    func scheduleDraftSave() {
        draftSaveTask?.cancel()
        draftSaveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return }
            _ = self?.stashDraft()
        }
    }

    /// Starts editing the last user turn.
    ///
    /// Only the newest user turn is editable, because everything after it was
    /// generated from it; rewriting an earlier question would leave the answers
    /// below describing a prompt that no longer exists, and the store would have
    /// no way to tell which of them to drop.
    func beginEdit(_ index: Int) {
        guard !running, !busy, openId != nil, messages.indices.contains(index), messages[index].isUser else { return }
        let last = messages.lastIndex { $0.isUser }
        guard last == index else { return }
        editingIndex = index
        draft = messages[index].text
        images = messages[index].images
        documents = messages[index].documents
        loadPreviews()
        stashDraft()
    }

    func cancelEdit() {
        guard !running, !busy else { return }
        editingIndex = nil
        draft = ""
        images = []
        documents = []
        imagePreviews = [:]
        stashDraft()
    }

    // MARK: - Sending

    /// A send that has been checked but not yet made.
    ///
    /// Held while a location consent sheet is up. Everything the person can
    /// change while it is open is in here, so the send can be re-checked rather
    /// than made against a draft that is no longer on screen — and so the
    /// location note can be added to the request without ever reaching the
    /// stored conversation, which is the one place the local half differs from
    /// the remote half: this phone owns the transcript.
    private struct PreparedSend {
        let conversationId: String
        let draft: String
        let value: String
        let chinese: Bool
        let images: [String]
        let documents: [[String: Any]]
        let editingIndex: Int?
        let route: LocalChatRoute
    }

    func send(chinese: Bool) {
        guard let prepared = prepareSend(chinese: chinese) else { return }
        // A rewrite is never sent anywhere but over the turn it replaces, so the
        // question is asked for a fresh prompt only.
        guard prepared.editingIndex == nil, LocationContext.isRelevant(prepared.value) else {
            perform(prepared, context: "")
            return
        }
        pendingSend = prepared
        locationConsent = LocationConsent(destination: locationDestination(prepared.route))
    }

    /// Validates a send and describes it, without making it.
    private func prepareSend(chinese: Bool) -> PreparedSend? {
        guard !running, !busy, let id = openId else { return nil }
        let value = ComposerText.androidTrim(draft)
        guard !value.isEmpty || !images.isEmpty || !documents.isEmpty else { return nil }
        guard let route = selectedRoute() else {
            notice = Notice(text: "请先导入 API 配置。", serious: false)
            return nil
        }
        do {
            let sending = attachmentsFor(images: images, documents: documents)
            try AttachmentRules.validate(sending, sizes: try sizes(sending))
        } catch {
            notice = Notice(text: Self.describe(error), serious: false)
            return nil
        }
        return PreparedSend(conversationId: id, draft: draft, value: value,
                            chinese: chinese,
                            images: images, documents: documents,
                            editingIndex: editingIndex, route: route)
    }

    /// Makes the send, with whatever location note was collected.
    private func perform(_ prepared: PreparedSend, context: String) {
        let id = prepared.conversationId
        let value = prepared.value
        guard !running, !busy, openId == id else { return }

        let conversation = store.conversation(id) ?? [:]
        let stored = (conversation["messages"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
        let replaceFrom = (prepared.editingIndex.map { stored.indices.contains($0) ? $0 : stored.count }) ?? stored.count
        let sentAt = LocalChatStore.nowMillis()

        var user: [String: Any] = ["role": "user", "content": value, "at": sentAt]
        if !prepared.images.isEmpty { user["images"] = prepared.images }
        if !prepared.documents.isEmpty { user["documents"] = prepared.documents }

        // The note goes into the request only, never into `user`. Android makes
        // the same split: the conversation on this phone keeps what the person
        // typed, and only the outbound history carries where they were — so a
        // location shared for one question is not silently persisted into every
        // later request that replays this transcript.
        var requestUser = user
        if !context.isEmpty, let text = requestUser["content"] as? String {
            requestUser["content"] = text + context
        }
        var prospective = Array(stored.prefix(replaceFrom))
        prospective.append(requestUser)

        let input: [LocalChatInputMessage]
        do { input = try LocalChatInputMessage.history(prospective) }
        catch { notice = Notice(text: Self.describe(error), serious: false); return }
        let thinking = self.thinking
        let useTools = webTools
        let resolver = blobs
        let route = prepared.route
        generation += 1
        let ticket = generation
        preparing = true
        running = true
        runningConversationId = id
        contextSummary = nil
        let work = Task.detached(priority: .userInitiated) {
            try LocalChatRequestBudget.prepare(route: route, history: input,
                                               thinking: thinking, using: resolver)
        }
        requestBuildTask = work
        requestCompletionTask = Task { [weak self] in
            do {
                let built = try await work.value
                guard let self else { return }
                guard self.generation == ticket else { self.endCancelledPreparation(id); return }
                self.requestBuildTask = nil
                guard self.isStillCurrent(prepared), self.store.conversation(id) != nil else {
                    self.preparing = false
                    self.running = false
                    self.runningConversationId = nil
                    return
                }
                let title = conversation["title"] as? String ?? ""
                var next = Array(stored.prefix(replaceFrom))
                next.append(user)
                let runID = UUID().uuidString
                next.append(["role": "assistant", "content": "", "state": "running", "at": sentAt, "runId": runID])
                let revision = self.nextDraftRevision()
                let attachments = self.attachments
                let commit = try await self.withStorage { store in
                    let hold = attachments.holdReferences(AttachmentStore.references(in: conversation))
                    var committed = false
                    defer { if !committed { attachments.releaseHeldReferences(hold) } }
                    committed = try store.updateDraft(id, revision: revision) { entry in
                        entry["messages"] = next
                        entry["updatedAt"] = LocalChatStore.nowMillis()
                        if title.isEmpty { entry["title"] = ComposerText.localTitle(value, chinese: prepared.chinese) }
                        LocalChatDraft.save(&entry, text: "", editIndex: nil, images: [], documents: [])
                    }
                    return (committed: committed, hold: hold)
                }
                guard commit.committed else { throw CancellationError() }
                guard self.generation == ticket else {
                    let rollback = PreparationRollback(id: id, runID: runID, consumedRevision: revision,
                        draft: DraftSnapshot(text: prepared.draft, editIndex: prepared.editingIndex,
                            images: prepared.images, documents: prepared.documents, revision: self.nextDraftRevision()),
                        previousMessages: stored, attachmentHold: commit.hold)
                    await self.persistPreparationRollback(rollback)
                    return
                }
                self.preparing = false
                self.pendingDrafts.removeValue(forKey: id)
                self.messages = self.read(id)
                self.editingIndex = nil
                self.draft = ""
                self.images = []
                self.documents = []
                self.imagePreviews = [:]
                self.liveText = ""
                self.activeRun = ActiveRun(conversationId: id, text: "", process: [])
                if built.omittedHistoryTurns > 0 {
                    self.contextSummary = prepared.chinese
                        ? "本次使用最近 \(built.includedHistoryTurns) 轮历史，较早记录已省略（本地记录保留）。"
                        : "Using the latest \(built.includedHistoryTurns) history turns; earlier records remain saved locally."
                }
                self.reloadList()
                self.run(route: prepared.route, payload: built.payload, useTools: useTools, id: id)
                _ = try? await self.withStorage { _ in attachments.releaseHeldReferences(commit.hold) }
            } catch {
                guard let self else { return }
                guard self.generation == ticket else { self.endCancelledPreparation(id); return }
                self.requestBuildTask = nil
                self.preparing = false
                self.running = false
                self.runningConversationId = nil
                if !(error is CancellationError) { self.notice = Notice(text: Self.describe(error), serious: false) }
            }
        }
    }

    private func cancelRequestPreparation() {
        guard preparing else { return }
        generation += 1
        requestBuildTask?.cancel()
    }

    private func endCancelledPreparation(_ id: String) {
        guard preparing, runningConversationId == id else { return }
        requestBuildTask = nil
        preparing = false
        running = false
        runningConversationId = nil
    }

    /// A failed rollback remains a save operation. No provider request starts,
    /// and another send cannot consume its input until recovery commits.
    private func persistPreparationRollback(_ rollback: PreparationRollback) async {
        let attachments = self.attachments
        do {
            try await withStorage { store in
                try store.rollbackPreparedSend(rollback.id, runID: rollback.runID,
                    consumedRevision: rollback.consumedRevision, restoredRevision: rollback.draft.revision,
                    previousMessages: rollback.previousMessages) { entry in
                        LocalChatDraft.save(&entry, text: rollback.draft.text, editIndex: rollback.draft.editIndex,
                                            images: rollback.draft.images, documents: rollback.draft.documents)
                    }
                attachments.releaseHeldReferences(rollback.attachmentHold)
            }
            pendingPreparationRollback = nil
            needsSaveRetry = false
            endCancelledPreparation(rollback.id)
        } catch {
            pendingPreparationRollback = rollback
            needsSaveRetry = true
            notice = Notice(text: Self.describe(error), serious: true)
        }
    }

    private func retryPreparationRollback() {
        guard let rollback = pendingPreparationRollback, preparationRollbackTask == nil else { return }
        preparationRollbackTask = Task { [weak self] in
            guard let self else { return }
            await self.persistPreparationRollback(rollback)
            self.preparationRollbackTask = nil
        }
    }

    // MARK: - Location consent

    /// Whether the message waiting on the sheet is still the one on screen.
    ///
    /// The sheet takes time and the person can keep typing or attach something
    /// while it is up. Android re-checks the composer, the conversation and the
    /// chosen route before sending; this is that guard.
    private func isStillCurrent(_ prepared: PreparedSend) -> Bool {
        openId == prepared.conversationId
            && draft == prepared.draft
            && images == prepared.images
            && (documents as NSArray).isEqual(to: prepared.documents)
            && editingIndex == prepared.editingIndex
            && selectedRoute() == prepared.route
    }

    /// Who the location would be going to: the route, and the host it calls.
    ///
    /// Named as a pair because that is what the choice is — the provider sees
    /// the request, and the host is where it lands. Android says the same two.
    private func locationDestination(_ route: LocalChatRoute) -> String {
        let host = URL(string: route.baseURL)?.host ?? route.baseURL
        return "\(route.providerName) · \(host)"
    }

    func allowLocation() {
        guard let prepared = pendingSend, var sheet = locationConsent else { return }
        sheet.requesting = true
        locationConsent = sheet
        let id = sheet.id
        location.request { [weak self] note in
            guard let self, self.locationConsent?.id == id else { return }
            self.locationConsent = nil
            self.pendingSend = nil
            guard self.isStillCurrent(prepared) else { return }
            self.perform(prepared, context: note)
        }
    }

    func skipLocation() {
        guard let prepared = pendingSend else { return }
        location.cancel()
        locationConsent = nil
        pendingSend = nil
        guard isStillCurrent(prepared) else { return }
        perform(prepared, context: LocationContext.unavailable)
    }

    func cancelLocation() {
        location.cancel()
        locationConsent = nil
        pendingSend = nil
    }

    /// The sheet closed on its own. A swipe is a cancel, but only while a send
    /// is still waiting.
    func locationDismissed() {
        guard pendingSend != nil else { return }
        cancelLocation()
    }

    func stop() {
        if pendingPreparationRollback != nil { retryPreparationRollback(); return }
        if preparing { cancelRequestPreparation(); return }
        guard let id = runningConversationId else { return }
        if let pendingFinish { finish(pendingFinish.problem, state: pendingFinish.state, id: id); return }
        finish("已停止，部分回复已保留。", state: "stopped", id: id)
    }

    /// Ends the provider request when local chat itself is left or the app is
    /// backgrounded. Android deliberately does not keep a direct API request
    /// alive off-screen; the partial response is checkpointed and never
    /// resent without an explicit user action.
    func pauseForLeavingApp() {
        if saveGrant == .invalid {
            let token = UUID()
            saveGrantToken = token
            saveGrant = UIApplication.shared.beginBackgroundTask(withName: "camellia.localchat.save") { [weak self] in
                Task { @MainActor in self?.endSaveGrant(token: token) }
            }
        }
        saveFlushRevision += 1
        let flushRevision = saveFlushRevision
        let grantToken = saveGrantToken
        cancelRequestPreparation()
        cancelLocation()
        retryPreparationRollback()
        let draftFlush = stashDraft()
        if !preparing, let id = runningConversationId {
            if let pendingFinish { finish(pendingFinish.problem, state: pendingFinish.state, id: id) }
            else { finish("已暂停：离开应用后不继续请求；不会自动重发。", state: "interrupted", id: id) }
        }
        Task { [weak self] in
            guard let self else { return }
            await self.requestCompletionTask?.value
            await self.preparationRollbackTask?.value
            _ = await draftFlush?.value
            _ = await self.attachmentCommitTask?.value
            await self.finishTask?.value
            if self.saveFlushRevision == flushRevision, let grantToken {
                self.endSaveGrant(token: grantToken)
            }
        }
    }

    private func endSaveGrant(token: UUID) {
        guard saveGrant != .invalid, saveGrantToken == token else { return }
        UIApplication.shared.endBackgroundTask(saveGrant)
        saveGrant = .invalid
        saveGrantToken = nil
    }

    func resumePendingSaves() {
        retryPreparationRollback()
        for (id, snapshot) in pendingDrafts {
            if attachmentCommitID == id { continue }
            Task {
                do {
                    _ = try await withStorage { store in
                        try store.updateDraft(id, revision: snapshot.revision) { entry in
                            LocalChatDraft.save(&entry, text: snapshot.text, editIndex: snapshot.editIndex,
                                                images: snapshot.images, documents: snapshot.documents)
                        }
                    }
                    if pendingDrafts[id]?.revision == snapshot.revision { pendingDrafts.removeValue(forKey: id) }
                } catch { notice = Notice(text: Self.describe(error), serious: true) }
            }
        }
        if needsSaveRetry, let id = runningConversationId, let pendingFinish {
            finish(pendingFinish.problem, state: pendingFinish.state, id: id)
        }
    }

    private func run(route: LocalChatRoute, payload: Data, useTools: Bool, id: String) {
        let client = LocalChatClient()
        self.client = client
        generation += 1
        let ticket = generation
        lastCheckpoint = Date().timeIntervalSince1970
        let listener = LocalChatListener(
            onText: { [weak self] text in
                Task { @MainActor in self?.receiveText(text, ticket: ticket, id: id) }
            },
            onThinking: { [weak self] thinking in
                Task { @MainActor in self?.receiveThinking(thinking, ticket: ticket, id: id) }
            },
            onTool: { [weak self] entry in
                Task { @MainActor in self?.receiveTool(entry, ticket: ticket, id: id) }
            })
        Task.detached(priority: .userInitiated) {
            let problem: String?
            do {
                guard let body = try JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
                    throw LocalChatRequestError.invalidAttachment
                }
                if useTools {
                    _ = try await client.chatWithTools(route: route, body: body,
                                                       listener: listener, executor: LocalWebExecutor())
                } else {
                    _ = try await client.chat(route: route, body: body, listener: listener)
                }
                problem = nil
            } catch {
                problem = Self.describe(error)
            }
            await MainActor.run {
                self.finish(problem, state: problem == nil ? "complete" : "interrupted",
                            id: id, ticket: ticket)
            }
        }
    }

    private func receiveText(_ text: String, ticket: Int, id: String) {
        guard ticket == generation, var run = activeRun, run.conversationId == id else { return }
        run.text = text
        activeRun = run
        if openId == id, let index = replyIndex(id) {
            liveText = text
            messages[index].text = text
        }
        let now = Date().timeIntervalSince1970
        if now - lastCheckpoint > 3 {
            lastCheckpoint = now
            scheduleCheckpoint(run)
        }
    }

    private func receiveThinking(_ thinking: String, ticket: Int, id: String) {
        guard ticket == generation, var run = activeRun, run.conversationId == id else { return }
        var process = run.process.filter { $0["type"] as? String != "thinking" }
        if !thinking.isEmpty { process.append(["type": "thinking", "text": thinking]) }
        run.process = process
        activeRun = run
        if openId == id, let index = replyIndex(id) { messages[index].process = process }
    }

    private func receiveTool(_ entry: [String: Any], ticket: Int, id: String) {
        guard ticket == generation, var run = activeRun, run.conversationId == id else { return }
        var process = run.process
        let identifier = entry["id"] as? String ?? ""
        if let position = process.firstIndex(where: { $0["id"] as? String == identifier }) {
            process[position] = entry
        } else {
            process.append(entry)
        }
        run.process = process
        activeRun = run
        if openId == id, let index = replyIndex(id) { messages[index].process = process }
        scheduleCheckpoint(run)
    }

    /// Ends a run, saving whatever the reply reached.
    private func scheduleCheckpoint(_ run: ActiveRun) {
        guard !finishing else { return }
        pendingCheckpoint = run
        guard checkpointTask == nil else { return }
        checkpointTask = Task { [weak self] in
            guard let self else { return }
            while let snapshot = self.pendingCheckpoint, !Task.isCancelled {
                self.pendingCheckpoint = nil
                let saved = await self.persist(snapshot, state: nil, notice: nil)
                guard !Task.isCancelled else { return }
                if !saved {
                    self.checkpointTask = nil
                    self.finish("无法保存回复，已停止请求。", state: "interrupted", id: snapshot.conversationId)
                    return
                }
            }
            self.checkpointTask = nil
        }
    }

    private func finish(_ problem: String?, state: String, id: String, ticket: Int? = nil) {
        if let ticket, ticket != generation { return }
        guard !finishing, var run = activeRun, run.conversationId == id else { return }
        generation += 1
        client?.cancel()
        client = nil
        checkpointTask?.cancel()
        checkpointTask = nil
        pendingCheckpoint = nil
        for index in run.process.indices where run.process[index]["status"] as? String == "running" {
            run.process[index]["status"] = "cancelled"
        }
        activeRun = run
        finishing = true
        pendingFinish = (problem, state)
        finishTask = Task { [weak self] in
            guard let self else { return }
            let saved = await self.persist(run, state: state, notice: problem)
            self.finishing = false
            self.needsSaveRetry = !saved
            if saved {
                self.pendingFinish = nil
                self.activeRun = nil
                self.running = false
                self.runningConversationId = nil
                if self.openId == id {
                    self.messages = self.read(id)
                    self.liveText = self.messages.last?.text ?? ""
                }
                self.reloadList()
                if let problem { self.notice = Notice(text: problem, serious: false) }
            } else {
                self.notice = Notice(text: "回复尚未成功保存，请保持应用打开并重试。", serious: true)
            }
        }
    }

    /// Checkpoints the response independently of the visible screen.
    ///
    /// The assistant row is appended before the request starts and no other
    /// send can begin while it is running, so the last row is its stable slot.
    @discardableResult
    private func persist(_ run: ActiveRun, state: String?, notice: String?) async -> Bool {
        do {
            try await withStorage { store in
                try store.update(run.conversationId) { entry in
                    var turns = (entry["messages"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
                    guard let index = turns.indices.last,
                          turns[index]["role"] as? String == "assistant" else { return }
                    turns[index]["content"] = run.text
                    if !run.process.isEmpty { turns[index]["process"] = run.process }
                    if let state { turns[index]["state"] = state }
                    if let notice { turns[index]["notice"] = notice }
                    entry["messages"] = turns
                    entry["updatedAt"] = LocalChatStore.nowMillis()
                }
            }
            return true
        } catch {
            return false
        }
    }

    /// The turn a run is writing into: the last one, if it is the running reply.
    private func replyIndex(_ id: String) -> Int? {
        guard id == openId, let last = messages.indices.last else { return nil }
        return messages[last].role == "assistant" ? last : nil
    }

    // MARK: - Configuration

    var providers: [LocalProviderDefinition] {
        guard let entries = store.config()["providers"] as? [Any] else { return [] }
        return entries.enumerated().compactMap { _, value in
            guard let raw = value as? [String: Any],
                  let id = raw["id"] as? String, !id.isEmpty else { return nil }
            let keys = ((raw["keys"] as? [Any]) ?? []).enumerated().compactMap { index, value -> LocalProviderDefinition.Key? in
                guard let key = value as? [String: Any], let secret = key["key"] as? String else { return nil }
                return LocalProviderDefinition.Key(
                    id: (key["id"] as? String) ?? "\(id)-key-\(index)",
                    secret: secret,
                    enabled: JSONObject.androidBoolean(key["enabled"], fallback: true))
            }
            let models = ((raw["models"] as? [Any]) ?? []).compactMap { value -> LocalProviderDefinition.Model? in
                guard let model = value as? [String: Any],
                      let modelID = model["id"] as? String,
                      let upstream = model["upstream"] as? String else { return nil }
                return LocalProviderDefinition.Model(id: modelID, upstream: upstream,
                                                     wireProtocol: (model["protocol"] as? String) ?? "auto")
            }
            return LocalProviderDefinition(
                id: id,
                name: (raw["name"] as? String) ?? id,
                baseURL: (raw["baseUrl"] as? String) ?? "https://",
                anthropicBaseURL: (raw["anthropicBaseUrl"] as? String) ?? "",
                protocolName: (raw["protocol"] as? String) ?? "openai",
                enabled: JSONObject.androidBoolean(raw["enabled"], fallback: true),
                keys: keys,
                models: models)
        }
    }

    /// Adds or replaces one provider, preserving fields written by a newer
    /// desktop build that this editor does not know about.
    @discardableResult
    func saveProvider(_ value: LocalProviderDefinition) async -> String? {
        do {
            let draft: [String: Any] = [
                "id": value.id,
                "name": value.name,
                "baseUrl": value.baseURL,
                "anthropicBaseUrl": value.anthropicBaseURL,
                "protocol": value.protocolName,
                "enabled": value.enabled,
                "keys": value.keys.map { key in
                    ["id": key.id.isEmpty ? UUID().uuidString.lowercased() : key.id,
                     "key": key.secret,
                     "enabled": key.enabled] as [String: Any]
                },
                "models": value.models.map { model in
                    ["id": model.id,
                     "upstream": model.upstream,
                     "protocol": model.wireProtocol] as [String: Any]
                },
            ]
            try await withStorage { store in
                let config = try LocalProviderEditor.upsert(draft, in: store.config())
                try store.importConfig(config)
            }
            try reloadRoutes()
            return nil
        } catch {
            return Self.describe(error)
        }
    }

    func setProvider(_ id: String, enabled: Bool) {
        Task {
            do {
                try await withStorage { store in
                    let config = try LocalProviderEditor.setEnabled(enabled, providerID: id, in: store.config())
                    try store.importConfig(config)
                }
                try reloadRoutes()
            } catch {
                notice = Notice(text: Self.describe(error), serious: true)
            }
        }
    }

    func removeProvider(_ id: String) {
        Task {
            do {
                try await withStorage { store in
                    let config = try LocalProviderEditor.remove(providerID: id, from: store.config())
                    try store.importConfig(config)
                }
                try reloadRoutes()
            } catch {
                notice = Notice(text: Self.describe(error), serious: true)
            }
        }
    }

    /// Returns an in-sheet validation error; successful imports still publish a notice.
    func importConfig(_ text: String) async -> String? {
        do {
            try await withStorage { store in
                let config = try LocalChatConfiguration.parse(text)
                try store.importConfig(config)
            }
            try reloadRoutes()
            notice = Notice(text: "已导入 \(routes.count) 个可用模型。", serious: false)
            return nil
        } catch {
            return Self.describe(error)
        }
    }

    /// Adopts the configuration the desktop answers `/v1/api-keys` with.
    ///
    /// The gateway serves the same `camellia-api-routes` v2 document the user
    /// would otherwise paste, so it goes through the identical validator: the
    /// only thing this adds over `importConfig` is that the object arrived as
    /// JSON already rather than as text on the clipboard.
    func importRemoteConfig(_ raw: [String: Any]) {
        Task {
            do {
                try await withStorage { store in
                    let data = try JSONSerialization.data(withJSONObject: raw)
                    let text = String(decoding: data, as: UTF8.self)
                    let config = try LocalChatConfiguration.parse(text)
                    try store.importConfig(config)
                }
                try reloadRoutes()
                notice = Notice(text: "已从电脑导入 \(routes.count) 个可用模型。", serious: false)
            } catch {
                notice = Notice(text: Self.describe(error), serious: true)
            }
        }
    }

    func exportConfig() async -> String? {
        do {
            return try await withStorage { try LocalChatConfiguration.export($0.config()) }
        } catch {
            notice = Notice(text: Self.describe(error), serious: true)
            return nil
        }
    }

    func clearConfig() {
        Task {
            do {
                try await withStorage { try $0.importConfig([:]) }
                try reloadRoutes()
            } catch {
                notice = Notice(text: Self.describe(error), serious: true)
            }
        }
    }

    // MARK: - Helpers

    private func attachmentsFor(images: [String], documents: [[String: Any]]) -> [RemoteAttachment] {
        var list: [RemoteAttachment] = []
        for (index, reference) in images.enumerated() {
            list.append(RemoteAttachment(name: "mobile-image-\(index + 1).jpg", data: reference, isImage: true))
        }
        for document in documents {
            list.append(RemoteAttachment(name: document["name"] as? String ?? "document",
                                         data: document["data"] as? String ?? "", isImage: false))
        }
        return list
    }

    private func sizes(_ list: [RemoteAttachment]) throws -> [String: Int64] {
        var result: [String: Int64] = [:]
        for attachment in list {
            result[attachment.data] = try attachments.size(attachment.data)
        }
        return result
    }

    nonisolated static func describe(_ error: Error) -> String {
        if let chat = error as? LocalChatError { return chat.description }
        if let transport = error as? LocalChatTransportError {
            // The core error is bilingual for host-side checks. A notice in a
            // SwiftUI screen is localized by its key, like other app copy.
            switch transport {
            case .notHTTP: return "服务商返回了非 HTTP 响应"
            case .unavailable: return "无法连接到服务商"
            }
        }
        if let tool = error as? LocalToolError { return tool.description }
        if let http = error as? LocalChatHTTPError { return http.description }
        if let web = error as? LocalWebError { return web.description }
        if let store = error as? LocalChatStoreError { return store.description }
        if let config = error as? LocalChatConfigError { return config.description }
        if let provider = error as? LocalProviderEditError { return provider.description }
        if let document = error as? LocalChatDocumentError { return document.description }
        return error.localizedDescription
    }
}
