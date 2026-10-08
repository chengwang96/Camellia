import Foundation

/// HTTP over the system route, used only when the person selects an external
/// Tailscale VPN. The caller has already validated the destination as a
/// literal 100.64.0.0/10 address and an allowlisted Camellia path.
///
/// A delegate is used instead of URLSession's completion handler so a desktop
/// cannot make a response larger than the protocol ceiling, and an SSE stream
/// reaches its reader a chunk at a time rather than waiting for EOF.
final class ExternalHTTP: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    static let maximumBodyBytes = 8 * 1024 * 1024
    static let maximumErrorBytes = 16 * 1024

    enum Failure: Error {
        case cancelled
        case missingResponse
        case unexpectedContentType
        case sizeChanged
        case tooLarge
    }

    enum Mode {
        case body
        case stream
    }

    private let request: URLRequest
    private let expectedContentType: String
    private let expectedLength: Int64?
    private let mode: Mode
    private let configuration: URLSessionConfiguration
    private let condition = NSCondition()
    private var task: URLSessionDataTask?
    private var response: HTTPURLResponse?
    private var body = Data()
    private var receivedError: Error?
    private var finished = false
    private var cancelled = false
    private var chunkInFlight = false
    private var onChunk: ((Data) throws -> Void)?

    init(request: URLRequest, expectedContentType: String, mode: Mode,
         expectedLength: Int64? = nil,
         configuration: URLSessionConfiguration = ExternalHTTP.configuration()) {
        self.request = request
        self.expectedContentType = expectedContentType
        self.expectedLength = expectedLength
        self.mode = mode
        self.configuration = configuration
    }

    static func configuration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        // Mirror Android's Proxy.NO_PROXY: the 100.x gateway and its bearer
        // token must go through the system VPN route, never an HTTP proxy.
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 25
        return config
    }

    func run(onChunk: ((Data) throws -> Void)? = nil) throws -> (status: Int, body: Data) {
        condition.lock()
        if cancelled {
            condition.unlock()
            throw Failure.cancelled
        }
        self.onChunk = onChunk
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        let started = session.dataTask(with: request)
        task = started
        started.resume()
        // A cancellation may arrive while the delegate is writing a chunk to
        // disk. Do not let the caller close/remove that file until its writer
        // has returned.
        while !finished || chunkInFlight { condition.wait() }
        let result = (response, body, receivedError, cancelled)
        condition.unlock()
        session.invalidateAndCancel()

        if result.3 { throw Failure.cancelled }
        if let error = result.2 { throw error }
        guard let response = result.0 else { throw Failure.missingResponse }
        return (response.statusCode, result.1)
    }

    func cancel() {
        condition.lock()
        cancelled = true
        finished = true
        condition.broadcast()
        let running = task
        condition.unlock()
        running?.cancel()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // A redirect could leave the tailnet allowlist; never follow it.
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        condition.lock()
        guard !cancelled else {
            condition.unlock()
            completionHandler(.cancel)
            return
        }
        self.response = response as? HTTPURLResponse
        if let http = self.response, http.statusCode == 200,
           !(response.mimeType ?? "").lowercased().hasPrefix(expectedContentType) {
            receivedError = Failure.unexpectedContentType
            finished = true
            condition.broadcast()
            condition.unlock()
            completionHandler(.cancel)
            return
        }
        if self.response?.statusCode == 200, let expectedLength,
           response.expectedContentLength != expectedLength {
            receivedError = Failure.sizeChanged
            finished = true
            condition.broadcast()
            condition.unlock()
            completionHandler(.cancel)
            return
        }
        condition.unlock()
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        condition.lock()
        guard !cancelled, !finished else { condition.unlock(); return }
        let status = response?.statusCode ?? 0
        if status != 200 {
            let room = max(0, Self.maximumErrorBytes - body.count)
            body.append(data.prefix(room))
            if data.count > room {
                finished = true
                condition.broadcast()
                condition.unlock()
                dataTask.cancel()
                return
            }
        } else if case .body = mode {
            if body.count > Self.maximumBodyBytes - data.count {
                receivedError = Failure.tooLarge
                finished = true
                condition.broadcast()
                condition.unlock()
                dataTask.cancel()
                return
            }
            body.append(data)
        } else {
            let handler = onChunk
            chunkInFlight = true
            condition.unlock()
            do {
                try handler?(data)
            } catch {
                condition.lock()
                receivedError = error
                finished = true
                chunkInFlight = false
                condition.broadcast()
                condition.unlock()
                dataTask.cancel()
                return
            }
            condition.lock()
            chunkInFlight = false
            condition.broadcast()
            condition.unlock()
            return
        }
        condition.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        condition.lock()
        if !finished {
            receivedError = error
            finished = true
            condition.broadcast()
        }
        condition.unlock()
    }
}
