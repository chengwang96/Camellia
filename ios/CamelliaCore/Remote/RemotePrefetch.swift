import Foundation

/// Snapshots of conversations the phone expects to be opened, held in memory so
/// the transcript is on screen before the tunnel has answered.
///
/// Ported from Android's `RemotePrefetch` for snapshot caching. The companion
/// `RemotePrefetchPlan` handles its immediate/idle request order; `AppModel`
/// runs that plan on a dedicated utility lane.
///
/// The store is bounded by a byte budget estimated from the text it holds, with
/// a hard entry cap on top. The cap is an admission Android does not need: its
/// budget counts serialized JSON, while this keeps the decoded snapshots, whose
/// object overhead is real memory the text estimate does not see. Without the
/// cap a few thousand tiny snapshots would pass the budget test and still hold
/// megabytes.
///
/// Thread-safe, because a prefetch fetch finishes off the main queue and the
/// screen reads it on the main queue.
public final class RemotePrefetch {
    /// How much may be held, and for how long an entry counts as fresh.
    public struct Budget: Sendable {
        /// Total estimated bytes across all entries.
        public let bytes: Int
        /// A single snapshot heavier than this is not worth keeping.
        public let perSnapshot: Int
        /// How long an entry is trusted without refetching, in seconds.
        public let freshness: TimeInterval
        /// How many of the most recent conversations to fetch straight away.
        public let immediate: Int
        /// A hard ceiling on entry count, whatever the byte estimate says.
        public let entries: Int

        public init(bytes: Int, perSnapshot: Int = 2 * 1024 * 1024,
                    freshness: TimeInterval = 60, immediate: Int = 10, entries: Int = 300) {
            self.bytes = bytes
            self.perSnapshot = perSnapshot
            self.freshness = freshness
            self.immediate = immediate
            self.entries = entries
        }

        /// Android's rule: a sixteenth of the memory the process may use,
        /// floored at 8 MiB and capped at 32 MiB.
        public static func standard(physicalMemory: UInt64) -> Budget {
            let sixteenth = Int(physicalMemory / 16)
            let bounded = min(max(sixteenth, 8 * 1024 * 1024), 32 * 1024 * 1024)
            return Budget(bytes: bounded)
        }
    }

    private struct Entry {
        let snapshot: RemoteSnapshot
        let signature: String
        let at: TimeInterval
        let bytes: Int
    }

    private let budget: Budget
    private let clock: () -> TimeInterval
    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    /// Least recently used first.
    private var order: [String] = []
    private var size = 0

    public init(budget: Budget = .standard(physicalMemory: ProcessInfo.processInfo.physicalMemory),
                clock: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 }) {
        self.budget = budget
        self.clock = clock
    }

    /// The conversation's snapshot if one is held, whether or not it is fresh.
    ///
    /// Staleness is not this method's question: a stale snapshot is still far
    /// better than a blank screen, and the live fetch replaces it a moment
    /// later. `isFresh` is what a caller asks before deciding to refetch.
    public func cached(address: String, token: String, id: String) -> RemoteSnapshot? {
        lock.lock()
        defer { lock.unlock() }
        let key = Self.owner(address: address, token: token) + id
        guard let entry = entries[key] else { return nil }
        touch(key)
        return entry.snapshot
    }

    /// Whether a held snapshot still matches the list row and has not aged out.
    ///
    /// The signature is the same `seq:updatedAt:activity` Android keys on: a
    /// conversation whose row changed is not fresh even if it was fetched a
    /// second ago, because the row changing is what says the snapshot has too.
    public func isFresh(address: String, token: String, conversation: RemoteConversation) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let key = Self.owner(address: address, token: token) + conversation.id
        guard let entry = entries[key] else { return false }
        return entry.signature == conversation.signature && clock() - entry.at < budget.freshness
    }

    /// Keeps a snapshot, evicting whatever no longer fits.
    public func store(address: String, token: String, snapshot: RemoteSnapshot) {
        guard snapshot.hasMessages,
              let conversation = snapshot.conversation, !conversation.id.isEmpty else { return }
        let bytes = Self.weight(snapshot)
        lock.lock()
        defer { lock.unlock() }
        guard bytes <= budget.perSnapshot else { return }
        let key = Self.owner(address: address, token: token) + conversation.id
        if let previous = entries.removeValue(forKey: key) { size -= previous.bytes }
        entries[key] = Entry(snapshot: snapshot, signature: conversation.signature, at: clock(), bytes: bytes)
        size += bytes
        touch(key)
        evict()
    }

    /// Drops one conversation, for a delete or an archive.
    public func forget(address: String, token: String, id: String) {
        lock.lock()
        defer { lock.unlock() }
        drop(key: Self.owner(address: address, token: token) + id)
    }

    /// Drops everything held for one computer, for a removed pairing.
    public func forgetComputer(address: String, token: String) {
        lock.lock()
        defer { lock.unlock() }
        let prefix = Self.owner(address: address, token: token)
        for key in entries.keys where key.hasPrefix(prefix) { drop(key: key) }
    }

    /// Drops everything.
    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        entries = [:]
        order = []
        size = 0
    }

    /// How many snapshots are held, and what they are estimated to weigh.
    public var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return entries.count
    }

    public var weight: Int {
        lock.lock()
        defer { lock.unlock() }
        return size
    }

    /// The bound `weight` is held under.
    public var budgetBytes: Int { budget.bytes }

    // MARK: - Plumbing

    private func touch(_ key: String) {
        if let index = order.firstIndex(of: key) { order.remove(at: index) }
        order.append(key)
    }

    private func drop(key: String) {
        guard let removed = entries.removeValue(forKey: key) else { return }
        size -= removed.bytes
        if let index = order.firstIndex(of: key) { order.remove(at: index) }
    }

    /// Evicts until both bounds hold, never the entry just touched.
    private func evict() {
        while let victim = order.first, order.count > 1,
              size > budget.bytes || entries.count > budget.entries {
            drop(key: victim)
            // `drop` removes it from `order` too, so the next iteration reads a
            // new head rather than the same one.
        }
    }

    /// A computer's namespace, digesting the token so it is never a key.
    private static func owner(address: String, token: String) -> String {
        "\(address)\n\(token)".sha256 + "/"
    }

    /// What a snapshot is estimated to weigh.
    ///
    /// The text it holds, not the bytes it arrived as: this store keeps decoded
    /// values, so what can be measured is the prose and tool output that make a
    /// snapshot big. Per-value overhead is not counted, which is why `Budget`
    /// also carries an entry cap.
    private static func weight(_ snapshot: RemoteSnapshot) -> Int {
        var total = 64
        for message in snapshot.messages {
            total += message.text.utf8.count + 32
            total += Self.weight(message.process)
        }
        if let live = snapshot.live {
            total += live.text.utf8.count + 32
            total += Self.weight(live.process)
        }
        for queued in snapshot.queue { total += queued.text.utf8.count + 24 }
        return total
    }

    private static func weight(_ process: [RemoteProcessEntry]) -> Int {
        var total = 0
        for entry in process {
            total += entry.text.utf8.count + entry.input.utf8.count + 24
        }
        return total
    }
}
