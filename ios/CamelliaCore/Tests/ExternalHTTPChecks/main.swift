import Foundation

private var checks = 0

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else { fatalError(message) }
    checks += 1
}

private final class StubProtocol: URLProtocol {
    static var answer: (status: Int, contentType: String, chunks: [Data]) = (200, "application/json", [])
    static var declaredLength: Int64?
    static var lastRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastRequest = request
        let answer = Self.answer
        var headers = ["Content-Type": answer.contentType]
        if let declaredLength = Self.declaredLength {
            headers["Content-Length"] = String(declaredLength)
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.status,
                                       httpVersion: "HTTP/1.1",
                                       headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in answer.chunks { client?.urlProtocol(self, didLoad: chunk) }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private let configuration: URLSessionConfiguration = {
    let configuration = ExternalHTTP.configuration()
    configuration.protocolClasses = [StubProtocol.self]
    return configuration
}()
check(configuration.connectionProxyDictionary?.isEmpty == true, "system HTTP proxies are not inherited")

private func request(_ method: String = "GET") -> URLRequest {
    var request = URLRequest(url: URL(string: "http://100.64.0.1:43127/v1/status")!)
    request.httpMethod = method
    request.setValue("Bearer test-token", forHTTPHeaderField: "Authorization")
    return request
}

// A desktop response cannot redirect an authenticated request outside the
// tailnet. Background URLSession cannot enforce this delegate policy, which is
// why these requests must remain on the foreground transport.
let redirectClient = ExternalHTTP(request: request(), expectedContentType: "application/json",
                                  mode: .body, configuration: configuration)
let redirect = HTTPURLResponse(url: request().url!, statusCode: 302, httpVersion: "HTTP/1.1",
                               headerFields: ["Location": "https://example.invalid/steal"])!
var followed: URLRequest? = request()
redirectClient.urlSession(URLSession.shared, task: URLSession.shared.dataTask(with: request()),
                          willPerformHTTPRedirection: redirect,
                          newRequest: URLRequest(url: URL(string: "https://example.invalid/steal")!)) {
    followed = $0
}
check(followed == nil, "authenticated requests refuse redirects")

StubProtocol.answer = (200, "application/json; charset=utf-8", [Data("{\"ok\":".utf8), Data("true}".utf8)])
let success = try ExternalHTTP(request: request(), expectedContentType: "application/json",
                               mode: .body, configuration: configuration).run()
check(success.status == 200, "successful status is returned")
check(String(decoding: success.body, as: UTF8.self) == "{\"ok\":true}", "body chunks are joined")
check(StubProtocol.lastRequest?.value(forHTTPHeaderField: "Authorization") == "Bearer test-token",
      "authorization header survives the system transport")

StubProtocol.answer = (403, "application/json", [Data("forbidden".utf8)])
let denied = try ExternalHTTP(request: request(), expectedContentType: "application/json",
                              mode: .body, configuration: configuration).run()
check(denied.status == 403, "HTTP failures remain available to the API error policy")
check(String(decoding: denied.body, as: UTF8.self) == "forbidden", "HTTP failure detail is kept")

StubProtocol.answer = (502, "text/plain", [Data(repeating: 0x61, count: ExternalHTTP.maximumErrorBytes + 20)])
let gateway = try ExternalHTTP(request: request(), expectedContentType: "application/json",
                               mode: .body, configuration: configuration).run()
check(gateway.status == 502, "gateway error status survives a long error body")
check(gateway.body.count == ExternalHTTP.maximumErrorBytes, "gateway error detail is capped")

StubProtocol.answer = (200, "application/octet-stream", [Data([0, 1, 2, 255])])
let artifact = try ExternalHTTP(request: request(), expectedContentType: "application/octet-stream",
                                mode: .body, configuration: configuration).run()
check(artifact.body == Data([0, 1, 2, 255]), "binary artifact bytes are kept intact")

StubProtocol.declaredLength = 4
let sized = try ExternalHTTP(request: request(), expectedContentType: "application/octet-stream",
                             mode: .stream, expectedLength: 4, configuration: configuration).run { _ in }
check(sized.status == 200, "a file with the advertised length is accepted")
StubProtocol.declaredLength = 5
do {
    _ = try ExternalHTTP(request: request(), expectedContentType: "application/octet-stream",
                         mode: .stream, expectedLength: 4, configuration: configuration).run { _ in }
    fatalError("a changed file length was accepted")
} catch ExternalHTTP.Failure.sizeChanged {
    checks += 1
}
StubProtocol.declaredLength = nil
do {
    _ = try ExternalHTTP(request: request(), expectedContentType: "application/octet-stream",
                         mode: .stream, expectedLength: 4, configuration: configuration).run { _ in }
    fatalError("a missing file length was accepted")
} catch ExternalHTTP.Failure.sizeChanged {
    checks += 1
}

StubProtocol.answer = (200, "application/octet-stream",
                       [Data(repeating: 0x5a, count: ExternalHTTP.maximumBodyBytes + 1)])
var streamedBytes = 0
let largeFile = try ExternalHTTP(request: request(), expectedContentType: "application/octet-stream",
                                 mode: .stream, configuration: configuration).run {
    streamedBytes += $0.count
}
check(streamedBytes == ExternalHTTP.maximumBodyBytes + 1,
      "streaming a file is not subject to the JSON response ceiling")
check(largeFile.body.isEmpty, "a streamed file is not retained in the HTTP body")

StubProtocol.answer = (200, "text/html", [Data("not JSON".utf8)])
do {
    _ = try ExternalHTTP(request: request(), expectedContentType: "application/json",
                         mode: .body, configuration: configuration).run()
    fatalError("wrong content type was accepted")
} catch ExternalHTTP.Failure.unexpectedContentType {
    checks += 1
}

StubProtocol.answer = (200, "application/json", [Data(repeating: 0x61, count: ExternalHTTP.maximumBodyBytes + 1)])
do {
    _ = try ExternalHTTP(request: request(), expectedContentType: "application/json",
                         mode: .body, configuration: configuration).run()
    fatalError("oversize body was accepted")
} catch ExternalHTTP.Failure.tooLarge {
    checks += 1
}

StubProtocol.answer = (200, "text/event-stream", [Data("data: one\n\n".utf8), Data("data: two\n\n".utf8)])
var chunks = Data()
let stream = try ExternalHTTP(request: request(), expectedContentType: "text/event-stream",
                              mode: .stream, configuration: configuration).run { chunks.append($0) }
check(stream.status == 200, "event stream status is returned")
check(chunks == Data("data: one\n\ndata: two\n\n".utf8), "event bytes are delivered without buffering to EOF")

enum WriteFailure: Error { case disk }
StubProtocol.answer = (200, "application/octet-stream", [Data("chunk".utf8)])
do {
    _ = try ExternalHTTP(request: request(), expectedContentType: "application/octet-stream",
                         mode: .stream, configuration: configuration).run { _ in throw WriteFailure.disk }
    fatalError("chunk writer failure was ignored")
} catch WriteFailure.disk {
    checks += 1
}

// Cancelling a streamed file must not return the worker to its cleanup path
// while the URLSession delegate still owns a chunk writer.
StubProtocol.answer = (200, "application/octet-stream", [Data("slow chunk".utf8)])
let slow = ExternalHTTP(request: request(), expectedContentType: "application/octet-stream",
                        mode: .stream, configuration: configuration)
let writing = DispatchSemaphore(value: 0)
let release = DispatchSemaphore(value: 0)
let stopped = DispatchSemaphore(value: 0)
let outcomeLock = NSLock()
var wasCancelled = false
DispatchQueue.global().async {
    do {
        _ = try slow.run { _ in
            writing.signal()
            _ = release.wait(timeout: .now() + 3)
        }
    } catch ExternalHTTP.Failure.cancelled {
        outcomeLock.lock()
        wasCancelled = true
        outcomeLock.unlock()
    } catch {}
    stopped.signal()
}
check(writing.wait(timeout: .now() + 3) == .success, "a streamed writer starts")
slow.cancel()
check(stopped.wait(timeout: .now() + 0.05) == .timedOut,
      "cancellation waits for the active writer before cleanup")
release.signal()
check(stopped.wait(timeout: .now() + 3) == .success, "the cancelled stream then stops")
outcomeLock.lock()
let cancelledOutcome = wasCancelled
outcomeLock.unlock()
check(cancelledOutcome, "the stopped stream reports cancellation")

print("PASS: \(checks) external HTTP checks")
