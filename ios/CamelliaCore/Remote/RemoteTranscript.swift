import Foundation

/// One message as the transcript chooses to show it, after the process
/// inheritance rules have been applied.
public struct RenderedMessage: Sendable, Identifiable, Hashable {
    public let message: RemoteMessage
    /// Process steps shown with this message, which may be its own or ones
    /// inherited from the turns since the last user message.
    public let process: [RemoteProcessEntry]

    public var id: Int64 { message.seq }

    /// Android only offers the edit action on the latest, complete user row.
    /// A tail-only message cannot safely supply the original prompt to resend.
    public func isEditCandidate(lastUserSeq: Int64?) -> Bool {
        message.role == .user && !message.textTruncated
            && id > 0 && id == lastUserSeq
    }
}

/// Identifies the desktop echo of one submitted user message. When the
/// command result has no userSeq, Android only accepts the row immediately
/// after the expected sequence, with the exact wire prompt, from that same
/// desktop instance. Matching any earlier equal prompt would hide a send that
/// has not actually appeared in history yet.
public struct RemoteOutgoingEcho: Sendable, Equatable {
    public let instanceId: String
    public let expectedSeq: Int64
    public let prompt: String
    public var userSeq: Int64?

    public init(instanceId: String, expectedSeq: Int64, prompt: String,
                userSeq: Int64? = nil) {
        self.instanceId = instanceId
        self.expectedSeq = expectedSeq
        self.prompt = prompt
        self.userSeq = userSeq
    }

    public func matches(_ row: RemoteMessage, currentInstanceId: String) -> Bool {
        guard currentInstanceId == instanceId, row.role == .user else { return false }
        if let userSeq { return row.seq == userSeq }
        return row.seq == expectedSeq &+ 1 && row.text == prompt
    }
}

/// Holds what a conversation looks like, given the snapshots the desktop sent.
///
/// A snapshot's `messages` array is a whole page, never a delta, which makes
/// "apply" the interesting operation: every row at or after the first message
/// has been replaced, and a row behind it has been replaced too unless the
/// desktop says older history is still there. Those two rules come from
/// `RemoteTranscript.java` and are reproduced exactly, because getting them
/// wrong shows up as messages duplicated or silently vanished rather than as an
/// error — and an edited last message is re-emitted under a higher `seq`, which
/// is exactly the case that breaks a naive merge.
///
/// This type is deliberately free of networking and of UI: it is a pure
/// function of the snapshots fed into it, so the rules can be checked on a host
/// without a phone.
public final class RemoteTranscript {
    // Android's caps, so a long session cannot grow without bound.
    public static let maximumRows = 600
    public static let maximumBytes = 4 * 1024 * 1024

    /// Marks "we threw away history on purpose", after which rows behind the
    /// snapshot are no longer assumed to be superseded.
    private var historyLimited = false
    private var history: [Int64: RemoteMessage] = [:]

    public private(set) var instanceId = ""
    public private(set) var cursor: Int64 = -1
    public private(set) var nextBefore: Int64?

    /// Whether paging backwards can still fetch anything.
    ///
    /// False once rows were evicted locally: after that the desktop's cursor
    /// would point into history the phone no longer holds, so the phone stops
    /// offering to page rather than fetching into a hole. This is Android's
    /// `nextBefore != null && !historyLimited`.
    public var hasOlder: Bool { nextBefore != nil && !historyLimited }

    public private(set) var conversation: RemoteConversation?
    public private(set) var permission: RemotePermission?
    public private(set) var live: RemoteLive?
    public private(set) var settings: RemoteSettings?
    public private(set) var automation: RemoteAutomation?
    public private(set) var queue: [RemoteQueueEntry] = []
    /// The revision the cached queue came from. Android only accepts a queue
    /// whose version has not gone backwards, because snapshots for a streaming
    /// reply arrive constantly and an out-of-order one would otherwise restore
    /// entries the desktop has already sent.
    public private(set) var queueVersion: Int64 = -1
    /// Whether this desktop accepts queued sends.
    public private(set) var canQueue = false
    /// Whether the goal card should be drawn, after the completion-dismissal
    /// rule in `RemoteGoalVisibility` has been applied to this snapshot.
    public private(set) var showsGoal = false
    /// Set once the first snapshot lands; until then the client must not offer
    /// commands, because it does not yet know the permission level.
    public private(set) var connected = false

    private var goalVisibility = RemoteGoalVisibility()

    public init() {}

    /// Feeds a snapshot in. Returns false when it was discarded as stale.
    @discardableResult
    public func apply(_ snapshot: RemoteSnapshot) -> Bool {
        let server = snapshot.instanceId
        let next = snapshot.cursor

        // Cursors only move forward within one desktop instance. A snapshot
        // that arrives out of order is a retransmit, not news.
        if !server.isEmpty, server == instanceId, next < cursor { return false }

        if server != instanceId {
            // A different instance means the desktop restarted or moved: cached
            // rows belong to a session that no longer exists.
            history.removeAll()
            historyLimited = false
            queueVersion = -1
            goalVisibility.reset()
        }
        instanceId = server
        cursor = next
        connected = true

        conversation = snapshot.conversation ?? conversation
        permission = snapshot.permission
        settings = snapshot.settings

        // Android applies the connection, permission and settings fields even
        // on an incomplete snapshot, then leaves the displayed detail alone.
        // In particular, missing `messages` is not an empty history page.
        guard snapshot.hasMessages else { return true }

        // The queue only ever moves forward. `canQueue` is the field's presence,
        // so a desktop without the feature keeps `queue` empty and the composer
        // never offers to enqueue.
        canQueue = snapshot.canQueue
        if snapshot.canQueue, snapshot.queueVersion >= queueVersion {
            queue = snapshot.queue
            queueVersion = snapshot.queueVersion
        } else if !snapshot.canQueue {
            queue = []
        }

        let first = snapshot.messages.first?.seq ?? 0
        merge(snapshot.messages, first: first, olderAvailable: snapshot.olderAvailable)
        // Backwards paging only stays meaningful while the oldest cached row is
        // at or behind this page. Once rows have been evicted, a cursor into
        // them would point somewhere the desktop can no longer serve.
        if history.isEmpty || (history.keys.min() ?? 0) >= first {
            nextBefore = snapshot.nextBefore
        }
        trim()
        live = snapshot.live
        automation = snapshot.automation
        // After the merge, because the goal's completion is measured against the
        // newest user turn the phone now knows about.
        refreshGoalVisibility()
        return true
    }

    public func reset() {
        history.removeAll()
        historyLimited = false
        instanceId = ""
        cursor = -1
        nextBefore = nil
        queueVersion = -1
        conversation = nil
        permission = nil
        live = nil
        settings = nil
        automation = nil
        queue = []
        canQueue = false
        showsGoal = false
        goalVisibility.reset()
        connected = false
    }

    /// A reconnect is not a new conversation. Keep the visible messages and
    /// paging cursor, but withdraw control until a live snapshot confirms the
    /// desktop still grants it.
    public func suspend() {
        connected = false
    }

    /// Android removes the message views when a detail request ends in 403 or
    /// 404. A normal reconnect is different: it keeps history via `suspend()`.
    /// Clear only displayed message content here, leaving the conversation,
    /// queue metadata and stream connection state alone. `suspend()` withdraws
    /// control separately when the stream itself has failed.
    public func hideMessagesAfterAccessFailure() {
        history.removeAll()
        historyLimited = false
        nextBefore = nil
        live = nil
        goalVisibility.reset()
    }

    /// Show only the history from an ahead-of-time fetch while a live detail
    /// connection is opening. Android's `showPrefetchedConversation` does not
    /// restore live reply, queue, automation, settings or control from cache.
    public func showPrefetched(_ snapshot: RemoteSnapshot) {
        guard snapshot.hasMessages else { return }
        for row in snapshot.messages { history[row.seq] = row }
        trim()
    }

    /// Folds an older page (`?before=`) in, keeping everything already held.
    ///
    /// Deliberately *not* `apply`. An older page's first seq is smaller than
    /// anything cached, so the supersede rule in `merge` would treat the whole
    /// conversation as replaced by this page and delete the newer rows the
    /// person is reading. Android's `loadOlder` has the same split: it calls
    /// `retainHistory` per row, which is a plain put by seq, and only then moves
    /// `nextBefore` and trims. Returns false when the page belongs to a
    /// different desktop instance, which is the same guard Android applies
    /// before it renders.
    @discardableResult
    public func mergeOlder(_ snapshot: RemoteSnapshot) -> Bool {
        let server = snapshot.instanceId
        if !server.isEmpty, server != instanceId { return false }
        // A plain put by seq: an edited row re-emitted here simply replaces its
        // older copy, and rows the page does not mention are left alone.
        for row in snapshot.messages { history[row.seq] = row }
        nextBefore = snapshot.nextBefore
        trim()
        return true
    }

    /// Applies the completion-dismissal rule to the goal the snapshot carries.
    private func refreshGoalVisibility() {
        guard let goal = automation?.goal else {
            showsGoal = false
            goalVisibility.reset()
            return
        }
        // A goal with no id falls back to its objective, which is what Android
        // keys on when the desktop does not name one.
        let key = goal.id.isEmpty ? goal.objective : goal.id
        showsGoal = goalVisibility.show(key: key, phase: goal.phase,
                                        completedAt: goal.completedAt,
                                        latestUserSeq: latestUserSeq,
                                        latestUserAt: latestUserAt)
    }

    // MARK: - Reading

    /// The messages to show, oldest first, with process steps attached.
    ///
    /// Android does not render tool rows as messages. Their steps are held for
    /// the next assistant row or live reply; an assistant consumes them and a
    /// new user turn clears them.
    public var messages: [RenderedMessage] {
        renderedHistory().rows
    }

    /// Tool steps that have not yet been consumed by a finished assistant row.
    /// Android shows these in a standalone process block when there is no live
    /// reply to attach them to.
    public var pendingProcess: [RemoteProcessEntry] {
        renderedHistory().pending
    }

    /// The live reply's own process, or the pending tool steps behind it.
    public var liveProcess: [RemoteProcessEntry] {
        guard let live else { return [] }
        return live.process.isEmpty ? pendingProcess : live.process
    }

    private func renderedHistory() -> (rows: [RenderedMessage], pending: [RemoteProcessEntry]) {
        var result: [RenderedMessage] = []
        var pending: [RemoteProcessEntry] = []

        for seq in history.keys.sorted() {
            guard let message = history[seq] else { continue }
            switch message.role {
            case .user:
                pending = []
                result.append(RenderedMessage(message: message, process: message.process))
            case .tool:
                pending.append(contentsOf: message.process)
            case .assistant:
                let process = message.process.isEmpty ? pending : message.process
                result.append(RenderedMessage(message: message, process: process))
                pending = []
            case .note:
                result.append(RenderedMessage(message: message, process: message.process))
            }
        }
        return (result, pending)
    }

    /// Whether the desktop is mid-reply.
    public var busy: Bool {
        live != nil || conversation?.activity != nil
    }

    /// The highest user message seq known, used to confirm an outgoing message.
    public var lastUserSeq: Int64? {
        history.values.filter { $0.role == .user }.map(\.seq).max()
    }

    /// The newest user turn's sequence and wall-clock time.
    ///
    /// A goal that completed before the last thing the user typed has been moved
    /// on from, and these two are how that is decided — seq for a desktop that
    /// dates nothing, `at` for one that does.
    public var latestUserSeq: Int64 {
        history.values.filter { $0.role == .user }.map(\.seq).max() ?? 0
    }

    public var latestUserAt: Int64 {
        history.values.filter { $0.role == .user }.map(\.at).max() ?? 0
    }

    // MARK: - Merging

    private func merge(_ rows: [RemoteMessage], first: Int64, olderAvailable: Bool) {
        // 1. Rows behind this page are gone from the desktop, but only when the
        //    desktop *explicitly* says nothing older exists and we have not
        //    dropped rows ourselves. After a local eviction the rows are still
        //    real, they are just not cached, so deleting them would page into a
        //    hole. See `RemoteSnapshot.olderAvailable` for why a missing
        //    `nextBefore` counts as "older pages exist".
        if !olderAvailable, !historyLimited {
            if first <= 0 {
                // An empty page with nothing behind it means the desktop holds
                // no rows at all, so everything cached was replaced.
                history.removeAll()
            } else {
                history = history.filter { $0.key >= first }
            }
        }

        // 2. Everything from `first` onwards is replaced wholesale. This is what
        //    "snapshot, not delta" costs: a row the snapshot omits is absent
        //    because the desktop removed it, not because it was unchanged.
        for seq in history.keys where seq >= first {
            history.removeValue(forKey: seq)
        }

        // 3. Write the page back. An edited message returns under a higher seq,
        //    so it lands beside its old copy, which step 1 or 2 already removed.
        for row in rows { history[row.seq] = row }
    }

    private func trim() {
        var bytes = 0
        for row in history.values { bytes += rowBytes(row) }
        while history.count > Self.maximumRows || (bytes > Self.maximumBytes && history.count > 1) {
            guard let oldest = history.keys.min(), let row = history.removeValue(forKey: oldest) else { break }
            bytes -= rowBytes(row)
            historyLimited = true
            nextBefore = nil
        }
    }

    private func rowBytes(_ row: RemoteMessage) -> Int {
        48 + row.text.utf16.count + row.process.reduce(0) {
            $0 + 32 + $1.text.utf16.count + $1.input.utf16.count
        }
    }
}
