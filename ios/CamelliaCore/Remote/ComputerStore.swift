import Foundation

/// Where the encrypted credentials live.
///
/// A protocol rather than a class because the two things that need it want
/// different backends: the app uses a Keychain key with the ciphertext on disk,
/// and the tests use memory. Everything that decides *what* is stored sits
/// above this line and is checked with the memory backend.
public protocol CredentialVault: AnyObject {
    /// The stored object, or an empty one when nothing has been saved yet.
    func load() throws -> JSONObject
    func save(_ value: JSONObject) throws
    func clear() throws
}

public enum CredentialStoreError: LocalizedError, Equatable, CustomStringConvertible {
    case unreadable
    case notSaved
    case unknownComputer

    public var description: String {
        switch self {
        case .unreadable: return "Stored pairing could not be read"
        case .notSaved: return "Pairing could not be saved"
        case .unknownComputer: return "That computer is not stored on this phone"
        }
    }

    public var errorDescription: String? { description }
}

/// One paired computer, in the shape the desktop and the UI both understand.
///
/// The fields are the ones Android keeps in its credentials object. `token`
/// and `deviceId` arrive together when the desktop approves the pairing;
/// `claim`, `pairingId` and `expiresAt` exist only between the request and the
/// approval, and are what lets the phone pick the pairing back up after a
/// restart instead of asking the desktop for a new code.
public struct PairedComputer: Equatable, Sendable {
    public var address: String
    /// The name this phone submitted, which the desktop shows when authorising.
    public var name: String
    /// The desktop's own display name, which the phone may rename locally.
    public var computerName: String
    public var token: String?
    public var deviceId: String?
    public var permission: RemotePermission?
    /// The claim handle while the pairing waits for approval.
    public var claim: String?
    public var pairingId: String?
    /// Epoch milliseconds; nil means the request never carried one.
    public var expiresAt: Int64?
    /// A conversation creation that was interrupted, so it can be retried.
    public var pendingCreate: JSONObject?
    /// A conversation command whose result was not confirmed yet.
    public var pendingCommand: JSONObject?
    /// Unsent composer text, edit targets and attachment selections, keyed by
    /// conversation id. These live beside the credential because that whole
    /// profile is already sealed at rest, exactly like Android's profile.
    public var drafts: JSONObject?
    public var draftEdits: JSONObject?
    public var draftAttachments: JSONObject?
    /// Fields written by another app version are kept on read-modify-write.
    /// Android edits its raw JSONObject in place, so dropping these on iOS
    /// would make an ordinary draft save a destructive schema migration.
    fileprivate var extraFields = JSONObject()

    private static let knownFields: Set<String> = [
        "address", "name", "computerName", "token", "deviceId", "permission",
        "claim", "id", "expiresAt", "pendingCreate", "pendingCommand",
        "drafts", "draftEdits", "draftAttachments", "computers",
    ]

    public init(
        address: String = "",
        name: String = "",
        computerName: String = "",
        token: String? = nil,
        deviceId: String? = nil,
        permission: RemotePermission? = nil,
        claim: String? = nil,
        pairingId: String? = nil,
        expiresAt: Int64? = nil,
        pendingCreate: JSONObject? = nil,
        pendingCommand: JSONObject? = nil,
        drafts: JSONObject? = nil,
        draftEdits: JSONObject? = nil,
        draftAttachments: JSONObject? = nil
    ) {
        self.address = address
        self.name = name
        self.computerName = computerName
        self.token = token
        self.deviceId = deviceId
        self.permission = permission
        self.claim = claim
        self.pairingId = pairingId
        self.expiresAt = expiresAt
        self.pendingCreate = pendingCreate
        self.pendingCommand = pendingCommand
        self.drafts = drafts
        self.draftEdits = draftEdits
        self.draftAttachments = draftAttachments
    }

    public init(_ json: JSONObject) {
        extraFields = JSONObject(dictionary: json.raw.filter { !Self.knownFields.contains($0.key) })
        address = json.text("address")
        name = json.text("name")
        computerName = json.text("computerName")
        token = json.string("token")
        deviceId = json.string("deviceId")
        permission = json.string("permission").flatMap(RemotePermission.init(rawValue:))
        claim = json.string("claim")
        pairingId = json.string("id")
        expiresAt = json.isNull("expiresAt") ? nil : json.long("expiresAt")
        pendingCreate = json.object("pendingCreate")
        pendingCommand = json.object("pendingCommand")
        drafts = json.object("drafts")
        draftEdits = json.object("draftEdits")
        draftAttachments = json.object("draftAttachments")
    }

    public var json: [String: Any] {
        var fields = extraFields.raw
        fields["address"] = address
        fields["name"] = name
        fields["computerName"] = computerName
        if let token { fields["token"] = token }
        if let deviceId { fields["deviceId"] = deviceId }
        if let permission { fields["permission"] = permission.rawValue }
        if let claim { fields["claim"] = claim }
        if let pairingId { fields["id"] = pairingId }
        if let expiresAt { fields["expiresAt"] = expiresAt }
        if let pendingCreate { fields["pendingCreate"] = pendingCreate.raw }
        if let pendingCommand { fields["pendingCommand"] = pendingCommand.raw }
        if let drafts { fields["drafts"] = drafts.raw }
        if let draftEdits { fields["draftEdits"] = draftEdits.raw }
        if let draftAttachments { fields["draftAttachments"] = draftAttachments.raw }
        return fields
    }

    /// Whether the desktop has issued a token; everything else needs one.
    public var isPaired: Bool { token != nil && deviceId != nil }

    /// Whether the request is in and the desktop has not answered yet.
    public var isAwaitingApproval: Bool { claim != nil && token == nil }

    /// Whether the request has a deadline that has already passed.
    public func isExpired(now: Int64) -> Bool {
        guard let expiresAt else { return false }
        return now >= expiresAt
    }

    public var endpoint: Endpoint? { try? Endpoint(address) }

    /// The label the UI shows: the desktop's name once there is one, and the
    /// address before that, since an address is at least recognisable.
    public var displayName: String { computerName.isEmpty ? address : computerName }

    /// An approved pairing whose token does not have the gateway's shape.
    ///
    /// Checked on the way *in* as well as on the way out: a token is sent as a
    /// bearer header on every request, so a malformed one would turn every call
    /// into a 401 that reads as "the desktop revoked you".
    public var hasUsableToken: Bool {
        guard let token else { return false }
        return Credential.isDeviceToken(token)
    }
}

/// The list of computers this phone knows, and which one it is talking to.
///
/// Ported from `ComputerStore.java`, including the two rules that are easy to
/// get wrong:
///
/// * the saved object holds the *current* computer at the top level and every
///   known computer under `computers`, keyed by address. A single-computer
///   install from an older build has no `computers` map at all, so a top-level
///   entry that already carries a token is folded into the map on read rather
///   than being lost.
/// * a half-finished pairing is not a computer yet. It is saved so the flow can
///   resume, but it is only recorded in the list once it has a token, or once
///   its address was already known and it is not merely waiting for approval —
///   otherwise every abandoned request would leave an entry the user has to
///   delete by hand.
public final class ComputerStore {
    private let vault: CredentialVault
    private let attachments: AttachmentStore?

    /// Held for the whole of every operation below.
    ///
    /// Each one is a read-modify-write over one file, and they are asked for
    /// from the main actor, the pairing worker and the pairing poll queue at
    /// the same time. The vault's own lock covers a single `load` or a single
    /// `save`; what it cannot cover is the gap between them, and an update lost
    /// in that gap leaves the list and the current computer disagreeing — the
    /// computer list still showing a pairing the current computer no longer
    /// has. Recursive because `select` and `clearClaim` save what they read.
    private let lock = NSRecursiveLock()

    public init(vault: CredentialVault, attachments: AttachmentStore? = nil) {
        self.vault = vault
        self.attachments = attachments
    }

    /// Includes all profiles and the top-level pending pairing, not just the
    /// selected computer. The same operation lock protects writes and startup GC.
    public func synchronizeAttachmentReferences() throws {
        lock.lock()
        defer { lock.unlock() }
        let saved = try vault.load()
        if saved.has("computers"), !saved.isNull("computers"), saved.object("computers") == nil {
            throw CredentialStoreError.unreadable
        }
        _ = try profiles(saved)
        attachments?.updateReferences(owner: "remote", references: AttachmentStore.references(in: saved.raw))
    }

    private func commit(_ saved: [String: Any]) throws {
        try vault.save(JSONObject(dictionary: saved))
        attachments?.updateReferences(owner: "remote", references: AttachmentStore.references(in: saved))
    }

    /// The computer the app talks to right now.
    ///
    /// An empty computer rather than nil when nothing is stored: the callers
    /// branch on `isPaired`, and an optional would make every screen handle a
    /// state that behaves exactly like "no address yet".
    ///
    /// Read through the list rather than straight off the top level. The two
    /// are written together and normally identical, but they are not written
    /// alike: the top level takes whatever object it is handed, while the list
    /// refuses to record a pairing that has not been approved. So a pairing
    /// request that arrives late — a second tap, or a dial that came back after
    /// the desktop approved a newer one — used to take the credentials off the
    /// current computer and leave them in the list. The list is the record of
    /// pairings and the top level is only the pointer to which one is current,
    /// so a current computer with no request of its own behind it reads from
    /// the record. That repairs a phone already in that state, too.
    public func current() throws -> PairedComputer {
        lock.lock()
        defer { lock.unlock() }
        let saved = try vault.load()
        return resolve(PairedComputer(saved.removing("computers")), in: try profiles(saved))
    }

    /// Every known computer, newest pairing or not.
    ///
    /// Sorted, because the stored map is a JSON object and JSON objects have no
    /// order — without this the list would reshuffle between launches.
    public func all() throws -> [PairedComputer] {
        lock.lock()
        defer { lock.unlock() }
        return try profiles(try vault.load())
            .map { PairedComputer(JSONObject(dictionary: $0.value)) }
            .sorted { Self.before($0, $1) }
    }

    /// Makes `computer` the current computer and records it in the list.
    ///
    /// A save never takes credentials or a name away from the record it is
    /// aimed at. Re-pairing an address this phone already holds, or a request
    /// that was still in flight when the desktop approved it, arrives here as a
    /// half-finished computer — an address and a claim, no token — and writing
    /// that as it stands would un-pair a computer the phone is still using.
    public func save(_ computer: PairedComputer) throws {
        lock.lock()
        defer { lock.unlock() }
        let known = try profiles(try vault.load())
        let healed = Self.carrying(computer, over: known[computer.address])
        var saved = healed.json
        // The list records pairings, not requests. A computer that is merely
        // waiting for the desktop joins it only once it has a token of its own
        // to bring, or when it was already known and this is not a request at
        // all — otherwise every abandoned request would leave an entry the user
        // has to delete by hand.
        let bringsCredentials = computer.token != nil || computer.deviceId != nil
        if bringsCredentials || (known[computer.address] != nil && computer.claim == nil) {
            saved["computers"] = known.merging([computer.address: healed.json]) { _, new in new }
        } else {
            saved["computers"] = known
        }
        try commit(saved)
    }

    /// Renames a computer's label without touching its credentials.
    ///
    /// Applied to the list entry and, if it is the current computer, to the
    /// top-level object too — otherwise the phone would show one name in the
    /// picker and another everywhere else.
    public func rename(address: String, name: String) throws {
        lock.lock()
        defer { lock.unlock() }
        var saved = (try vault.load()).raw
        var known = try profiles(JSONObject(dictionary: saved))
        guard var entry = known[address] else { throw CredentialStoreError.unknownComputer }
        entry["computerName"] = name
        known[address] = entry
        if (saved["address"] as? String) == address { saved["computerName"] = name }
        saved["computers"] = known
        try commit(saved)
    }

    /// Mutates one stored profile without selecting it.
    ///
    /// Draft and idempotency updates can finish after the user has moved to a
    /// different computer. Calling `save` there would make the old computer
    /// current again; addressing the record explicitly updates its profile and
    /// only mirrors it to the top level when it is still the selected one.
    @discardableResult
    public func update(address: String,
                       _ change: (inout PairedComputer) -> Void) throws -> PairedComputer {
        lock.lock()
        defer { lock.unlock() }
        let loaded = try vault.load()
        var saved = loaded.raw
        var known = try profiles(loaded)
        guard let entry = known[address] else { throw CredentialStoreError.unknownComputer }
        var computer = PairedComputer(JSONObject(dictionary: entry))
        change(&computer)
        // The key is the identity of the record. A profile mutation may not
        // silently move it under another address.
        computer.address = address
        known[address] = computer.json
        if loaded.text("address") == address {
            saved = computer.json
        }
        saved["computers"] = known
        try commit(saved)
        return computer
    }

    /// Forgets a computer. Forgetting the current one leaves no current
    /// computer at all, which is what sends the app back to pairing.
    public func remove(_ address: String) throws {
        lock.lock()
        defer { lock.unlock() }
        var saved = (try vault.load()).raw
        var known = try profiles(JSONObject(dictionary: saved))
        known.removeValue(forKey: address)
        if (saved["address"] as? String) == address { saved = [:] }
        saved["computers"] = known
        try commit(saved)
    }

    /// Switches the current computer to one already in the list.
    @discardableResult
    public func select(_ address: String) throws -> PairedComputer {
        lock.lock()
        defer { lock.unlock() }
        let known = try profiles(try vault.load())
        guard let entry = known[address] else { throw CredentialStoreError.unknownComputer }
        let computer = PairedComputer(JSONObject(dictionary: entry))
        try save(computer)
        return computer
    }

    /// Drops a pending claim from the current computer, keeping the address.
    ///
    /// Used when a request expires or the desktop refuses it: the claim is what
    /// has to go, while the address and name are what the user retypes if they
    /// are thrown away.
    @discardableResult
    public func clearClaim() throws -> PairedComputer {
        lock.lock()
        defer { lock.unlock() }
        var computer = try current()
        computer.claim = nil
        computer.pairingId = nil
        computer.expiresAt = nil
        try save(computer)
        return computer
    }

    /// Clears a failed/expired poll only if it still belongs to this request.
    /// A second pairing may have replaced the top-level claim while the first
    /// poll was blocked on the network; the first one must not erase it.
    @discardableResult
    public func clearClaim(ifMatching expected: PairedComputer) throws -> Bool {
        lock.lock()
        defer { lock.unlock() }
        var computer = try current()
        guard computer.address == expected.address,
              computer.pairingId == expected.pairingId,
              computer.claim == expected.claim else { return false }
        computer.claim = nil
        computer.pairingId = nil
        computer.expiresAt = nil
        try save(computer)
        return true
    }

    // MARK: - The stored shape

    /// The current computer, with the list's record for its address standing in
    /// for it when the two disagree.
    ///
    /// A request waiting for approval is normally flow state, and it is kept:
    /// it is what lets the flow resume instead of asking for a new code. But a
    /// request for an address the list already holds a *pairing* for is not a
    /// request any more — the desktop has answered it, and the claim is what a
    /// dial that came back late left behind. There the record is the newer
    /// truth, and reading it back is what makes 电脑 and 远程控制 agree.
    private func resolve(_ top: PairedComputer, in known: [String: [String: Any]]) -> PairedComputer {
        guard !top.address.isEmpty, let entry = known[top.address] else { return top }
        let record = PairedComputer(JSONObject(dictionary: entry))
        guard top.claim == nil || record.isPaired else { return top }
        return record
    }

    /// What a save must end up with: what came in, plus whatever the record for
    /// the same address already had and this one does not.
    private static func carrying(_ incoming: PairedComputer, over previous: [String: Any]?) -> PairedComputer {
        guard let previous else { return incoming }
        let stored = PairedComputer(JSONObject(dictionary: previous))
        var next = incoming
        if next.token == nil { next.token = stored.token }
        if next.deviceId == nil { next.deviceId = stored.deviceId }
        if next.permission == nil { next.permission = stored.permission }
        if next.computerName.isEmpty { next.computerName = stored.computerName }
        if next.pendingCreate == nil { next.pendingCreate = stored.pendingCreate }
        if next.pendingCommand == nil { next.pendingCommand = stored.pendingCommand }
        if next.drafts == nil { next.drafts = stored.drafts }
        if next.draftEdits == nil { next.draftEdits = stored.draftEdits }
        if next.draftAttachments == nil { next.draftAttachments = stored.draftAttachments }
        next.extraFields = JSONObject(dictionary:
            stored.extraFields.raw.merging(next.extraFields.raw) { _, incoming in incoming })
        return next
    }

    private func profiles(_ saved: JSONObject) throws -> [String: [String: Any]] {
        var known: [String: [String: Any]] = [:]
        if let stored = saved.object("computers") {
            for (address, value) in stored.raw {
                guard let entry = value as? [String: Any] else {
                    throw CredentialStoreError.unreadable
                }
                known[address] = entry
            }
        }
        if saved.has("token") || saved.has("deviceId") {
            var current = saved.raw
            current.removeValue(forKey: "computers")
            // Silently skipping a damaged record would turn the next save into
            // a deletion of its credentials. Android's getString throws when
            // this address is absent; keep the stored object untouched here.
            guard let address = saved.raw["address"] as? String else {
                throw CredentialStoreError.unreadable
            }
            known[address] = current
        }
        return known
    }

    private static func before(_ left: PairedComputer, _ right: PairedComputer) -> Bool {
        if left.displayName.localizedCaseInsensitiveCompare(right.displayName) != .orderedSame {
            return left.displayName.localizedCaseInsensitiveCompare(right.displayName) == .orderedAscending
        }
        return left.address < right.address
    }
}

extension JSONObject {
    /// A copy without a key. The stored object is immutable, so every read that
    /// must not see the computer list goes through here.
    public func removing(_ key: String) -> JSONObject {
        var fields = raw
        fields.removeValue(forKey: key)
        return JSONObject(dictionary: fields)
    }
}

/// A vault that keeps the credentials in memory.
///
/// What the tests use, and what SwiftUI previews use: same rules as the real
/// store, nothing written to disk.
public final class MemoryCredentialVault: CredentialVault {
    private var stored = JSONObject()

    public init() {}

    public convenience init(_ json: String) {
        self.init()
        stored = (try? JSONBody.object(Data(json.utf8))) ?? JSONObject()
    }

    public func load() throws -> JSONObject { stored }

    public func save(_ value: JSONObject) throws { stored = value }

    public func clear() throws { stored = JSONObject() }
}
