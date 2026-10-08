import Foundation

/// The calls one paired computer answers, as `RemoteSession` sees them.
///
/// `RemoteSession` schedules the work — one queue for one-shot requests, a
/// second for the long-lived stream — and this is the seam that lets that
/// scheduling be exercised without a tunnel. `RemoteApi` is the only
/// implementation that ships: it dials the selected network route. Splitting it out is
/// not ceremony, it is what let the queue starvation below be reproduced in a
/// test rather than argued about:
///
/// `RemoteSession.watch` holds a queue for as long as a stream is open, and a
/// stream stays open until it is cancelled. When that queue was the *same* one
/// every one-shot request was submitted to, opening the conversation list
/// starved the list's own fetch: `refreshList()` never ran, `listLoading`
/// stayed true, and the screen showed an empty list with no explanation. The
/// desktop client never had the bug because Android runs its streams on a
/// two-thread pool, so one long-lived stream leaves a thread free.
public protocol RemoteTransport: AnyObject {
    /// Permanently closes ordinary requests when this computer session ends.
    func cancel()
    /// Closes the current ordinary request but keeps this transport reusable.
    func cancelCurrentRequest()
    func status() throws -> RemoteStatus
    func conversations(offset: Int) throws -> RemoteListPage
    func conversation(id: String, before: Int64?) throws -> RemoteSnapshot
    func command(_ action: String, conversationId: String?, payload: [String: Any]) throws -> CommandResult
    func artifacts(conversationId: String, offset: Int64) throws -> RemoteArtifactPage
    func apiKeys() throws -> [String: Any]
    func markRead(conversationId: String, lastReplyAt: Int64) throws -> JSONObject
    func artifact(conversationId: String, hash: String, expectedSize: Int64) throws -> Data
    func artifact(conversationId: String, hash: String, expectedSize: Int64, to destination: URL,
                  transfer: ArtifactTransfer, progress: @escaping (Int64, Int64) -> Void) throws
    func stream(_ path: String) throws -> RemoteStreamHandle
}

public extension RemoteTransport {
    /// A default for test transports; the shipping transport overrides this
    /// with a bounded-memory stream straight to the destination file.
    func artifact(conversationId: String, hash: String, expectedSize: Int64, to destination: URL,
                  transfer: ArtifactTransfer, progress: @escaping (Int64, Int64) -> Void) throws {
        try transfer.check()
        let data = try artifact(conversationId: conversationId, hash: hash, expectedSize: expectedSize)
        try transfer.check()
        try data.write(to: destination, options: .atomic)
        progress(Int64(data.count), expectedSize)
    }
}

/// One ordinary HTTP request's abort hook. Cancellation also covers the gap
/// before the transport has opened: a late install is closed immediately.
public final class RemoteRequestCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var generation = 0
    private var abort: (() -> Void)?

    public init() {}

    public func ticket() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return generation
    }

    @discardableResult
    public func install(_ close: @escaping () -> Void) -> Bool {
        install(close, ticket: ticket())
    }

    @discardableResult
    public func install(_ close: @escaping () -> Void, ticket: Int) -> Bool {
        lock.lock()
        if cancelled || ticket != generation {
            lock.unlock()
            close()
            return false
        }
        abort = close
        lock.unlock()
        return true
    }

    public func clear() {
        clear(ticket: ticket())
    }

    public func clear(ticket: Int) {
        lock.lock()
        if ticket == generation { abort = nil }
        lock.unlock()
    }

    public func cancelCurrent() {
        lock.lock()
        generation += 1
        let close = abort
        abort = nil
        lock.unlock()
        close?()
    }

    public func cancel() {
        lock.lock()
        guard !cancelled else { lock.unlock(); return }
        cancelled = true
        generation += 1
        let close = abort
        abort = nil
        lock.unlock()
        close?()
    }
}

/// One file transfer's cancellation, independent of the conversation stream.
/// The transport installs the socket/task closer when it opens the response.
public final class ArtifactTransfer {
    public enum Failure: Error, Equatable { case cancelled }

    private let lock = NSLock()
    private var cancelled = false
    private var abort: (() -> Void)?

    public init() {}

    public func cancel() {
        lock.lock()
        guard !cancelled else { lock.unlock(); return }
        cancelled = true
        let close = abort
        lock.unlock()
        close?()
    }

    public func check() throws {
        lock.lock()
        let stopped = cancelled
        lock.unlock()
        if stopped { throw Failure.cancelled }
    }

    public func setAbort(_ close: @escaping () -> Void) {
        lock.lock()
        abort = close
        let stopped = cancelled
        lock.unlock()
        if stopped { close() }
    }

    public func clearAbort() {
        lock.lock()
        abort = nil
        lock.unlock()
    }
}

/// An open stream, and the two things a caller may do with it.
///
/// `run` blocks the calling thread until the stream ends, is cancelled, or
/// fails — which is exactly why the queue it runs on must not be shared with
/// anything that is waiting for an answer.
public protocol RemoteStreamHandle: AnyObject {
    func run(onChunk: @escaping (Data) throws -> Void) throws
    func cancel()
}
