import Foundation

/// One background producer, one pending ordinary snapshot and one UI delivery.
/// Critical events wait for the UI's acknowledgement, bounding their backlog
/// while preserving partial snapshots and state transitions in wire order.
public final class SnapshotCoalescer: @unchecked Sendable {
    private let lock = NSCondition()
    private let timer: DispatchSourceTimer
    private let interval: TimeInterval
    private let deliver: (RemoteSnapshot) -> Void
    private var lastSeen: RemoteSnapshot?
    private var pending: RemoteSnapshot?
    private var beforeCritical: RemoteSnapshot?
    private var urgent = false
    private var timerArmed = false
    private var deliveryQueued = false
    private var cancelled = false
    private var offered = 0
    private var acknowledged = 0

    public init(interval: TimeInterval = 0.12, deliver: @escaping (RemoteSnapshot) -> Void) {
        self.interval = interval
        self.deliver = deliver
        timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "app.camellia.snapshot.delivery", qos: .userInitiated))
        timer.schedule(deadline: .distantFuture)
        timer.setEventHandler { [weak self] in self?.drain() }
        timer.resume()
    }

    /// Called on the stream worker, never on the UI thread. `immediate` is used
    /// for the first event of each connection, including a reconnect.
    @discardableResult
    public func offer(_ snapshot: RemoteSnapshot, immediate: Bool = false) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !cancelled else { return false }
        let critical = immediate || !Self.replaceable(snapshot, after: lastSeen)
        if let previous = lastSeen, !snapshot.instanceId.isEmpty,
           snapshot.instanceId == previous.instanceId, snapshot.cursor < previous.cursor {
            // Keep comparing future frames against the accepted high-water
            // state, rather than an ignored stale permission/goal transition.
        } else { lastSeen = snapshot }
        offered += 1
        let ticket = offered
        if critical { beforeCritical = pending }
        pending = snapshot
        urgent = critical
        if !deliveryQueued, critical || !timerArmed { arm(critical ? 0 : interval) }
        if critical {
            while !cancelled, acknowledged < ticket { lock.wait() }
        }
        return !cancelled
    }

    /// Flush before reporting a disconnect/terminal state. The UI must see its
    /// latest accepted text before the stream state changes.
    @discardableResult
    public func flush() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !cancelled else { return false }
        let ticket = offered
        if pending != nil { urgent = true; if !deliveryQueued { arm(0) } }
        while !cancelled, acknowledged < ticket { lock.wait() }
        return !cancelled
    }

    public func cancel() {
        lock.lock()
        cancelled = true
        pending = nil
        beforeCritical = nil
        lastSeen = nil
        lock.broadcast()
        lock.unlock()
        timer.cancel()
    }

    private func arm(_ delay: TimeInterval) {
        timerArmed = true
        timer.schedule(deadline: .now() + delay)
    }

    private func drain() {
        lock.lock()
        timerArmed = false
        guard !cancelled, !deliveryQueued, let next = pending else { lock.unlock(); return }
        let previous = beforeCritical
        let ticket = offered
        pending = nil
        beforeCritical = nil
        urgent = false
        deliveryQueued = true
        lock.unlock()
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if let previous, !self.isCancelled { self.deliver(previous) }
            if !self.isCancelled { self.deliver(next) }
            self.lock.lock()
            self.acknowledged = max(self.acknowledged, ticket)
            self.deliveryQueued = false
            if !self.cancelled, self.pending != nil { self.arm(self.urgent ? 0 : self.interval) }
            self.lock.broadcast()
            self.lock.unlock()
        }
    }

    private var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }

    /// Cursor progress may accompany every text delta. Regressions must flush
    /// the prior high-water mark so stale frames remain stale in the transcript.
    static func replaceable(_ next: RemoteSnapshot, after previous: RemoteSnapshot?) -> Bool {
        guard let previous, next.hasMessages, previous.hasMessages,
              next.instanceId == previous.instanceId, next.cursor >= previous.cursor,
              next.conversation == previous.conversation, next.permission == previous.permission,
              next.messages == previous.messages, next.settings == previous.settings,
              next.automation == previous.automation, next.queueVersion == previous.queueVersion,
              next.canQueue == previous.canQueue, next.queue == previous.queue,
              next.nextBefore == previous.nextBefore, next.olderAvailable == previous.olderAvailable else { return false }
        switch (next.live, previous.live) {
        case (nil, nil): return true
        case (.some(let next), .some(let previous)):
            guard next.runId == previous.runId, next.startedAt == previous.startedAt,
                  next.userSeq == previous.userSeq, next.textTruncated == previous.textTruncated,
                  next.pendingApprovals == previous.pendingApprovals, next.approvals == previous.approvals,
                  next.process.count == previous.process.count else { return false }
            // Reasoning text may grow; step identity, status and input changes
            // are delivered immediately just like a permission or goal change.
            return zip(next.process, previous.process).allSatisfy {
                $0.id == $1.id && $0.type == $1.type && $0.title == $1.title && $0.status == $1.status
                    && $0.input == $1.input && $0.truncated == $1.truncated
            }
        default: return false
        }
    }

    deinit { timer.cancel() }
}
