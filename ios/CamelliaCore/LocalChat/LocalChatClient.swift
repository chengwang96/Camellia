import Foundation

/// What the local-chat client raises on its own behalf.
///
/// The tool loop's own refusals reuse `LocalToolError`, because those messages
/// were already written for the model and the user, and duplicating them here
/// would let the two drift. This enum is only for the pieces Android raised as
/// a bare `IOException`: a cancelled request, a body that would not fit, a
/// stream that stopped early.
public enum LocalChatError: Error, Equatable, CustomStringConvertible {
    case cancelled
    case noKeys
    case unsupportedFormat
    case tooLarge
    case eventTooLarge
    case interrupted
    case noText
    case apiError(String)
    case streamError(String)
    case transport(String)

    public var description: String {
        switch self {
        case .cancelled: return "已取消 / Cancelled"
        case .noKeys: return "没有启用的 API 密钥 / No enabled API keys"
        case .unsupportedFormat: return "API 回复格式不受支持 / Unsupported API response format"
        case .tooLarge: return "API 响应过大 / API response too large"
        case .eventTooLarge: return "API 事件过大 / API event too large"
        case .interrupted: return "回复连接中断，未自动重发 / Reply interrupted; not automatically resent"
        case .noText: return "API 未返回文字 / API returned no text"
        case .apiError(let detail): return detail
        case .streamError(let detail): return detail
        case .transport(let detail): return detail
        }
    }
}

extension LocalChatError: LocalizedError {
    public var errorDescription: String? { description }
}

/// `LocalToolError` already carries its own wording; this only makes it read
/// the same way through `localizedDescription`, which is what the screens show.
extension LocalToolError: LocalizedError {
    public var errorDescription: String? { description }
}

/// Where a reply's pieces are delivered as they arrive.
///
/// Mirrors Android's `LocalChatClient.Listener`. Every callback has a no-op
/// default so a caller that only wants the finished text — a check, or the
/// non-streaming path — can ignore the rest.
public struct LocalChatListener {
    public var onText: (String) -> Void
    public var onThinking: (String) -> Void
    /// The complete JSON response, for the non-streaming path the tool loop
    /// uses. Never called for a streamed reply.
    public var onResponse: (JSONObject) -> Void
    public var onTool: ([String: Any]) -> Void

    public init(onText: @escaping (String) -> Void = { _ in },
                onThinking: @escaping (String) -> Void = { _ in },
                onResponse: @escaping (JSONObject) -> Void = { _ in },
                onTool: @escaping ([String: Any]) -> Void = { _ in }) {
        self.onText = onText
        self.onThinking = onThinking
        self.onResponse = onResponse
        self.onTool = onTool
    }
}

/// Running one read-only web tool, for the loop to call.
public protocol LocalToolExecuting: AnyObject {
    func execute(_ name: String, _ arguments: [String: Any]) async throws -> [String: Any]
    func cancel()
}

/// The direct-to-provider chat client.
///
/// Ported from Android's `LocalChatClient` and `LocalToolLoop.run`. It is the
/// half of local chat that is not pure: it sends one request, reads the reply
/// — streamed or whole — and, when tools are on, keeps asking and answering
/// until the model stops calling them.
///
/// Two rules are load-bearing. A failed attempt only advances to the provider's
/// next key when the error says so: a wrong key is worth another try, a blocked
/// region is not, and trying anyway burns a key against the same wall. And a
/// stream that ends without a completion marker is an interruption, not a
/// finished reply — it is reported rather than saved, so a half-answer is never
/// mistaken for an answer.
/// `@unchecked Sendable`: every mutable field is held behind `lock`, and the
/// only crossing is the timeout backstop, which reads a token and cancels.
/// Nothing else about it is shared mutable state.
public final class LocalChatClient: @unchecked Sendable {
    /// Android counts UTF-16 code units (Java String.length), not wire bytes,
    /// for a buffered body, a single event and the accumulated reply.
    public static let limit = 2 * 1024 * 1024

    private let transport: LocalChatTransporting
    private let lock = NSLock()
    private var _cancelled = false
    private var _executor: LocalToolExecuting?
    private var timeoutToken = UUID()

    public init(transport: LocalChatTransporting = URLSessionChatTransport()) {
        self.transport = transport
    }

    public var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return _cancelled
    }

    /// Stops the request and everything it started.
    public func cancel() {
        lock.lock()
        _cancelled = true
        let executor = _executor
        lock.unlock()
        transport.cancel()
        executor?.cancel()
    }

    // The lock is taken in these synchronous helpers rather than at the call
    // sites, because the call sites are async and Swift flags locking directly
    // in an async context.

    private func store(executor: LocalToolExecuting?) {
        lock.lock(); _executor = executor; lock.unlock()
    }

    private func claimTimeout() -> UUID {
        lock.lock(); defer { lock.unlock() }
        let token = UUID()
        timeoutToken = token
        return token
    }

    private func timeoutIsCurrent(_ token: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return timeoutToken == token
    }

    private func clearTimeout() {
        lock.lock(); timeoutToken = UUID(); lock.unlock()
    }

    // MARK: - Building the request

    /// The body to send for a history, in the shape the route's protocol reads.
    public static func request(route: LocalChatRoute,
                               history: [[String: Any]],
                               thinking: String = "auto",
                               using resolver: LocalChatAttachmentResolving) throws -> [String: Any] {
        try LocalChatRequest.build(route: route, history: history, thinking: thinking, using: resolver)
    }

    // MARK: - Sending it

    /// Sends the body, rotating through the provider's keys on the failures
    /// that are worth a second key.
    public func chat(route: LocalChatRoute, body: [String: Any],
                     listener: LocalChatListener) async throws -> String {
        guard !route.keys.isEmpty else { throw LocalChatError.noKeys }
        var lastError: Error?
        for index in route.keys.indices {
            if isCancelled { throw LocalChatError.cancelled }
            do {
                return try await attempt(route: route, body: body, listener: listener, keyIndex: index)
            } catch let error as LocalChatHTTPError {
                if isCancelled { throw LocalChatError.cancelled }
                if !error.tryNextKey || index + 1 == route.keys.count { throw error }
                lastError = error
            }
        }
        throw lastError ?? LocalChatError.noKeys
    }

    private func attempt(route: LocalChatRoute, body: [String: Any],
                         listener: LocalChatListener, keyIndex: Int) async throws -> String {
        if isCancelled { throw LocalChatError.cancelled }
        let path = route.isAnthropic ? "/messages" : "/chat/completions"
        guard let url = URL(string: route.baseURL + path) else {
            throw LocalChatError.transport("API 地址无效 / Invalid API URL")
        }
        guard let payload = try? JSONSerialization.data(withJSONObject: body, options: [.withoutEscapingSlashes]) else {
            throw LocalChatError.transport("API 请求无法序列化 / Request could not be encoded")
        }
        guard payload.count <= LocalChatRequestBudget.maximumBytes else {
            throw LocalChatRequestError.requestTooLarge
        }
        let key = route.keys[keyIndex]
        var headers = [
            "Content-Type": "application/json",
            "Accept": "text/event-stream, application/json",
            "User-Agent": "Camellia-iOS/LocalChat",
            "Authorization": "Bearer " + key,
        ]
        if route.isAnthropic {
            headers["x-api-key"] = key
            headers["anthropic-version"] = "2023-06-01"
        }
        if isCancelled { throw LocalChatError.cancelled }
        let response = try await transport.send(
            LocalChatHTTPRequest(url: url, headers: headers, body: payload))
        if isCancelled { throw LocalChatError.cancelled }

        guard (200..<300).contains(response.status) else {
            let source = await readError(response.bytes)
            if isCancelled { throw LocalChatError.cancelled }
            throw LocalChatHTTPError.from(status: response.status, source: source, keys: route.keys,
                                          host: response.host, attempt: keyIndex + 1,
                                          total: route.keys.count)
        }

        if (response.contentType ?? "").lowercased().contains("text/event-stream") {
            // A provider that streams when the tool loop asked for JSON cannot
            // be parsed for tool calls, so it is refused rather than half-read.
            if body["tools"] != nil { throw LocalToolError.requiresJSON }
            return try await stream(response.bytes, wireProtocol: route.wireProtocol, listener: listener)
        }

        var collected: [UInt8] = []
        var iterator = response.bytes.makeAsyncIterator()
        while let byte = try await iterator.next() {
            if isCancelled { throw LocalChatError.cancelled }
            collected.append(byte)
            // A UTF-8 scalar uses at most four bytes, so this still bounds
            // memory without rejecting valid multi-byte text prematurely.
            if collected.count > Self.limit * 4 { throw LocalChatError.tooLarge }
        }
        if isCancelled { throw LocalChatError.cancelled }
        let source = String(decoding: collected, as: UTF8.self)
        if source.utf16.count > Self.limit { throw LocalChatError.tooLarge }
        guard let parsed = try? JSONSerialization.jsonObject(with: Data(source.utf8)),
              let object = parsed as? [String: Any] else {
            throw LocalChatError.unsupportedFormat
        }
        let reply = JSONObject(dictionary: object)
        if reply.has("error") {
            throw LocalChatError.apiError("API 返回错误 / API error: "
                + LocalChatHTTPError.redact(source, keys: []))
        }
        listener.onResponse(reply)
        if route.isAnthropic {
            let reasoning = reply.objects("content")
                .filter { $0.text("type") == "thinking" }
                .map { $0.text("thinking") }
                .joined()
            if !reasoning.isEmpty { listener.onThinking(reasoning) }
        } else if let message = reply.objects("choices").first?.object("message") {
            if let reasoning = reasoningText(message) { listener.onThinking(reasoning) }
        }
        let text = responseText(reply, wireProtocol: route.wireProtocol)
        if text.isEmpty && !(body["tools"] != nil && LocalToolLoop.hasCalls(reply, wireProtocol: route.wireProtocol)) {
            throw LocalChatError.noText
        }
        listener.onText(text)
        return text
    }

    /// The text of a finished, non-streamed reply.
    private func responseText(_ response: JSONObject, wireProtocol: String) -> String {
        if wireProtocol == "anthropic" {
            return response.objects("content")
                .filter { $0.text("type") == "text" }
                .map { $0.text("text") }
                .joined()
        }
        return response.objects("choices").first?.object("message")?.text("content") ?? ""
    }

    /// `reasoning_content` or `reasoning`, whichever the provider used.
    private func reasoningText(_ message: JSONObject) -> String? {
        if let value = message.raw["reasoning_content"] as? String { return value }
        return message.raw["reasoning"] as? String
    }

    // MARK: - Reading a stream

    /// Reads SSE events until the provider says it is done.
    ///
    /// Ported line for line from Android, including the throttle: the listener
    /// is told what the reply looks like at most every 80 ms, because a token
    /// at a time would redraw the screen faster than anyone can read it.
    private func stream(_ bytes: AsyncThrowingStream<UInt8, Error>,
                        wireProtocol: String, listener: LocalChatListener) async throws -> String {
        var text = ""
        var thinking = ""
        var event = ""
        var eventLength = 0
        var replyLength = 0
        var line: [UInt8] = []
        var completed = false
        // Android starts at zero so the first event is visible immediately;
        // only subsequent events are throttled to 80 ms.
        var lastUpdate: UInt64 = 0
        var iterator = bytes.makeAsyncIterator()

        while true {
            if isCancelled { throw LocalChatError.cancelled }
            let next: UInt8?
            do {
                next = try await iterator.next()
            } catch {
                throw LocalChatError.transport(error.localizedDescription)
            }
            guard let byte = next else { break }
            guard byte == 0x0A else {
                line.append(byte)
                if line.count > Self.limit * 4 { throw LocalChatError.eventTooLarge }
                continue
            }
            var value = String(decoding: line, as: UTF8.self)
            line.removeAll(keepingCapacity: true)
            if value.utf16.count > Self.limit { throw LocalChatError.eventTooLarge }
            if value.hasSuffix("\r") { value.removeLast() }

            if value.isEmpty && !event.isEmpty {
                let data = ComposerText.androidTrim(event)
                event = ""
                eventLength = 0
                if data == "[DONE]" { completed = true; break }
                guard let parsed = try? JSONSerialization.jsonObject(with: Data(data.utf8)),
                      let object = parsed as? [String: Any] else {
                    throw LocalChatError.unsupportedFormat
                }
                let chunk = JSONObject(dictionary: object)
                if chunk.has("error") || chunk.text("type") == "error" {
                    let detail = LocalChatHTTPError.redact(data, keys: [])
                    throw LocalChatError.streamError(
                        "API 返回错误，已保留部分回复 / API stream error; partial reply kept"
                            + (detail.isEmpty ? "" : "\n" + detail))
                }
                if wireProtocol == "anthropic" {
                    if chunk.text("type") == "message_stop" { completed = true; break }
                    if let delta = chunk.object("delta") {
                        if delta.text("type") == "text_delta" {
                            let piece = delta.text("text")
                            text += piece
                            replyLength += piece.utf16.count
                        }
                        if delta.text("type") == "thinking_delta" {
                            let piece = delta.text("thinking")
                            thinking += piece
                            replyLength += piece.utf16.count
                        }
                    }
                    if let block = chunk.object("content_block"),
                       block.text("type") == "thinking" {
                        let piece = block.text("thinking")
                        thinking += piece
                        replyLength += piece.utf16.count
                    }
                } else if let choice = chunk.objects("choices").first {
                    if let delta = choice.object("delta") {
                        if let content = delta.raw["content"] as? String {
                            text += content
                            replyLength += content.utf16.count
                        }
                        if let reasoning = reasoningText(delta) {
                            thinking += reasoning
                            replyLength += reasoning.utf16.count
                        }
                    }
                    if !choice.isNull("finish_reason") { completed = true }
                }
                if replyLength > Self.limit { throw LocalChatError.tooLarge }
                let now = DispatchTime.now().uptimeNanoseconds
                if now - lastUpdate >= 80_000_000 {
                    listener.onThinking(thinking)
                    listener.onText(text)
                    lastUpdate = now
                }
            } else if value.hasPrefix("data:") {
                let data = String(value.dropFirst(5))
                event += data
                event += "\n"
                eventLength += data.utf16.count + 1
                if eventLength > Self.limit { throw LocalChatError.eventTooLarge }
            }
        }
        if isCancelled { throw LocalChatError.cancelled }
        listener.onThinking(thinking)
        listener.onText(text)
        if !completed { throw LocalChatError.interrupted }
        if text.isEmpty { throw LocalChatError.noText }
        return text
    }

    /// The provider's own words about a failure, bounded and never fatal.
    ///
    /// It reads at most 32,768 UTF-16 units over at most five seconds. A body
    /// that will not finish in that budget is reported as empty rather than
    /// delaying the error the user is waiting for.
    private func readError(_ bytes: AsyncThrowingStream<UInt8, Error>) async -> String {
        await withTaskGroup(of: String.self) { group in
            group.addTask { await self.collectError(bytes) }
            group.addTask {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                return ""
            }
            let source = await group.next() ?? ""
            group.cancelAll()
            return source
        }
    }

    private func collectError(_ bytes: AsyncThrowingStream<UInt8, Error>) async -> String {
        var collected: [UInt8] = []
        let characterLimit = 32_768
        var iterator = bytes.makeAsyncIterator()
        do {
            while !isCancelled, !Task.isCancelled,
                  collected.count <= (characterLimit + 1) * 4 {
                guard let byte = try await iterator.next() else {
                    let source = String(decoding: collected, as: UTF8.self)
                    return source.utf16.count <= characterLimit ? source : ""
                }
                collected.append(byte)
            }
        } catch {
            return "{\"error\":" + Self.quoted("Error body unavailable: " + error.localizedDescription) + "}"
        }
        return ""
    }

    /// A JSON string literal, so an error body can be embedded without a parser.
    private static func quoted(_ value: String) -> String {
        var result = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": result += "\\\""
            case "\\": result += "\\\\"
            case "\n": result += "\\n"
            case "\r": result += "\\r"
            case "\t": result += "\\t"
            default:
                if scalar.value < 0x20 {
                    result += String(format: "\\u%04x", scalar.value)
                } else {
                    result.unicodeScalars.append(scalar)
                }
            }
        }
        return result + "\""
    }

    // MARK: - Tools

    /// Sends the body with the web tools on, and runs the loop until the model
    /// answers or the budget runs out.
    public func chatWithTools(route: LocalChatRoute, body: [String: Any],
                              listener: LocalChatListener,
                              executor: LocalToolExecuting) async throws -> String {
        store(executor: executor)
        let token = claimTimeout()
        // A backstop for a provider that accepts the connection and then goes
        // quiet: the loop checks its own deadline between rounds, but a single
        // round that never returns needs something to cut it off.
        DispatchQueue.global().asyncAfter(deadline: .now() + .seconds(LocalToolLoop.deadlineSeconds)) { [weak self] in
            guard let self, self.timeoutIsCurrent(token) else { return }
            self.cancel()
        }
        defer {
            clearTimeout()
            executor.cancel()
            store(executor: nil)
        }
        if isCancelled { throw LocalChatError.cancelled }
        return try await runToolLoop(route: route, body: body, listener: listener, executor: executor)
    }

    /// The loop itself: ask, run whatever tools came back, ask again.
    ///
    /// Ported from `LocalToolLoop.run`. The rounds are bounded, the calls are
    /// bounded, and the clock is bounded, because each of the three is a way a
    /// provider can spend the user's money in a loop it controls.
    private func runToolLoop(route: LocalChatRoute, body original: [String: Any],
                             listener: LocalChatListener,
                             executor: LocalToolExecuting) async throws -> String {
        var body = original
        body["stream"] = false
        body["tools"] = LocalToolLoop.definitions(wireProtocol: route.wireProtocol)
        if !route.isAnthropic { body["max_tokens"] = 4096 }
        var messages = (body["messages"] as? [Any]) ?? []
        if route.isAnthropic {
            body["system"] = LocalToolLoop.rules
        } else {
            var withRules: [Any] = [["role": "system", "content": LocalToolLoop.rules] as [String: Any]]
            withRules.append(contentsOf: messages)
            messages = withRules
        }

        var identifiers = Set<String>()
        var sources: [String] = []
        var executed = 0
        let deadline = DispatchTime.now().uptimeNanoseconds
            + UInt64(LocalToolLoop.deadlineSeconds) * 1_000_000_000

        for round in 0...LocalToolLoop.maxRounds {
            try check(deadline)
            if round == LocalToolLoop.maxRounds {
                body.removeValue(forKey: "tools")
                messages.append(["role": "user", "content": LocalToolLoop.finalize] as [String: Any])
            }
            body["messages"] = messages
            if jsonText(body).utf16.count > LocalToolLoop.maxBodyUnits { throw LocalToolError.contextTooLong }

            var response: JSONObject?
            let answer = try await chat(route: route, body: body, listener: LocalChatListener(
                onText: listener.onText,
                onThinking: listener.onThinking,
                onResponse: { response = $0 }))
            try check(deadline)

            guard let response else { throw LocalToolError.requiresJSON }
            if !LocalToolLoop.hasCalls(response, wireProtocol: route.wireProtocol) {
                if answer.isEmpty { throw LocalToolError.noFinalAnswer }
                listener.onText(LocalToolLoop.finishing(answer, sources: sources))
                return LocalToolLoop.finishing(answer, sources: sources)
            }
            if round == LocalToolLoop.maxRounds { throw LocalToolError.ignoredStopRequest }

            let assistant = try LocalToolLoop.assistantMessage(response, wireProtocol: route.wireProtocol)
            let reason = LocalToolLoop.stopReason(response, wireProtocol: route.wireProtocol)
            let expected = route.isAnthropic ? "tool_use" : "tool_calls"
            if reason != expected { throw LocalToolError.incompleteToolResponse }

            let wireCalls = wireCalls(response, wireProtocol: route.wireProtocol)
            var calls: [[String: Any]] = []
            for call in wireCalls {
                let type = call["type"] as? String
                if route.isAnthropic && type != "tool_use" { continue }
                if !route.isAnthropic && type != "function" { throw LocalToolError.unsupportedToolType }
                let id = call["id"] as? String
                _ = try LocalToolLoop.claimCallID(id, seen: &identifiers)
                calls.append(call)
            }
            if executed + calls.count > LocalToolLoop.maxCalls { throw LocalToolError.callLimitReached }
            messages.append(assistant)

            var results: [[String: Any]] = []
            for call in calls {
                try check(deadline)
                executed += 1
                let function = route.isAnthropic ? call : (call["function"] as? [String: Any] ?? [:])
                let name = function["name"] as? String ?? ""
                let id = call["id"] as? String ?? ""
                if name.utf16.count > LocalToolLoop.maxNameLength { throw LocalToolError.invalidToolName }
                var entry = LocalToolLoop.entry(id: id, name: name, status: "running")
                let output: [String: Any]
                do {
                    let arguments = route.isAnthropic
                        ? (call["input"] as? [String: Any] ?? [:])
                        : try LocalToolLoop.arguments(function["arguments"] as? String ?? "")
                    try LocalToolLoop.validate(name, arguments)
                    entry["input"] = jsonText(arguments)
                    listener.onTool(entry)
                    let produced = try await executor.execute(name, arguments)
                    if jsonText(produced).utf16.count > LocalToolLoop.maxResultUnits {
                        throw LocalToolError.resultTooLarge
                    }
                    output = produced
                } catch {
                    if isCancelled { throw LocalChatError.cancelled }
                    // The model is told what to do next, not just that it
                    // failed; a bare error is how it ends up retrying the same
                    // search until the budget is gone.
                    output = ["error": LocalToolLoop.failureMessage(for: name)]
                }
                try check(deadline)
                entry["status"] = output["error"] == nil ? "completed" : "failed"
                entry["text"] = jsonText(output)
                listener.onTool(entry)
                if output["error"] == nil {
                    for source in (output["sources"] as? [Any])?.compactMap({ $0 as? [String: Any] }) ?? [] {
                        guard let url = source["url"] as? String,
                              let canonical = try? LocalWebTools.publicURL(url) else { continue }
                        sources.append(canonical.absoluteString)
                    }
                }
                if route.isAnthropic {
                    results.append(["type": "tool_result", "tool_use_id": id,
                                    "content": jsonText(output),
                                    "is_error": output["error"] != nil] as [String: Any])
                } else {
                    messages.append(["role": "tool", "tool_call_id": id,
                                     "content": jsonText(output)] as [String: Any])
                }
            }
            if route.isAnthropic {
                messages.append(["role": "user", "content": results] as [String: Any])
            }
        }
        throw LocalToolError.callLimitReached
    }

    /// The tool calls in a response, in wire shape.
    private func wireCalls(_ response: JSONObject, wireProtocol: String) -> [[String: Any]] {
        if wireProtocol == "anthropic" {
            return response.objects("content").map(\.raw)
        }
        let message = response.objects("choices").first?.object("message")
        return (message?.raw["tool_calls"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
    }

    private func check(_ deadline: UInt64) throws {
        if isCancelled { throw LocalChatError.cancelled }
        if DispatchTime.now().uptimeNanoseconds > deadline { throw LocalToolError.timedOut }
    }

    /// Compact JSON, which is what the tool loop measures and logs.
    private func jsonText(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
}
