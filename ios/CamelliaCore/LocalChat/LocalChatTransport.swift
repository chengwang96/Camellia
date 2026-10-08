import Foundation

/// One HTTP request the local-chat client wants sent.
///
/// Local chat is the one path that talks to a provider directly rather than
/// through the desktop's tunnel, so it owns its own transport — and splitting
/// that transport behind a protocol is what keeps the client's real decisions
/// (which key to try, how an SSE stream is read, when the tool loop stops)
/// checkable on the host without a network. The client builds the headers,
/// including the credential, so the transport never sees a key it has to know
/// how to place.
public struct LocalChatHTTPRequest: Sendable {
    public let url: URL
    public let headers: [String: String]
    public let body: Data

    public init(url: URL, headers: [String: String], body: Data) {
        self.url = url
        self.headers = headers
        self.body = body
    }
}

/// A response head and the body as it arrives.
///
/// The body is an `AsyncThrowingStream` of bytes rather than `Data` because the
/// whole point of the chat path is that it streams: a thinking token or a text
/// delta has to reach the screen before the reply is finished, and one that
/// only arrives at the end is the same as no streaming at all. A failing
/// stream — a dropped connection mid-reply — throws, so it cannot be mistaken
/// for a clean end of stream.
/// A response body is consumed by one chat attempt, using one iterator.
public struct LocalChatHTTPResponse {
    public let status: Int
    public let contentType: String?
    public let host: String
    public let bytes: AsyncThrowingStream<UInt8, Error>

    public init(status: Int, contentType: String?, host: String,
                bytes: AsyncThrowingStream<UInt8, Error>) {
        self.status = status
        self.contentType = contentType
        self.host = host
        self.bytes = bytes
    }
}

/// Sending one request and streaming its response.
public protocol LocalChatTransporting: AnyObject {
    func send(_ request: LocalChatHTTPRequest) async throws -> LocalChatHTTPResponse
    func cancel()
}

public enum LocalChatTransportError: Error, Equatable, CustomStringConvertible {
    case notHTTP
    case unavailable

    public var description: String {
        switch self {
        case .notHTTP: return "服务商返回了非 HTTP 响应 / Provider returned a non-HTTP response"
        case .unavailable: return "无法连接到服务商 / Could not reach the provider"
        }
    }
}

/// Refuses every redirect, for both the chat request and the web tools.
///
/// Android sets `setInstanceFollowRedirects(false)` on the chat connection and
/// `followRedirects(false)` on the web client, and the chat side depends on it:
/// a 3xx is reported to the user as "the API address redirected, not followed
/// to protect the credential" rather than being quietly chased to whatever host
/// the provider names. iOS has no configuration-level switch for this, so it is
/// a task delegate that answers `nil`.
final class RejectRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// The real transport: `URLSession`, direct to the provider.
public final class URLSessionChatTransport: LocalChatTransporting {
    private let session: URLSession
    private let redirects = RejectRedirects()

    public init() {
        let configuration = URLSessionConfiguration.ephemeral
        // 120 s between bytes matches Android's read timeout. The tool loop
        // has a separate 180 s deadline; the 300 s resource timeout bounds a
        // plain chat request if it keeps sending bytes without completing.
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 300
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        // No proxy: Android pins `Proxy.NO_PROXY`, and a phone that is told to
        // use a corporate proxy should not send API credentials through it.
        configuration.connectionProxyDictionary = [:]
        session = URLSession(configuration: configuration)
    }

    public func send(_ request: LocalChatHTTPRequest) async throws -> LocalChatHTTPResponse {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = "POST"
        urlRequest.httpBody = request.body
        for (field, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: field)
        }
        let (bytes, response): (URLSession.AsyncBytes, URLResponse)
        do {
            (bytes, response) = try await session.bytes(for: urlRequest, delegate: redirects)
        } catch {
            throw LocalChatTransportError.unavailable
        }
        guard let http = response as? HTTPURLResponse else {
            throw LocalChatTransportError.notHTTP
        }
        return LocalChatHTTPResponse(
            status: http.statusCode,
            contentType: http.value(forHTTPHeaderField: "Content-Type"),
            host: http.url?.host ?? request.url.host ?? "",
            bytes: Self.bridge(bytes))
    }

    public func cancel() {
        session.invalidateAndCancel()
    }

    /// One consumer pulls directly from the session iterator. There is no
    /// producer task or extra byte queue. Dropping the body closes its task.
    private static func bridge(_ bytes: URLSession.AsyncBytes) -> AsyncThrowingStream<UInt8, Error> {
        let task = bytes.task
        return LocalChatBody.pull(bytes) { task.cancel() }
    }
}

/// Streams a fixed set of bytes, for checks and for anything that has already
/// read the body.
public enum LocalChatBody {
    /// The chat client owns one iterator for a response; that ownership also
    /// confines the boxed source iterator across its suspending next() calls.
    static func pull<Source: AsyncSequence>(_ source: Source, onFinish: @escaping @Sendable () -> Void = {})
        -> AsyncThrowingStream<UInt8, Error> where Source.Element == UInt8 {
        let reader = LocalChatPullReader(source.makeAsyncIterator(), onFinish: onFinish)
        return AsyncThrowingStream(unfolding: { try await reader.next() })
    }

    public static func stream(_ bytes: [UInt8]) -> AsyncThrowingStream<UInt8, Error> {
        pull(LocalChatFixedBytes(bytes: bytes, error: nil))
    }

    public static func text(_ value: String) -> AsyncThrowingStream<UInt8, Error> {
        stream(Array(value.utf8))
    }

    /// A stream that yields `bytes` and then fails, for an interrupted reply.
    public static func failing(after bytes: [UInt8], _ error: Error) -> AsyncThrowingStream<UInt8, Error> {
        pull(LocalChatFixedBytes(bytes: bytes, error: error))
    }
}

/// Single-consumer ownership is part of LocalChatHTTPResponse's contract.
/// No task besides that consumer accesses the mutable iterator.
private final class LocalChatPullReader<Iterator: AsyncIteratorProtocol>: @unchecked Sendable where Iterator.Element == UInt8 {
    private var iterator: Iterator
    private var onFinish: (@Sendable () -> Void)?

    init(_ iterator: Iterator, onFinish: @escaping @Sendable () -> Void) {
        self.iterator = iterator
        self.onFinish = onFinish
    }

    func next() async throws -> UInt8? {
        do {
            try Task.checkCancellation()
            let byte = try await iterator.next()
            try Task.checkCancellation()
            if byte == nil { finish() }
            return byte
        } catch {
            finish()
            throw error
        }
    }

    private func finish() { let callback = onFinish; onFinish = nil; callback?() }
    deinit { onFinish?() }
}

private struct LocalChatFixedBytes: AsyncSequence {
    typealias Element = UInt8
    let bytes: [UInt8]
    let error: Error?
    struct AsyncIterator: AsyncIteratorProtocol {
        let bytes: [UInt8]
        let error: Error?
        var index = 0
        mutating func next() async throws -> UInt8? {
            guard index < bytes.count else {
                if let error { throw error }
                return nil
            }
            defer { index += 1 }
            return bytes[index]
        }
    }
    func makeAsyncIterator() -> AsyncIterator { AsyncIterator(bytes: bytes, error: error) }
}
