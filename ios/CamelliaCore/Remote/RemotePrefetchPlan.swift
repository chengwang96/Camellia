import Foundation

/// Android's speculative request order, kept separate from the snapshot cache
/// and the transport so it can be checked without a tunnel or a running app.
/// Callers own the timer and execute at most one returned request at a time.
public struct RemotePrefetchPlan {
    public struct Owner: Hashable, Sendable {
        public let address: String
        public let token: String
        public let endpoint: Endpoint

        public init(address: String, token: String, endpoint: Endpoint) {
            self.address = address
            self.token = token
            self.endpoint = endpoint
        }
    }

    public enum Target: Sendable {
        case snapshot(RemoteConversation)
        case page(Int64)
    }

    public struct Work: Sendable {
        public let owner: Owner
        public let target: Target
        fileprivate var immediate: Bool
    }

    private struct PageKey: Hashable {
        let owner: Owner
        let offset: Int64
    }

    private var pending: [Work] = []
    private var pages: [PageKey: TimeInterval] = [:]
    private let immediateLimit: Int
    private let freshness: TimeInterval

    public init(immediateLimit: Int = 10, freshness: TimeInterval = 60) {
        self.immediateLimit = immediateLimit
        self.freshness = freshness
    }

    public var pendingCount: Int { pending.count }
    public var hasImmediate: Bool { pending.contains(where: \.immediate) }

    /// The first ten most recently changed rows can run immediately. Older
    /// rows and the next list page wait for idle time. A newer list replaces a
    /// pending row without losing its place or its immediate priority.
    public mutating func schedule(_ owner: Owner, rows: [RemoteConversation],
                                  nextOffset: Int64, initial: Bool, now: TimeInterval,
                                  cache: RemotePrefetch) {
        let ordered = rows.sorted { $0.updatedAt > $1.updatedAt }
        for (index, row) in ordered.enumerated() {
            guard Self.validId(row.id),
                  !cache.isFresh(address: owner.address, token: owner.token, conversation: row)
            else { continue }
            let immediate = initial && index < immediateLimit
            if let old = pending.firstIndex(where: {
                $0.owner == owner && $0.snapshotId == row.id
            }) {
                pending[old] = Work(owner: owner, target: .snapshot(row),
                                    immediate: immediate || pending[old].immediate)
            } else {
                pending.append(Work(owner: owner, target: .snapshot(row), immediate: immediate))
            }
        }
        enqueuePage(owner, offset: nextOffset, now: now)
    }

    /// Android waits two seconds from the most recent interaction, then paces
    /// idle work at no faster than one request every half second.
    public func delay(now: TimeInterval, lastInteraction: TimeInterval) -> TimeInterval? {
        guard !pending.isEmpty else { return nil }
        if hasImmediate { return 0 }
        return max(0.5, 2 - (now - lastInteraction))
    }

    /// Removes the next usable request. A row made fresh by another response
    /// is discarded here, so a duplicate list event cannot waste a round trip.
    public mutating func take(idle: Bool, cache: RemotePrefetch) -> Work? {
        while !pending.isEmpty {
            let index = pending.firstIndex(where: \.immediate) ?? 0
            if !idle && !pending[index].immediate { return nil }
            let work = pending.remove(at: index)
            if case .snapshot(let row) = work.target,
               cache.isFresh(address: work.owner.address, token: work.owner.token,
                             conversation: row) { continue }
            return work
        }
        return nil
    }

    /// Each successfully fetched page queues its rows as idle work, then its
    /// successor. A non-advancing offset ends the walk instead of looping.
    public mutating func completedPage(_ work: Work, rows: [RemoteConversation],
                                       nextOffset: Int64, now: TimeInterval,
                                       cache: RemotePrefetch) {
        guard case .page(let offset) = work.target else { return }
        pages[PageKey(owner: work.owner, offset: offset)] = now
        schedule(work.owner, rows: rows, nextOffset: nextOffset > offset ? nextOffset : -1,
                 initial: false, now: now, cache: cache)
    }

    public mutating func removeSnapshot(_ id: String, for owner: Owner) {
        pending.removeAll { $0.owner == owner && $0.snapshotId == id }
    }

    public mutating func remove(_ owner: Owner) {
        pending.removeAll { $0.owner == owner }
        pages = pages.filter { $0.key.owner != owner }
    }

    public mutating func cancel() {
        pending.removeAll()
        pages.removeAll()
    }

    private mutating func enqueuePage(_ owner: Owner, offset: Int64, now: TimeInterval) {
        guard offset >= 0 else { return }
        let key = PageKey(owner: owner, offset: offset)
        if let loaded = pages[key], now - loaded < freshness { return }
        guard !pending.contains(where: { $0.owner == owner && $0.pageOffset == offset }) else { return }
        pending.append(Work(owner: owner, target: .page(offset), immediate: false))
    }

    private static func validId(_ id: String) -> Bool {
        id.utf8.count == 36 && id.utf8.allSatisfy {
            ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) || $0 == 45
        }
    }
}

private extension RemotePrefetchPlan.Work {
    var snapshotId: String? {
        if case .snapshot(let row) = target { return row.id }
        return nil
    }

    var pageOffset: Int64? {
        if case .page(let offset) = target { return offset }
        return nil
    }
}
