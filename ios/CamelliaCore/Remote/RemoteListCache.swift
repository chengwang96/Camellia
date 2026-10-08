import CryptoKit
import Foundation

/// The conversation list each computer last sent, kept on disk so the list is
/// on screen before the tunnel has answered.
///
/// Ported from Android's `RemoteListCache`, with two deliberate differences:
///
/// * the key is a digest of address and token rather than the raw pair, so the
///   stored dictionary never holds a credential — the same reason
///   `RemoteReadState` digests its material;
/// * the payload is sealed under the device key the credentials already use,
///   with a context of its own, so a cache file swapped for the credential file
///   (or the other way round) fails to authenticate instead of being misread.
///
/// The cache is disposable by design: an unreadable file reads as empty rather
/// than as an error, because a list the phone will fetch again anyway is not
/// worth a dialog. Only what the list screen draws is kept — the rows, the
/// workspaces and whether independent conversations are allowed — since that is
/// all that has to appear instantly; permissions are always asked for live.
public final class RemoteListCache {
    /// How many conversations one computer's entry keeps, matching Android.
    /// Past this the entry records where to resume so the bound is explicit
    /// rather than a silent truncation.
    public static let conversationLimit = 1000
    /// How many computers' lists are remembered in total.
    public static let entryLimit = 20

    /// One computer's remembered list.
    public struct Entry: Equatable {
        public let conversations: [RemoteConversation]
        public let workspaces: [RemoteWorkspace]
        /// Where the desktop would resume, or the truncation point.
        public let nextOffset: Int64
        public let includeUnassigned: Bool
        /// Epoch milliseconds, so a caller could tell a stale list from a fresh
        /// one without guessing.
        public let savedAt: Int64
    }

    /// The sealing context, kept apart from the vault's so the two files are
    /// not interchangeable.
    public static let context = "camellia.remote.cache.v1"

    private let url: URL
    private let keys: SecretKeyStore
    private let clock: () -> Int64
    private let lock = NSLock()
    private var entries: [String: Any]

    public init(url: URL, keys: SecretKeyStore,
                clock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.url = url
        self.keys = keys
        self.clock = clock
        self.entries = Self.read(url: url, keys: keys) ?? [:]
    }

    /// A digest of the computer's identity, so the token is never written out.
    public static func key(address: String, token: String) -> String {
        "\(address)\n\(token)".sha256
    }

    /// What this computer's list looked like last time, or nil.
    public func load(address: String, token: String) -> Entry? {
        lock.lock()
        defer { lock.unlock() }
        guard let stored = entries[Self.key(address: address, token: token)] as? [String: Any] else {
            return nil
        }
        let object = JSONObject(dictionary: stored)
        return Entry(
            conversations: object.objects("conversations").map(RemoteConversation.init),
            workspaces: object.objects("workspaces").map(RemoteWorkspace.init),
            nextOffset: object.long("nextOffset", fallback: -1),
            includeUnassigned: object.bool("includeUnassigned"),
            savedAt: object.long("savedAt"))
    }

    /// Remembers this computer's list.
    public func save(address: String, token: String, conversations: [RemoteConversation],
                     nextOffset: Int64, workspaces: [RemoteWorkspace], includeUnassigned: Bool) {
        lock.lock()
        defer { lock.unlock() }
        let key = Self.key(address: address, token: token)
        let bounded = Array(conversations.prefix(Self.conversationLimit))
        // A list longer than the bound is stored up to it, and the resume point
        // is the bound rather than whatever the desktop offered next — an entry
        // that claimed to be complete while holding a truncated list would be
        // the one way this cache could mislead.
        let resume = conversations.count > Self.conversationLimit ? Int64(Self.conversationLimit) : nextOffset
        entries[key] = [
            "conversations": bounded.map(\.json),
            "workspaces": workspaces.map(\.json),
            "nextOffset": resume,
            "includeUnassigned": includeUnassigned,
            "savedAt": clock(),
        ]
        evict(keeping: key)
        write()
    }

    /// Forgets one computer's list, for when a pairing is removed.
    public func remove(address: String, token: String) {
        lock.lock()
        defer { lock.unlock() }
        entries.removeValue(forKey: Self.key(address: address, token: token))
        write()
    }

    /// Forgets everything.
    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        entries = [:]
        write()
    }

    /// How many computers are remembered. For the checks, and for a settings
    /// row that wants to say how much is stored.
    public var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return entries.count
    }

    /// Drops entries until the bound holds, never the one just written.
    ///
    /// A dictionary has no insertion order, so this takes whichever other key
    /// comes first: the bound is what protects memory, and which of two stale
    /// lists survives is not a promise worth making.
    private func evict(keeping key: String) {
        while entries.count > Self.entryLimit {
            guard let victim = entries.keys.first(where: { $0 != key }) else { break }
            entries.removeValue(forKey: victim)
        }
    }

    private func write() {
        guard let payload = try? JSONSerialization.data(withJSONObject: entries),
              let sealed = try? CredentialSeal.seal(payload, using: keys.key(), context: Self.context),
              let envelope = try? JSONSerialization.data(withJSONObject: sealed.json) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        try? envelope.write(to: url, options: .atomic)
        // Set after writing rather than as a write option: an atomic write
        // replaces the file, and the replacement does not inherit the old one's
        // protection attribute.
        try? (url as NSURL).setResourceValue(URLFileProtection.complete, forKey: .fileProtectionKey)
    }

    /// Reads the sealed envelope back, or nil for anything unusable.
    ///
    /// Every failure collapses to nil on purpose: a missing file is the first
    /// launch, a wrong key is a cache from another device, and an edited file
    /// is a cache nobody should trust. None of them is worth telling the user
    /// about, and all of them are answered by fetching the list again.
    private static func read(url: URL, keys: SecretKeyStore) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url), !data.isEmpty,
              let envelope = try? JSONBody.object(data),
              let sealed = SealedCredential(json: envelope),
              let opened = try? CredentialSeal.open(sealed, using: keys.key(), context: context),
              let value = try? JSONSerialization.jsonObject(with: opened) as? [String: Any]
        else { return nil }
        return value
    }
}
