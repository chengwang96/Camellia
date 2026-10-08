import Foundation

/// Runs the two read-only web tools for the local tool loop.
///
/// Ported from `LocalWebTools.java`, minus jsoup — the parsing it needs lives in
/// `LocalWebTools`, and this file is the network half: resolve, fetch, bound,
/// and hand the bytes back for parsing.
///
/// It is the security boundary for the tool loop. The model chooses the URL, so
/// every request goes through the same gate: public HTTPS only, the fragment
/// dropped, no redirects followed beyond three checked hops, an allow-list of
/// content types, and a byte cap enforced as the body arrives rather than after
/// it has been buffered. The one protection it shares less cleanly than Android
/// is DNS: OkHttp lets Android filter the addresses a name resolves to inside
/// the connection, while `URLSession` resolves its own, so this pre-checks the
/// name and accepts the small window that leaves.
public final class LocalWebExecutor: LocalToolExecuting {
    private let session: URLSession
    private let redirects = RejectRedirects()
    private let lock = NSLock()
    private var _cancelled = false

    public init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.connectionProxyDictionary = [:]
        session = URLSession(configuration: configuration)
    }

    public func cancel() {
        lock.lock()
        _cancelled = true
        lock.unlock()
        // The executor is created per tool run, so tearing the session down is
        // the surest way to stop an in-flight page — and it is what Android
        // does when it cancels every call on its dispatcher.
        session.invalidateAndCancel()
    }

    public func execute(_ name: String, _ arguments: [String: Any]) async throws -> [String: Any] {
        try LocalToolLoop.validate(name, arguments)
        try ensureLive()
        if name == "web_search" {
            guard let query = arguments["query"] as? String else { throw LocalToolError.invalidArguments }
            return try await search(query)
        }
        guard let raw = arguments["url"] as? String else { throw LocalToolError.invalidArguments }
        let url = try LocalWebTools.publicURL(raw)
        let body = try await fetch(url, limit: LocalWebTools.maxFetchBytes)
        return try LocalWebTools.fetchResult(url: url.absoluteString, html: body)
    }

    /// Bing's RSS feed first, then Baidu's HTML, then give up.
    ///
    /// The feed is the reliable half — one `<item>` per result — and the HTML
    /// provider is the fallback for when it is blocked or empty. A failure of
    /// one is not a failure of the search.
    private func search(_ query: String) async throws -> [String: Any] {
        if let url = bing(query),
           let body = try? await fetch(url, limit: LocalWebTools.maxFetchBytes),
           let results = try? LocalWebTools.rssResults(xml: body, baseURL: url.absoluteString) {
            return LocalWebTools.searchResult(results)
        }
        try ensureLive()
        if let url = baidu(query),
           let body = try? await fetch(url, limit: LocalWebTools.maxSearchBytes),
           let results = try? LocalWebTools.searchResults(html: body, baseURL: url.absoluteString) {
            return LocalWebTools.searchResult(results)
        }
        try ensureLive()
        throw LocalWebError.searchUnavailable
    }

    private func bing(_ query: String) -> URL? {
        var components = URLComponents(string: "https://www.bing.com/search")
        components?.queryItems = [URLQueryItem(name: "format", value: "rss"),
                                  URLQueryItem(name: "q", value: query)]
        return components?.url
    }

    private func baidu(_ query: String) -> URL? {
        var components = URLComponents(string: "https://www.baidu.com/s")
        components?.queryItems = [URLQueryItem(name: "wd", value: query),
                                  URLQueryItem(name: "rn", value: "5")]
        return components?.url
    }

    /// Fetches one page, following at most a few checked redirects.
    private func fetch(_ url: URL, limit: Int, redirects depth: Int = 0) async throws -> String {
        try ensureLive()
        // Re-validating here rather than trusting the caller is deliberate: the
        // redirect path is the one place a public URL becomes a private one.
        let canonical = try LocalWebTools.publicURL(url.absoluteString)
        if let host = canonical.host,
           let resolves = LocalWebTools.resolvesPubliclyOnly(host), resolves == false {
            throw LocalWebError.nonPublicAddress
        }
        var request = URLRequest(url: canonical)
        request.setValue("Camellia-iOS/LocalWebTools", forHTTPHeaderField: "User-Agent")
        request.setValue("application/rss+xml, application/xml, text/xml, text/html, text/plain",
                         forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: request, delegate: redirects)
        try ensureLive()
        guard let http = response as? HTTPURLResponse else { throw LocalChatTransportError.notHTTP }

        if (300..<400).contains(http.statusCode) {
            let location = http.value(forHTTPHeaderField: "Location") ?? ""
            guard depth < LocalWebTools.maxRedirects,
                  let next = URL(string: location, relativeTo: canonical),
                  let checked = try? LocalWebTools.publicURL(next.absoluteString) else {
                throw LocalWebError.unsafeRedirect
            }
            return try await fetch(checked, limit: limit, redirects: depth + 1)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw LocalChatError.transport("Web request failed with HTTP \(http.statusCode)")
        }
        let type = (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
        guard type.hasPrefix("text/html") || type.hasPrefix("text/plain")
            || type.hasPrefix("text/xml") || type.hasPrefix("application/xml")
            || type.hasPrefix("application/rss+xml") else {
            throw LocalWebError.unsupportedContent
        }
        if http.expectedContentLength > Int64(limit) { throw LocalWebError.pageTooLarge }

        var data: [UInt8] = []
        var iterator = bytes.makeAsyncIterator()
        while let byte = try await iterator.next() {
            try ensureLive()
            if data.count + 1 > limit { throw LocalWebError.pageTooLarge }
            data.append(byte)
        }
        try ensureLive()
        return String(decoding: data, as: UTF8.self)
    }

    private func ensureLive() throws {
        lock.lock(); defer { lock.unlock() }
        if _cancelled { throw LocalChatError.cancelled }
    }
}
