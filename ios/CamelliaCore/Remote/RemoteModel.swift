import Foundation

/// The shapes the desktop gateway sends back.
///
/// Ported from the Android client, field for field. These are read with
/// `JSONObject` rather than `Codable` so that a desktop which adds a field, or
/// sends one as a string instead of a number, does not turn an entire snapshot
/// into a decode failure — see `JSONObject` for why that matters here.
///
/// One naming note: `updatedAt` and friends are epoch milliseconds on the wire
/// and are kept as `Int64` rather than being converted to `Date`. The transcript
/// compares them against each other far more often than it shows them, and
/// comparing integers is what the Android code does.

// MARK: - Enumerations

/// What a paired device is allowed to do.
public enum RemotePermission: String, Sendable {
    case control
    case read

    public var canDrive: Bool { self == .control }
}

/// Gateway capabilities. Presence gates UI rather than gating requests: the
/// desktop is the authority and refuses what it does not support.
public struct RemoteCapabilities: OptionSet, Sendable {
    public let rawValue: Int

    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let create = Self(rawValue: 1 << 0)
    public static let createWorkspace = Self(rawValue: 1 << 1)
    public static let move = Self(rawValue: 1 << 2)
    public static let archive = Self(rawValue: 1 << 3)
    public static let conversationActions = Self(rawValue: 1 << 4)
    public static let image = Self(rawValue: 1 << 5)
    public static let multiImage = Self(rawValue: 1 << 6)
    public static let attachments = Self(rawValue: 1 << 7)
    public static let expandedAttachments = Self(rawValue: 1 << 8)
    public static let fork = Self(rawValue: 1 << 9)

    /// The five that additionally require `permission == "control"`.
    ///
    /// `conversation-actions` belongs here as much as the other four: Android
    /// gates it on control in the same breath, and leaving it out would offer
    /// rename, pin and delete to a device the desktop only lets read.
    public static let needsControl: Self = [.create, .createWorkspace, .move, .archive, .conversationActions, .fork]

    public init(_ names: [String]) {
        var value = Self()
        for name in names {
            switch name {
            case "create": value.insert(.create)
            case "fork": value.insert(.fork)
            case "create-workspace": value.insert(.createWorkspace)
            case "move": value.insert(.move)
            case "archive": value.insert(.archive)
            case "conversation-actions": value.insert(.conversationActions)
            case "image": value.insert(.image)
            case "multi-image": value.insert(.multiImage)
            case "attachments": value.insert(.attachments)
            case "expanded-attachments": value.insert(.expandedAttachments)
            default: break
            }
        }
        self = value
    }

    /// Whether the capability is usable, given the device's permission.
    public func allows(_ capability: Self, permission: RemotePermission) -> Bool {
        guard contains(capability) else { return false }
        if capability.isSubset(of: Self.needsControl) { return permission.canDrive }
        return true
    }
}

/// What this device is allowed to do on one computer.
///
/// The desktop is still the authority and refuses what it does not support;
/// this only decides what is worth offering. Kept as one value rather than a
/// dozen booleans because the two inputs always travel together and a screen
/// that reads one without the other is what makes a button appear and then fail.
public struct RemoteAccess: Sendable {
    public let permission: RemotePermission
    public let capabilities: RemoteCapabilities

    public init(permission: RemotePermission, capabilities: RemoteCapabilities) {
        self.permission = permission
        self.capabilities = capabilities
    }

    public init(_ json: JSONObject) {
        permission = RemotePermission(rawValue: json.text("permission")) ?? .read
        capabilities = RemoteCapabilities(json.strings("capabilities"))
    }

    /// Nothing beyond reading: what a device is given before it is trusted.
    public static let readOnly = RemoteAccess(permission: .read, capabilities: [])

    public var canDrive: Bool { permission.canDrive }
    public var canCreate: Bool { capabilities.allows(.create, permission: permission) }
    public var canCreateWorkspace: Bool { capabilities.allows(.createWorkspace, permission: permission) }
    public var canMove: Bool { capabilities.allows(.move, permission: permission) }
    public var canArchive: Bool { capabilities.allows(.archive, permission: permission) }
    public var canManageConversations: Bool { capabilities.allows(.conversationActions, permission: permission) }

    /// Attachments are not gated on control: Android offers them on a read-only
    /// pairing too, and the desktop is what refuses an unaccepted upload.
    public var canAttachImages: Bool { capabilities.contains(.image) }
    public var canAttachFiles: Bool { capabilities.contains(.attachments) || capabilities.contains(.expandedAttachments) }

    /// Whether the desktop advertises the expanded attachment limits, which is
    /// what decides between twenty attachments and the legacy nine.
    public var usesExpandedAttachments: Bool { capabilities.contains(.expandedAttachments) }
    /// Whether more than one image may travel in one message.
    public var allowsMultipleImages: Bool { capabilities.contains(.multiImage) }

    /// How many attachments one message may carry on this computer.
    ///
    /// The three-tier count lives in `AttachmentRules` so the phone and the
    /// desktop agree; this only feeds it the two facts it needs.
    public var attachmentCount: Int {
        AttachmentRules.remoteCount(expanded: usesExpandedAttachments,
                                    files: canAttachFiles,
                                    multiImage: allowsMultipleImages)
    }

    /// Whether the composer should offer an attach button at all.
    public var canAttach: Bool { canAttachImages || canAttachFiles }

    /// How many images one message may carry.
    public var imageLimit: Int { capabilities.contains(.multiImage) ? 8 : 1 }
}

/// Agents the desktop can drive. The list arrives over the wire; these are the
/// ones the client knows how to label.
public enum RemoteEngine: String, Sendable, CaseIterable {
    case codex
    case claude
    case kimi
    case dsh
    case antigravity
    case pi

    /// Used when the desktop advertises nothing.
    public static let fallback: [RemoteEngine] = [.codex, .claude, .kimi, .dsh, .antigravity]

    public var label: String {
        self == .pi ? "Pi" : rawValue.uppercased()
    }

    /// The engines to offer for a new conversation.
    ///
    /// `advertised` is the desktop's own list, or nil when it said nothing at
    /// all. A desktop that says nothing keeps the five engines Android has
    /// always offered (`fallback`); one that does advertise is taken at its word
    /// — filtered to the names this client can label, in the desktop's order,
    /// without repeats. This is Android's `RemoteEngines.available`, including
    /// the difference between "said nothing" (nil) and "advertised nothing"
    /// (an empty list, which offers no engine at all).
    public static func available(advertised: [String]?) -> [RemoteEngine] {
        guard let advertised else { return fallback }
        var result: [RemoteEngine] = []
        for name in advertised {
            guard let engine = RemoteEngine(rawValue: name), !result.contains(engine) else { continue }
            result.append(engine)
        }
        return result
    }
}

// MARK: - Status

public struct RemoteStatus: Sendable {
    public let permission: RemotePermission
    public let capabilities: [String]
    /// The engines the desktop advertises, or nil when it said nothing — the
    /// same nil-vs-empty distinction `RemoteListPage` keeps.
    public let engines: [String]?
    public let instanceId: String
    public let includeUnassigned: Bool
    public let workspaces: [RemoteWorkspace]
    public let computerName: String

    public init(_ json: JSONObject) {
        permission = RemotePermission(rawValue: json.text("permission")) ?? .read
        capabilities = json.strings("capabilities")
        engines = json.has("engines") ? json.strings("engines") : nil
        instanceId = json.text("instanceId")
        includeUnassigned = json.bool("includeUnassigned")
        workspaces = json.objects("workspaces").map(RemoteWorkspace.init)
        computerName = json.text("computerName")
    }

    /// The engines to offer when creating a conversation on this computer.
    public var availableEngines: [RemoteEngine] { RemoteEngine.available(advertised: engines) }

    /// What this device may do here, assembled from the two fields the desktop
    /// always sends together.
    public var access: RemoteAccess {
        RemoteAccess(permission: permission, capabilities: RemoteCapabilities(capabilities))
    }

    /// Protocol 1 is the only one this client speaks. Android refuses anything
    /// else with "Unsupported protocol", and so does this.
    public static func protocolVersion(of json: JSONObject) -> Int {
        json.int("protocol", fallback: 1)
    }
}

public struct RemoteWorkspace: Sendable, Identifiable, Hashable {
    public let id: String
    public let name: String

    public init(_ json: JSONObject) {
        id = json.text("id")
        name = json.text("name")
    }

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }

    /// The shape it was read from, so the list cache can write a workspace out
    /// and read it back through `init(_:)`.
    public var json: [String: Any] { ["id": id, "name": name] }
}

// MARK: - Conversations

/// Whether a conversation is doing something right now.
public enum ConversationActivity: String, Sendable {
    case running
    case permission
    case question

    public static func of(_ json: JSONObject) -> ConversationActivity? {
        guard let text = json.string("activity") else { return nil }
        return ConversationActivity(rawValue: text)
    }
}

public struct RemoteConversation: Sendable, Identifiable, Hashable {
    public let id: String
    public let title: String
    /// Session-level version. `send` and `archive` echo it back so the desktop
    /// can reject a stale client.
    public let seq: Int64
    public let activity: ConversationActivity?
    public let pinned: Bool
    public let workspaceId: String?
    /// Nil when the row omitted it; an explicit empty name must not be
    /// replaced with a later row's name or a stale workspace-list name.
    public let workspaceName: String?
    public let lastReplyAt: Int64
    public let replyReadAt: Int64
    public let updatedAt: Int64

    public init(_ json: JSONObject) {
        id = json.text("id")
        title = json.text("title")
        seq = json.long("seq")
        activity = ConversationActivity.of(json)
        pinned = json.bool("pinned")
        workspaceId = json.string("workspaceId")
        workspaceName = json.isNull("workspaceName") ? nil : json.text("workspaceName")
        lastReplyAt = json.long("lastReplyAt")
        replyReadAt = json.long("replyReadAt")
        updatedAt = json.long("updatedAt")
    }

    public var isIdle: Bool { activity == nil }

    /// A version signature for the prefetch cache.
    public var signature: String { "\(seq):\(updatedAt):\(activity?.rawValue ?? "")" }

    /// The shape it was read from, so the list cache can store a row and read
    /// it back through `init(_:)`.
    ///
    /// Only the fields this client models. A desktop that sends more than the
    /// phone understands loses nothing the phone could have drawn, and an
    /// absent `workspaceId` stays absent rather than becoming an empty string
    /// that would put the row in the wrong group.
    public var json: [String: Any] {
        var value: [String: Any] = [
            "id": id,
            "title": title,
            "seq": seq,
            "pinned": pinned,
            "lastReplyAt": lastReplyAt,
            "replyReadAt": replyReadAt,
            "updatedAt": updatedAt,
        ]
        if let activity { value["activity"] = activity.rawValue }
        if let workspaceId { value["workspaceId"] = workspaceId }
        if let workspaceName { value["workspaceName"] = workspaceName }
        return value
    }
}

// MARK: - Messages

public enum MessageRole: String, Sendable {
    case user
    case assistant
    case tool

    /// Anything else is rendered as a note rather than a bubble.
    case note

    public init(_ text: String) {
        self = Self(rawValue: text) ?? .note
    }
}

/// One step of an assistant turn: a tool call or its reasoning.
public struct RemoteProcessEntry: Sendable, Identifiable, Hashable {
    public let id: String
    public let type: String
    public let title: String
    public let status: String
    public let input: String
    public let text: String
    public let truncated: Bool

    public init(_ json: JSONObject) {
        // The desktop's process entries carry no identity of their own, but the
        // UI needs a stable one to animate updates instead of rebuilding rows.
        // Type plus title is what the Android client keys on in practice.
        let kind = json.text("type")
        let heading = json.text("title")
        id = "\(kind):\(heading)"
        type = kind
        title = heading
        status = json.text("status")
        input = json.text("input")
        text = json.text("text")
        truncated = json.bool("truncated")
    }

    public init(type: String, title: String, status: String, input: String = "", text: String = "", truncated: Bool = false) {
        self.type = type
        self.title = title
        self.status = status
        self.input = input
        self.text = text
        self.truncated = truncated
        id = "\(type):\(title)"
    }

    public var isThinking: Bool { type == "thinking" }
}

public struct RemoteMessage: Sendable, Identifiable, Hashable {
    /// `seq` is the primary key, not `id`: the desktop re-emits an edited
    /// message under a higher seq rather than editing it in place, so a
    /// transcript keyed on anything else would show both copies.
    public let seq: Int64
    public let role: MessageRole
    public let text: String
    public let textTruncated: Bool
    public let at: Int64
    public let process: [RemoteProcessEntry]

    public init(_ json: JSONObject) {
        seq = json.long("seq")
        role = MessageRole(json.text("role"))
        text = json.text("text")
        textTruncated = json.bool("textTruncated")
        at = json.long("at")
        process = json.objects("process").map(RemoteProcessEntry.init)
    }

    public init(seq: Int64, role: MessageRole, text: String, at: Int64, process: [RemoteProcessEntry] = [], truncated: Bool = false) {
        self.seq = seq
        self.role = role
        self.text = text
        self.at = at
        self.process = process
        textTruncated = truncated
    }

    public var id: Int64 { seq }
}

// MARK: - Live reply

public struct RemoteApproval: Sendable, Identifiable, Hashable {
    public let requestId: String
    /// Guards against replaying an approval against a different run.
    public let fingerprint: String
    public let toolName: String
    public let details: String
    /// False for questions and over-long prompts: the phone shows them but
    /// cannot answer them, so the user has to go back to the desktop.
    public let actionable: Bool

    public init(_ json: JSONObject) {
        requestId = json.text("requestId")
        fingerprint = json.text("fingerprint")
        toolName = json.text("toolName")
        details = json.text("details")
        actionable = json.bool("actionable")
    }

    public var id: String { requestId }

    /// The `approve` payload the desktop expects.
    ///
    /// `allow` is a required boolean on the wire, and the desktop refuses the
    /// whole command before it even looks for the request when it is missing or
    /// not a boolean (`src/main/remote/commands.js`: "Approval changed or needs
    /// desktop input"). Building the payload here rather than in the screen
    /// keeps that rule where the protocol checks can reach it, because the
    /// failure it used to cause — a phone that could not approve anything, and
    /// was told the approval had moved — looked exactly like a stale
    /// fingerprint and gave no hint that a field was simply absent.
    public func answer(instanceId: String, runId: Int64, allow: Bool) -> [String: Any] {
        ["instanceId": instanceId,
         "runId": runId,
         "approvalId": requestId,
         "fingerprint": fingerprint,
         "allow": allow]
    }
}

public struct RemoteLive: Sendable {
    /// Identifies the run that `stop` and `approve` target.
    public let runId: Int64
    public let text: String
    public let textTruncated: Bool
    public let startedAt: Int64
    public let userSeq: Int64
    public let process: [RemoteProcessEntry]
    public let pendingApprovals: Int
    public let approvals: [RemoteApproval]

    public init(_ json: JSONObject) {
        runId = json.long("runId")
        text = json.text("text")
        textTruncated = json.bool("textTruncated")
        startedAt = json.long("startedAt")
        userSeq = json.long("userSeq")
        process = json.objects("process").map(RemoteProcessEntry.init)
        pendingApprovals = json.int("pendingApprovals")
        approvals = json.objects("approvals").map(RemoteApproval.init)
    }

    /// Android shows every request, including questions and oversized prompts,
    /// to a control device. A read-only device sees no individual requests.
    public func visibleApprovals(canControl: Bool) -> [RemoteApproval] {
        canControl ? approvals : []
    }

    /// Read-only devices get one generic notice for pending requests; control
    /// devices see the request details and any desktop-only explanations.
    public func showsDesktopApprovalNotice(canControl: Bool) -> Bool {
        !canControl && pendingApprovals > 0
    }
}

// MARK: - Settings

public struct RemoteModelChoice: Sendable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let connection: String
    public let thinking: [String]

    public init(_ json: JSONObject) {
        id = json.text("id")
        name = json.text("name", fallback: id)
        connection = json.text("connection", fallback: "api")
        thinking = json.strings("thinking")
    }

    public init(id: String, name: String, connection: String, thinking: [String] = []) {
        self.id = id
        self.name = name
        self.connection = connection
        self.thinking = thinking
    }

    public var isSubscription: Bool { connection == "subscription" }
}

public struct RemoteSettings: Sendable, Equatable {
    /// Optimistic-lock token; `configure` echoes it back as `expectedSettings`.
    public let version: String
    public let editable: Bool
    public let model: String
    /// Empty means "whatever the engine defaults to".
    public let thinking: String
    public let permissionMode: String
    public let models: [RemoteModelChoice]

    public init(_ json: JSONObject) {
        version = json.text("version")
        editable = json.bool("editable")
        model = json.text("model")
        thinking = json.text("thinking")
        permissionMode = json.text("permissionMode")
        models = json.objects("models").map(RemoteModelChoice.init)
    }

    public static let empty = RemoteSettings(JSONObject())

    public var permissionModes: [String] { ["ask", "auto", "full"] }
}

// MARK: - Automation

public struct RemoteGoal: Sendable, Identifiable, Equatable {
    public let id: String
    public let objective: String
    public let phase: String
    public let armed: Bool
    public let completedAt: Int64
    public let roundsStarted: Int

    public init(_ json: JSONObject) {
        id = json.text("id")
        objective = json.text("objective")
        phase = json.text("phase")
        armed = json.bool("armed")
        completedAt = json.long("completedAt")
        roundsStarted = json.int("roundsStarted")
    }

    public var isComplete: Bool { phase == "complete" }
    public var isBlocked: Bool { phase == "blocked" }
    /// Whether the desktop is actively working towards it. Armed and active
    /// together, because an unarmed active goal is one a person paused.
    public var isRunning: Bool { phase == "active" && armed }
}

public struct RemoteTask: Sendable, Identifiable, Equatable {
    public let id: String
    public let instruction: String
    public let status: String
    public let intervalMinutes: Int

    public init(_ json: JSONObject) {
        id = json.text("id")
        instruction = json.text("instruction")
        status = json.text("status")
        intervalMinutes = json.int("intervalMinutes")
    }

    public var isPaused: Bool { status == "paused" }
    public var isRunning: Bool { status == "running" }
}

public struct RemoteQueueEntry: Sendable, Identifiable, Equatable {
    public let id: String
    public let text: String
    public let state: String
    public let error: String
    /// How many files travel with this message.
    ///
    /// Only the count: the queue view names the files but the phone has nothing
    /// to do with them until the message starts, and a full name list per row
    /// would be the tallest thing on a screen that exists to be scanned.
    public let attachmentCount: Int

    public init(_ json: JSONObject) {
        id = json.text("id")
        text = json.text("text")
        state = json.text("state")
        error = json.text("error")
        attachmentCount = json.objects("attachments").count
    }

    public var isStarting: Bool { state == "starting" }
    public var isPaused: Bool { state == "paused" }
    public var isFailed: Bool { state == "failed" }
}

public struct RemoteAutomation: Sendable, Equatable {
    public let goal: RemoteGoal?
    public let tasks: [RemoteTask]

    public init(_ json: JSONObject) {
        goal = json.object("goal").map(RemoteGoal.init)
        tasks = json.objects("tasks").map(RemoteTask.init)
    }
}

// MARK: - Artifacts

public struct RemoteArtifact: Sendable, Identifiable, Hashable {
    public let id: String
    public let name: String
    public let size: Int64
    public let ext: String

    public init(_ json: JSONObject) {
        id = json.text("id")
        name = json.text("name")
        size = json.long("size")
        ext = json.text("extension")
    }

    public init(id: String, name: String, size: Int64, ext: String) {
        self.id = id
        self.name = name
        self.size = size
        self.ext = ext
    }

    public var kind: ArtifactKind { ArtifactReferences.kind(of: name) }
}

/// A page of a conversation's files.
public struct RemoteArtifactPage: Sendable {
    public let items: [RemoteArtifact]
    /// Negative means the last page.
    public let nextOffset: Int64

    public init(_ json: JSONObject) {
        items = json.objects("artifacts").map(RemoteArtifact.init)
        nextOffset = json.long("nextOffset", fallback: -1)
    }

    public var isLast: Bool { nextOffset < 0 }
}

// MARK: - Snapshots

/// A conversation snapshot: the whole visible state of one session.
///
/// When `messages` is present, this is a replacement, not a delta. Everything
/// at or after its first message is authoritative and older cached rows only
/// survive if the desktop says there is more history behind them. A missing
/// messages array does not replace the visible transcript; Android makes the
/// same distinction in `MainActivity.applySnapshot`.
public struct RemoteSnapshot: Sendable {
    public let subagents: [RemoteSubtask]?
    public let conversation: RemoteConversation?
    /// The device's current permission, carried on every detail snapshot.
    public let permission: RemotePermission?
    /// Android only replaces rendered history when `messages` is an
    /// array. Missing, null and wrong-typed fields are not empty pages.
    public let hasMessages: Bool
    public let messages: [RemoteMessage]
    public let live: RemoteLive?
    public let hasLive: Bool
    public let settings: RemoteSettings?
    public let automation: RemoteAutomation?
    public let hasAutomation: Bool
    public let queue: [RemoteQueueEntry]
    public let queueVersion: Int64
    /// Whether this desktop understands queued sends at all.
    ///
    /// Read from the *presence* of the field rather than its contents: a
    /// desktop that predates the message queue sends no `queue` key, and the
    /// phone must then neither show a queue nor ask for a send to be queued —
    /// the desktop would refuse `queue: true` as an unknown option. Android
    /// makes the same test with `snapshot.has("queue")`.
    public let canQueue: Bool
    /// Milliseconds; nil means there is no older page.
    public let nextBefore: Int64?
    public let instanceId: String
    public let cursor: Int64

    /// Whether the desktop still holds messages older than this page.
    ///
    /// Deliberately optimistic, and deliberately not just `nextBefore != nil`:
    /// Android reads it as `!has("nextBefore") || !isNull("nextBefore")`, so a
    /// desktop that never mentions paging counts as having earlier pages. That
    /// direction matters, because this flag decides whether cached rows behind
    /// the page are deleted — assuming "no older history" when the desktop only
    /// failed to say either way would drop rows the user could still scroll to,
    /// which shows up as missing messages rather than as an error. Only an
    /// explicit null means "this really is the start".
    public let olderAvailable: Bool

    public init(_ json: JSONObject) {
        olderAvailable = !json.has("nextBefore") || !json.isNull("nextBefore")
        subagents = json.has("subagents") ? json.objects("subagents").map(RemoteSubtask.init) : nil
        conversation = json.object("conversation").map(RemoteConversation.init)
        permission = RemotePermission(rawValue: json.text("permission"))
        hasMessages = json.raw["messages"] is [Any]
        messages = json.objects("messages").map(RemoteMessage.init)
        live = json.object("live").map(RemoteLive.init)
        hasLive = json.has("live")
        settings = json.object("settings").map(RemoteSettings.init)
        automation = json.object("automation").map(RemoteAutomation.init)
        hasAutomation = json.has("automation")
        queue = json.objects("queue").map(RemoteQueueEntry.init)
        queueVersion = json.long("queueVersion", fallback: -1)
        canQueue = json.has("queue")
        // Like Android's `isNull("nextBefore")`, absent and explicit null both
        // mean there is no paging cursor. `olderAvailable` above separately
        // keeps that distinction for history replacement.
        nextBefore = json.isNull("nextBefore") ? nil : json.long("nextBefore")
        instanceId = json.text("instanceId")
        cursor = json.long("cursor", fallback: -1)
    }
}

/// A page of the conversation list.
public struct RemoteListPage: Sendable {
    public let conversations: [RemoteConversation]
    /// Negative means the last page.
    public let nextOffset: Int64
    public let cursor: Int64
    public let instanceId: String
    public let workspaces: [RemoteWorkspace]
    public let includeUnassigned: Bool
    /// Present only on a desktop that advertises it in the list itself; an
    /// older one is asked separately, which is what Android's `listInfo` does.
    public let access: RemoteAccess?
    /// The engines the desktop advertises, or nil when it said nothing. Kept as
    /// nil-vs-empty because the two mean different things for a new
    /// conversation: silence falls back to the five defaults, an empty list
    /// offers none.
    public let engines: [String]?

    public init(_ json: JSONObject) {
        conversations = json.objects("conversations").map(RemoteConversation.init)
        nextOffset = json.long("nextOffset", fallback: -1)
        cursor = json.long("cursor", fallback: -1)
        instanceId = json.text("instanceId")
        workspaces = json.objects("workspaces").map(RemoteWorkspace.init)
        includeUnassigned = json.bool("includeUnassigned")
        access = json.has("protocol") ? RemoteAccess(json) : nil
        engines = json.has("engines") ? json.strings("engines") : nil
    }

    /// The engines to offer when creating a conversation on this computer.
    public var availableEngines: [RemoteEngine] { RemoteEngine.available(advertised: engines) }

    public var isLast: Bool { nextOffset < 0 }
}

// MARK: - Pairing

public struct PairRequestResult: Sendable {
    public let id: String
    public let claim: String
    public let expiresAt: Int64
    public let computerName: String

    public init(_ json: JSONObject) {
        id = json.text("id")
        claim = json.text("claim")
        expiresAt = json.long("expiresAt")
        computerName = json.text("computerName")
    }
}

/// The answer to a claim poll.
///
/// `permission` is optional on purpose. Android throws if the desktop answers
/// with anything other than `control` or `read`, because a permission the phone
/// does not understand would otherwise be stored and then quietly treated as a
/// known one. Defaulting to `.read` here would hide exactly that case, so the
/// claim keeps what the desktop said and the pairing flow decides.
public struct PairClaimResult: Sendable {
    public let state: String
    public let token: String
    public let permission: RemotePermission?
    public let deviceId: String

    public init(_ json: JSONObject) {
        state = json.text("state")
        token = json.text("token")
        permission = RemotePermission(rawValue: json.text("permission"))
        deviceId = json.text("deviceId")
    }

    public var approved: Bool { state == "approved" }

    /// Whether the answer is one the phone may store.
    ///
    /// Both halves are checked where the token is handed over: a malformed
    /// token would fail every later request as a 401, and an unknown permission
    /// would be stored as one this build understands.
    public var hasUsableCredentials: Bool {
        approved && Credential.isDeviceToken(token) && permission != nil && !deviceId.isEmpty
    }
}

// MARK: - Commands

public struct CommandResult: Sendable {
    public let ok: Bool
    public let state: String
    public let error: String
    public let userSeq: Int64?
    public let conversation: RemoteConversation?
    public let workspace: RemoteWorkspace?

    public init(_ json: JSONObject) {
        ok = json.bool("ok")
        state = json.text("state")
        error = json.text("error")
        userSeq = json.isNull("userSeq") ? nil : json.long("userSeq")
        conversation = json.object("conversation").map(RemoteConversation.init)
        workspace = json.object("workspace").map(RemoteWorkspace.init)
    }
}
