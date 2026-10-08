import Foundation

/// Everything that talks to one paired computer.
///
/// `RemoteTransport` is synchronous: each call blocks a thread until the
/// desktop answers through the tunnel. Small one-shot calls use a serial
/// request queue; artifact transfers use a separate serial queue so a large
/// download cannot hold up a command or conversation refresh. Results return
/// on the main queue.
///
/// **The stream does not share that queue.** A stream blocks for as long as the
/// desktop keeps it open — which is until the screen changes — so putting it on
/// the one-shot queue stops every request behind it from ever running. That was
/// the bug behind "配对成功但看不到会话": `connect()` opened the list stream and
/// then asked for the list, the fetch sat on a queue the stream was holding,
/// `listLoading` never cleared, and the screen stayed empty with no message.
/// Android is immune because its streams run on a two-thread pool, so one
/// long-lived stream leaves the other thread free for requests. Two queues here
/// are the same guarantee.
///
/// The `generation` counter is what stops a slow answer from a computer the
/// user has just switched away from overwriting the new one's screen. It is
/// read on the stream queue, the request queue and the main queue, so it is
/// guarded rather than merely hoped for.
///
/// One list response, possibly containing several pages requested together.
struct ConversationPage {
    let conversations: [RemoteConversation]
    let workspaces: [RemoteWorkspace]
    let cursor: Int64
    let instanceId: String
    /// Where the desktop would resume, or negative for a drained list.
    ///
    /// Also used by the list's load-more action and search continuation.
    let nextOffset: Int64
    /// Whether the desktop allows conversations that belong to no workspace.
    ///
    /// Carried through because it decides whether an empty independent group is
    /// worth a heading — a new standalone conversation has to land somewhere the
    /// user can see. Android keeps the same flag as `allowIndependent`.
    let includeUnassigned: Bool
    /// What this device may do on this computer.
    ///
    /// Taken from the list page when the desktop advertises it there and from
    /// `/v1/status` when it does not, which is the same fallback Android's
    /// `listInfo` makes. A screen that offered actions without it would offer
    /// buttons the desktop then refuses.
    let access: RemoteAccess
    /// The engines the desktop advertises for a new conversation, or nil when it
    /// said nothing. Same source and same nil-vs-empty meaning as the list page's
    /// own `engines`; carried through so the create sheet can offer them.
    let engines: [String]?

    /// The engines to offer when creating a conversation on this computer.
    var availableEngines: [RemoteEngine] { RemoteEngine.available(advertised: engines) }
}

final class RemoteSession {
    let computer: PairedComputer
    let transport: RemoteTransport

    /// One-shot requests, one at a time.
    ///
    /// Serial on purpose: the tunnel is the bottleneck, and a dozen parallel
    /// dials would queue behind each other on the node anyway.
    private let queue = DispatchQueue(label: "app.camellia.session")
    private let downloadQueue = DispatchQueue(label: "app.camellia.session.download")
    /// The snapshot stream, which holds its queue for as long as it is open.
    private let streamQueue = DispatchQueue(label: "app.camellia.session.stream")

    /// Guards `generation`, `watching`, `stream` and `listReceipt`, which are touched from the
    /// main queue, the request queue and the stream queue. The condition also
    /// wakes a stream waiting to retry when its screen is replaced.
    private let lock = NSCondition()
    private var generation = 0
    private var watching = false
    private var stream: RemoteStreamHandle?
    private var listReceipt: ListEventReceipt?
    private var detailCoalescer: SnapshotCoalescer?
    private var artifactTransfers: [UUID: ArtifactTransfer] = [:]

    init(computer: PairedComputer, transport: RemoteTransport) throws {
        guard computer.isPaired else { throw SessionError.notPaired }
        self.computer = computer
        self.transport = transport
    }

    enum SessionError: LocalizedError {
        case notPaired
        case invalidPage
        case invalidSnapshot

        var errorDescription: String? {
            switch self {
            case .notPaired: return "这台电脑还没有完成配对。"
            case .invalidPage: return "电脑返回了无法继续的会话分页。"
            case .invalidSnapshot: return "电脑返回的会话与请求不一致。"
            }
        }
    }

    /// Drops everything in flight and stops the stream.
    func invalidate() {
        lock.lock()
        generation += 1
        watching = false
        let open = stream
        stream = nil
        let receipt = listReceipt
        listReceipt = nil
        let coalescer = detailCoalescer
        detailCoalescer = nil
        let downloads = Array(artifactTransfers.values)
        artifactTransfers.removeAll()
        lock.broadcast()
        lock.unlock()
        // Cancelled outside the lock: closing the response is what unblocks a
        // stream thread sitting in `run`, which must not have to wait on a lock
        // it is about to be released from.
        receipt?.cancel()
        coalescer?.cancel()
        open?.cancel()
        downloads.forEach { $0.cancel() }
        transport.cancelCurrentRequest()
    }

    /// Ends the session for good. Stream changes use `invalidate()` alone,
    /// because the same transport must still serve the next conversation.
    func shutdown() {
        invalidate()
        transport.cancel()
    }

    // MARK: - One-shot calls

    func status(completion: @escaping (Result<RemoteStatus, Error>) -> Void) {
        run { try self.transport.status() }.deliver(completion)
    }

    /// Fetches one page by default. A stream refresh preserves the visible
    /// prefix; search requests every remaining page, as on Android.
    func conversations(offset start: Int = 0, minimumCount: Int = 0,
                       completion: @escaping (Result<ConversationPage, Error>) -> Void) {
        run { () -> ConversationPage in
            let first = try self.transport.conversations(offset: start)
            guard first.nextOffset < 0 || first.nextOffset > Int64(start) else {
                throw SessionError.invalidPage
            }
            var page = first
            var collected = page.conversations
            let access = page.access
            let engines = page.engines
            while page.nextOffset >= 0, collected.count < minimumCount {
                let offset = page.nextOffset
                guard offset > Int64(start), offset <= Int64(Int.max) else {
                    throw SessionError.invalidPage
                }
                page = try self.transport.conversations(offset: Int(offset))
                guard page.nextOffset < 0 || page.nextOffset > offset else {
                    throw SessionError.invalidPage
                }
                collected.append(contentsOf: page.conversations)
            }
            // A desktop too old to put the access (or the engine list) on the
            // list is asked once, and the answer serves whichever of the two is
            // still missing — the same `listInfo` fallback Android makes.
            var resolvedAccess = access
            var resolvedEngines = engines
            if resolvedAccess == nil || resolvedEngines == nil {
                let status = try self.transport.status()
                if resolvedAccess == nil { resolvedAccess = status.access }
                if resolvedEngines == nil { resolvedEngines = status.engines }
            }
            return ConversationPage(
                conversations: collected, workspaces: first.workspaces,
                cursor: first.cursor, instanceId: first.instanceId,
                nextOffset: page.nextOffset,
                includeUnassigned: first.includeUnassigned,
                access: resolvedAccess ?? .readOnly,
                engines: resolvedEngines)
        }.deliver(completion)
    }

    func snapshot(conversationId: String, before: Int64? = nil,
                  completion: @escaping (Result<RemoteSnapshot, Error>) -> Void) {
        run {
            let snapshot = try self.transport.conversation(id: conversationId, before: before)
            guard snapshot.conversation?.id == conversationId else {
                throw SessionError.invalidSnapshot
            }
            return snapshot
        }.deliver(completion)
    }

    func command(_ action: String, conversationId: String? = nil, payload: [String: Any] = [:],
                 completion: @escaping (Result<CommandResult, Error>) -> Void) {
        run { try self.transport.command(action, conversationId: conversationId, payload: payload) }
            .deliver(completion)
    }

    /// One page of the conversation's files.
    func artifacts(conversationId: String, offset: Int64 = 0,
                   completion: @escaping (Result<RemoteArtifactPage, Error>) -> Void) {
        run { try self.transport.artifacts(conversationId: conversationId, offset: offset) }.deliver(completion)
    }

    /// The desktop's provider bundle, for the local-chat half to adopt.
    ///
    /// Not a snapshot like the rest: it is the `camellia-api-routes` v2
    /// document, handed through untouched for `LocalChatConfiguration` to
    /// validate on the other side.
    func apiKeys(completion: @escaping (Result<[String: Any], Error>) -> Void) {
        run { try self.transport.apiKeys() }.deliver(completion)
    }

    /// Tells the desktop that the reply at `lastReplyAt` has been shown.
    ///
    /// Fire-and-forget: the answer is an acknowledgement with nothing to draw,
    /// and a failure is not worth reporting because the next snapshot carries
    /// the same information again.
    func markRead(conversationId: String, lastReplyAt: Int64) {
        run { try self.transport.markRead(conversationId: conversationId, lastReplyAt: lastReplyAt) }
            .deliver { _ in }
    }

    /// Downloads one file into a temporary destination.
    ///
    /// The expected size is passed through so a transfer cut short is reported
    /// as a failure rather than written out as a truncated file — the desktop
    /// states the size in its listing and the two must agree.
    func downloadArtifact(conversationId: String, hash: String, expectedSize: Int64, to destination: URL,
                          progress: @escaping (Int64, Int64) -> Void,
                          completion: @escaping (Result<URL, Error>) -> Void) -> ArtifactTransfer {
        let transfer = ArtifactTransfer()
        let id = UUID()
        lock.lock()
        let ticket = generation
        artifactTransfers[id] = transfer
        lock.unlock()
        downloadQueue.async {
            let result: Result<URL, Error>
            do {
                try transfer.check()
                guard self.isCurrent(ticket) else { throw ArtifactTransfer.Failure.cancelled }
                try self.transport.artifact(conversationId: conversationId, hash: hash,
                                            expectedSize: expectedSize, to: destination,
                                            transfer: transfer, progress: { received, total in
                    DispatchQueue.main.async {
                        if self.isCurrent(ticket), (try? transfer.check()) != nil {
                            progress(received, total)
                        }
                    }
                })
                try transfer.check()
                guard self.isCurrent(ticket) else { throw ArtifactTransfer.Failure.cancelled }
                result = .success(destination)
            } catch {
                result = .failure(error)
            }
            self.lock.lock()
            self.artifactTransfers.removeValue(forKey: id)
            self.lock.unlock()
            DispatchQueue.main.async {
                // Even a stale result must reach AppModel so it can remove the
                // private export folder. Never hand an old computer's file to
                // the current screen as a success.
                let active = self.isCurrent(ticket) && (try? transfer.check()) != nil
                completion(active ? result : .failure(ArtifactTransfer.Failure.cancelled))
            }
        }
        return transfer
    }

    // MARK: - Streams

    /// Keeps a snapshot stream open, reconnecting until told to stop.
    ///
    /// Android falls back to polling only when the list event endpoint returns
    /// 404 before its first snapshot. Detail 404s and failures of an already
    /// established list stream are terminal; other failures retry with backoff.
    func watch(conversationId: String?,
               onSnapshot: @escaping (RemoteSnapshot) -> Void,
               onState: @escaping (RemoteStreamState) -> Void) {
        watch(conversationId: conversationId, onSnapshot: onSnapshot,
              onState: onState, onListEvent: nil)
    }

    /// A list event is complete only after its list request has completed.
    /// Android performs that request inside the SSE listener; this receipt
    /// preserves the same success/failure and retry ordering without putting
    /// the blocking stream on the one-shot request queue.
    func watchList(onEvent: @escaping (RemoteSnapshot, Bool, @escaping (Result<Void, Error>) -> Void) -> Void,
                   onState: @escaping (RemoteStreamState) -> Void) {
        watch(conversationId: nil, onSnapshot: { _ in },
              onState: onState, onListEvent: onEvent)
    }

    private func watch(conversationId: String?,
                       onSnapshot: @escaping (RemoteSnapshot) -> Void,
                       onState: @escaping (RemoteStreamState) -> Void,
                       onListEvent: ((RemoteSnapshot, Bool, @escaping (Result<Void, Error>) -> Void) -> Void)?) {
        invalidate()
        lock.lock()
        watching = true
        let ticket = generation
        lock.unlock()
        let path = conversationId.map { "/v1/conversations/\($0)/events" } ?? "/v1/conversations/events"
        // Its own queue, never the one-shot queue: this block does not return
        // until the person leaves the screen.
        streamQueue.async { [weak self] in
            guard let self = self else { return }
            let coalescer = conversationId.map { _ in
                SnapshotCoalescer { [weak self] snapshot in
                    guard let self, self.isWatching(ticket) else { return }
                    onSnapshot(snapshot)
                }
            }
            if let coalescer {
                guard self.adopt(coalescer, ticket: ticket) else { coalescer.cancel(); return }
            }
            defer { coalescer?.cancel(); self.disown(coalescer) }
            var backoff = RemoteBackoff()
            while self.isWatching(ticket) {
                var received = false
                var announced = false
                var streamOpened = false
                var failure: Error?
                do {
                    let handle = try self.transport.stream(path)
                    guard self.adopt(handle, ticket: ticket) else { handle.cancel(); return }
                    var reader = SseReader()
                    try handle.run { chunk in
                        let payloads = try reader.consume(chunk)
                        for payload in payloads {
                            guard let body = try? JSONBody.object(Data(payload.utf8)) else {
                                throw SessionError.invalidSnapshot
                            }
                            let snapshot = RemoteSnapshot(body)
                            let firstEvent = !streamOpened
                            if conversationId == nil { streamOpened = true }
                            if let onListEvent {
                                let maySkipUnchanged = firstEvent && backoff.attempts == 0
                                let receipt = ListEventReceipt()
                                guard self.adopt(receipt, ticket: ticket) else {
                                    throw ListEventReceipt.WaitFailure.cancelled
                                }
                                DispatchQueue.main.async {
                                    guard self.isWatching(ticket) else { receipt.cancel(); return }
                                    onListEvent(snapshot, maySkipUnchanged) { receipt.finish($0) }
                                }
                                defer { self.disown(receipt) }
                                try receipt.wait()
                                received = true
                                if !announced {
                                    announced = true
                                    DispatchQueue.main.async {
                                        if self.isWatching(ticket) { onState(.connected) }
                                    }
                                }
                                continue
                            }
                            received = true
                            if let conversationId,
                               snapshot.conversation?.id != conversationId { continue }
                            // Android marks the connection usable while
                            // applying a snapshot, not before it. Deliver the
                            // snapshot first so controls see its permission.
                            let first = !announced
                            announced = true
                            if let coalescer {
                                guard coalescer.offer(snapshot, immediate: first) else {
                                    throw ListEventReceipt.WaitFailure.cancelled
                                }
                                if first {
                                    DispatchQueue.main.async {
                                        if self.isWatching(ticket) { onState(.connected) }
                                    }
                                }
                            } else {
                                DispatchQueue.main.async {
                                    guard self.isWatching(ticket) else { return }
                                    onSnapshot(snapshot)
                                    if first, self.isWatching(ticket) { onState(.connected) }
                                }
                            }
                        }
                    }
                } catch {
                    failure = error
                }
                if let coalescer, !coalescer.flush() { return }
                self.disown(ticket: ticket)
                guard self.isWatching(ticket) else { return }
                // The HTTP status, whatever produced it: this layer must not
                // know about `RemoteApi`, which needs the tunnel framework.
                let status = (failure as? RemoteHttpError)?.status
                if status == 404, conversationId == nil, !streamOpened {
                    DispatchQueue.main.async {
                        if self.isWatching(ticket) { onState(.unsupported) }
                    }
                    return
                }
                // Command failures have a broader non-retryable 4xx policy.
                // Android's event streams stop only for these three statuses;
                // a 409 or other refusal may clear on the next connection.
                if status == 401 || status == 403 || status == 404 {
                    DispatchQueue.main.async {
                        if self.isWatching(ticket) { onState(.failed(failure)) }
                    }
                    return
                }
                let delay = backoff.next(after: status, received: received)
                DispatchQueue.main.async {
                    if self.isWatching(ticket) { onState(.reconnecting(delay, failure)) }
                }
                // A plain sleep here makes the *next* screen wait behind this
                // old stream's 60-second 429 backoff. Invalidation wakes it.
                self.waitForRetry(delay, ticket: ticket)
            }
        }
    }

    // MARK: - Plumbing

    /// Whether this round is still the one the screen is waiting for.
    private func isWatching(_ ticket: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return watching && ticket == generation
    }

    private func waitForRetry(_ delay: TimeInterval, ticket: Int) {
        let deadline = ProcessInfo.processInfo.systemUptime + delay
        lock.lock()
        while watching && ticket == generation {
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { break }
            lock.wait(until: Date().addingTimeInterval(remaining))
        }
        lock.unlock()
    }

    /// Publishes a freshly opened stream unless it was cancelled while dialling.
    private func adopt(_ handle: RemoteStreamHandle, ticket: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard watching, generation == ticket else { return false }
        stream = handle
        return true
    }

    private func adopt(_ receipt: ListEventReceipt, ticket: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard watching, generation == ticket else { return false }
        listReceipt = receipt
        return true
    }

    private func adopt(_ coalescer: SnapshotCoalescer, ticket: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard watching, generation == ticket else { return false }
        detailCoalescer = coalescer
        return true
    }

    private func disown(_ coalescer: SnapshotCoalescer?) {
        lock.lock()
        if detailCoalescer === coalescer { detailCoalescer = nil }
        lock.unlock()
    }

    private func disown(_ receipt: ListEventReceipt) {
        lock.lock()
        if listReceipt === receipt { listReceipt = nil }
        lock.unlock()
    }

    private func disown(ticket: Int) {
        lock.lock()
        if generation == ticket { stream = nil }
        lock.unlock()
    }

    /// Runs `work` off the main thread and returns a value tagged with the
    /// generation it belongs to, so a stale answer can be dropped.
    private func run<T>(_ work: @escaping () throws -> T) -> Pending<T> {
        lock.lock()
        let ticket = generation
        lock.unlock()
        let queue = self.queue
        return Pending { completion in
            queue.async { [weak self] in
                guard let self = self else { return }
                // Invalidation must also stop work that was still queued, not
                // only hide its eventual answer. A queued command could
                // otherwise reach the desktop after leaving this computer.
                guard self.isCurrent(ticket) else { return }
                do {
                    let value = try work()
                    guard self.isCurrent(ticket) else { return }
                    DispatchQueue.main.async {
                        if self.isCurrent(ticket) { completion(.success(value)) }
                    }
                } catch {
                    guard self.isCurrent(ticket) else { return }
                    DispatchQueue.main.async {
                        if self.isCurrent(ticket) { completion(.failure(error)) }
                    }
                }
            }
        }
    }

    private func isCurrent(_ ticket: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return ticket == generation
    }
}

/// What the event stream is doing, which the screen shows as a status line.
enum RemoteStreamState {
    case idle
    case connected
    case reconnecting(TimeInterval, Error?)
    case unsupported
    case failed(Error?)
}

private struct Pending<T> {
    let submit: (@escaping (Result<T, Error>) -> Void) -> Void

    func deliver(_ completion: @escaping (Result<T, Error>) -> Void) {
        submit(completion)
    }
}

/// Waits for the list fetch associated with one SSE event. Invalidation wakes
/// it even when the request's completion was dropped as stale.
private final class ListEventReceipt {
    enum WaitFailure: Error { case cancelled }

    private let condition = NSCondition()
    private var outcome: Result<Void, Error>?
    private var cancelled = false

    func finish(_ result: Result<Void, Error>) {
        condition.lock()
        if outcome == nil && !cancelled {
            outcome = result
            condition.broadcast()
        }
        condition.unlock()
    }

    func cancel() {
        condition.lock()
        cancelled = true
        condition.broadcast()
        condition.unlock()
    }

    func wait() throws {
        condition.lock()
        while outcome == nil && !cancelled { condition.wait() }
        let result = outcome
        let wasCancelled = cancelled
        condition.unlock()
        if wasCancelled { throw WaitFailure.cancelled }
        guard let result else { throw WaitFailure.cancelled }
        try result.get()
    }
}
