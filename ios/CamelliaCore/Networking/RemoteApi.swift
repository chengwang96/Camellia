import Foundation
import Tailnet

/// Talks to the desktop gateway over the selected Tailscale route.
///
/// Like Android, the built-in mode dials through the tsnet bridge. External
/// mode uses URLSession and the route supplied by an installed system VPN.
/// Both paths keep the same validated 100.x endpoint and path allowlist.
///
/// What is unchanged from Android is every rule that governs the exchange:
/// the token shape, the allowlisted paths, no redirect following, the response
/// size ceiling, and redaction of anything that comes back before it is shown.
public final class RemoteApi {
    public struct Failure: Error, LocalizedError, RemoteHttpError {
        public let status: Int
        public let detail: String

        public var errorDescription: String? {
            RemoteFailure.httpMessage(status: status, detail: detail, chinese: true)
        }
    }

    public static let maximumBodyBytes = ExternalHTTP.maximumBodyBytes
    /// Enough to explain a failure, small enough that a hostile body cannot
    /// become the UI.
    public static let maximumErrorBytes = ExternalHTTP.maximumErrorBytes

    public let endpoint: Endpoint
    /// Nil only while pairing: `/v1/pair/request` and `/v1/pair/claim` are the
    /// two calls the desktop takes without one, since there is no device yet to
    /// authenticate.
    public let token: String?
    /// Present for the authenticated app session so command payloads can turn
    /// encrypted local references into the Base64 the desktop protocol uses.
    /// Pairing and diagnostics never carry attachments and leave it nil.
    private let attachments: AttachmentStore?
    private let requestCancellation = RemoteRequestCancellation()

    /// A client for the two unauthenticated pairing calls.
    public init(endpoint: Endpoint) {
        self.endpoint = endpoint
        token = nil
        attachments = nil
    }

    public init(endpoint: Endpoint, token: String, attachments: AttachmentStore? = nil) throws {
        // Refuse locally rather than sending a request the desktop would only
        // reject. Android checks the same pattern before opening a connection.
        guard Credential.isDeviceToken(token) else { throw RemoteApiError.invalidCredential }
        self.endpoint = endpoint
        self.token = token
        self.attachments = attachments
    }

    // MARK: - Endpoints

    public func status() throws -> RemoteStatus {
        let body = try json("/v1/status")
        guard RemoteStatus.protocolVersion(of: body) == 1 else {
            throw RemoteApiError.unsupportedProtocol
        }
        return RemoteStatus(body)
    }

    public func conversations(offset: Int = 0) throws -> RemoteListPage {
        RemoteListPage(try json("/v1/conversations?offset=\(offset)"))
    }

    public func conversation(id: String, before: Int64? = nil) throws -> RemoteSnapshot {
        let path = "/v1/conversations/" + id + (before.map { "?before=\($0)" } ?? "")
        return RemoteSnapshot(try json(path))
    }

    @discardableResult
    public func command(_ action: String, conversationId: String? = nil, payload: [String: Any] = [:]) throws -> CommandResult {
        var body = payload
        body["action"] = action
        body["requestId"] = body["requestId"] ?? UUID().uuidString
        // The desktop rejects a command whose instance does not match, which is
        // how a stale phone is stopped from driving a restarted session.
        body["instanceId"] = body["instanceId"] ?? ""
        let path = conversationId.map { "/v1/conversations/\($0)/commands" } ?? "/v1/commands"
        return CommandResult(try json(path, method: "POST", payload: body))
    }

    /// Lists the files this conversation referenced and that still exist.
    public func artifacts(conversationId: String, offset: Int64 = 0) throws -> RemoteArtifactPage {
        RemoteArtifactPage(try json("/v1/conversations/\(conversationId)/artifacts?offset=\(offset)"))
    }

    /// The desktop's provider configuration, in the local-chat export shape.
    ///
    /// The one endpoint that does not answer with a remote snapshot: it is the
    /// same document `camellia-api-routes` v2 exports, which is what lets a
    /// phone adopt a desktop's keys instead of having them retyped. The desktop
    /// serves it to a paired device only, and the response is parsed by
    /// `LocalChatConfiguration.parse` on the other side, not here — this layer
    /// never looks inside it.
    public func apiKeys() throws -> [String: Any] {
        try json("/v1/api-keys").raw
    }

    /// Moves this phone's read cursor on one conversation.
    ///
    /// A POST rather than a command, and accepted from a read-only pairing: it
    /// records that the reply at `lastReplyAt` has been shown, which is the only
    /// thing that clears the unread mark in the desktop's own list. Nothing in
    /// the conversation changes, so there is no `instanceId` or `requestId` to
    /// carry and no retry rule beyond trying again next time the snapshot
    /// reports a newer reply.
    @discardableResult
    public func markRead(conversationId: String, lastReplyAt: Int64) throws -> JSONObject {
        try json("/v1/conversations/\(conversationId)/read",
                 method: "POST", payload: ["lastReplyAt": lastReplyAt])
    }

    // MARK: - Pairing

    /// Offers a one-time code and asks for a claim handle.
    ///
    /// The code is normalised to lower case on the way out, as the desktop
    /// generated it and as the QR payload carries it.
    public func pairRequest(code: String, name: String) throws -> PairRequestResult {
        PairRequestResult(try json("/v1/pair/request", method: "POST", payload: [
            "code": code.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            "name": name,
        ]))
    }

    /// Asks whether the desktop has approved the request yet.
    ///
    /// Repeated every few seconds until it answers `approved`, which is why it
    /// carries no side effects of its own.
    public func pairClaim(id: String, claim: String) throws -> PairClaimResult {
        PairClaimResult(try json("/v1/pair/claim", method: "POST", payload: ["id": id, "claim": claim]))
    }

    /// Downloads an artifact's bytes.
    ///
    /// The desktop states a size in the listing and the bytes must match it,
    /// so a truncated transfer is reported rather than written to disk.
    public func artifact(conversationId: String, hash: String, expectedSize: Int64) throws -> Data {
        let path = "/v1/conversations/\(conversationId)/artifacts/\(hash)"
        let data = try read(path, expectedContentType: "application/octet-stream")
        guard data.count == expectedSize else { throw RemoteApiError.sizeChanged }
        return data
    }

    /// The app's export path: stream a file to its private temporary URL,
    /// without reusing the 8 MiB JSON ceiling or holding the file in memory.
    public func artifact(conversationId: String, hash: String, expectedSize: Int64,
                         to destination: URL, transfer: ArtifactTransfer,
                         progress: @escaping (Int64, Int64) -> Void) throws {
        guard expectedSize >= 0 else { throw RemoteApiError.sizeChanged }
        try transfer.check()
        let path = "/v1/conversations/\(conversationId)/artifacts/\(hash)"
        guard FileManager.default.createFile(atPath: destination.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        let output: FileHandle
        do {
            output = try FileHandle(forWritingTo: destination)
        } catch {
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
        defer { try? output.close() }
        var received: Int64 = 0
        var lastProgress = 0.0
        func accept(_ chunk: Data) throws {
            try transfer.check()
            guard Int64(chunk.count) <= expectedSize - received else { throw RemoteApiError.sizeChanged }
            try output.write(contentsOf: chunk)
            received += Int64(chunk.count)
            let now = ProcessInfo.processInfo.systemUptime
            if now - lastProgress >= 0.25 || received == expectedSize {
                lastProgress = now
                progress(received, expectedSize)
            }
        }

        do {
            if EmbeddedNetwork.shared.isEnabled {
                EmbeddedNetwork.shared.retainTransfer()
                defer { EmbeddedNetwork.shared.releaseTransfer() }
                let target = try endpoint.url(path)
                let node = try EmbeddedNetwork.shared.currentNode()
                let response = try node.open("GET", target: target.absoluteString,
                                             token: token ?? "", payload: "")
                transfer.setAbort { response.close() }
                defer { transfer.clearAbort() }
                defer { response.close() }
                guard response.statusCode() == 200 else {
                    let detail = try response.readAll(limit: Self.maximumErrorBytes + 1)
                    throw Failure(status: response.statusCode(), detail: Self.detail(from: detail))
                }
                guard response.contentType().lowercased().hasPrefix("application/octet-stream") else {
                    throw RemoteApiError.unexpectedContentType
                }
                while let chunk = try response.nextChunk() { try accept(chunk) }
            } else {
                let request = try externalRequest(path, method: "GET", payload: nil,
                                                  accept: "application/octet-stream")
                let external = ExternalHTTP(request: request, expectedContentType: "application/octet-stream",
                                            mode: .stream, expectedLength: expectedSize)
                transfer.setAbort { external.cancel() }
                defer { transfer.clearAbort() }
                let result = try external.run(onChunk: accept)
                guard result.status == 200 else {
                    throw Failure(status: result.status, detail: Self.detail(from: result.body))
                }
            }
            try transfer.check()
            guard received == expectedSize else { throw RemoteApiError.sizeChanged }
            progress(received, expectedSize)
        } catch {
            try? FileManager.default.removeItem(at: destination)
            if (try? transfer.check()) == nil { throw ArtifactTransfer.Failure.cancelled }
            if case ExternalHTTP.Failure.unexpectedContentType = error {
                throw RemoteApiError.unexpectedContentType
            }
            if case ExternalHTTP.Failure.sizeChanged = error {
                throw RemoteApiError.sizeChanged
            }
            throw error
        }
    }

    // MARK: - Transport

    /// A JSON request. `payload == nil` is a GET, anything else a POST.
    public func json(_ path: String, method: String? = nil, payload: [String: Any]? = nil) throws -> JSONObject {
        let data = try read(path, method: method, payload: payload)
        guard let object = try? JSONBody.object(data) else { throw RemoteApiError.invalidJSON }
        return object
    }

    /// Reads a whole response body.
    public func read(_ path: String, method: String? = nil, payload: [String: Any]? = nil,
                     expectedContentType: String = "application/json") throws -> Data {
        let ticket = requestCancellation.ticket()
        let verb = method ?? (payload == nil ? "GET" : "POST")
        let target = try endpoint.url(path)
        let encoded = try payload.map { try encode($0) } ?? ""

        if !EmbeddedNetwork.shared.isEnabled {
            let request = try externalRequest(path, method: verb, payload: payload == nil ? nil : Data(encoded.utf8),
                                              accept: expectedContentType)
            let external = ExternalHTTP(request: request, expectedContentType: expectedContentType,
                                        mode: .body)
            guard requestCancellation.install({ external.cancel() }, ticket: ticket) else {
                throw CancellationError()
            }
            defer { requestCancellation.clear(ticket: ticket) }
            let result: (status: Int, body: Data)
            do {
                result = try external.run()
            } catch ExternalHTTP.Failure.tooLarge {
                throw RemoteApiError.tooLarge
            } catch ExternalHTTP.Failure.unexpectedContentType {
                throw RemoteApiError.unexpectedContentType
            }
            guard result.status == 200 else {
                throw Failure(status: result.status, detail: Self.detail(from: result.body))
            }
            return result.body
        }

        let node = try EmbeddedNetwork.shared.currentNode()
        let response = try node.prepare(verb, target: target.absoluteString, token: token ?? "", payload: encoded)
        guard requestCancellation.install({ response.close() }, ticket: ticket) else {
            throw CancellationError()
        }
        defer {
            requestCancellation.clear(ticket: ticket)
            response.close()
        }
        try response.execute()

        let status = response.statusCode()
        let body = try response.readAll(limit: status == 200 ? Self.maximumBodyBytes + 1
                                                         : Self.maximumErrorBytes + 1)
        guard status == 200 else {
            throw Failure(status: status, detail: RemoteApi.detail(from: body))
        }
        guard body.count <= Self.maximumBodyBytes else { throw RemoteApiError.tooLarge }
        guard response.contentType().lowercased().hasPrefix(expectedContentType) else {
            throw RemoteApiError.unexpectedContentType
        }
        return body
    }

    /// Ends an ordinary request owned by this API instance. Prefetch creates
    /// one instance per fetch, so cancelling it never interrupts a user command.
    public func cancel() {
        requestCancellation.cancel()
    }

    public func cancelCurrentRequest() {
        requestCancellation.cancelCurrent()
    }

    /// Opens the snapshot stream and hands back the raw chunks as they arrive.
    ///
    /// The stream is the one call that never finishes on its own, so the caller
    /// gets a handle it can cancel rather than a completed value.
    public func stream(_ path: String) throws -> RemoteStreamHandle {
        _ = try endpoint.url(path)
        return EmbeddedNetwork.shared.isEnabled ? NodeStream(api: self, path: path)
                                                : ExternalStream(api: self, path: path)
    }

    // MARK: - Details

    private func encode(_ payload: [String: Any]) throws -> String {
        let resolved = try RemoteAttachmentJSON.resolve(payload, using: attachments)
        guard JSONSerialization.isValidJSONObject(resolved),
              let data = try? JSONSerialization.data(withJSONObject: resolved),
              let text = String(data: data, encoding: .utf8) else {
            throw RemoteApiError.invalidPayload
        }
        return text
    }

    /// The human-readable part of a failed response.
    ///
    /// Always redacted: a gateway that echoes a request back in its error text
    /// would otherwise put the device token on screen.
    fileprivate static func detail(from body: Data) -> String {
        let prefix = body.prefix(maximumErrorBytes)
        var text = String(decoding: prefix, as: UTF8.self)
        if let object = try? JSONBody.object(Data(text.utf8)) {
            for key in ["error", "message", "detail"] {
                let value = object.text(key)
                if !value.isEmpty { text = value; break }
            }
        }
        return Redaction.clean(text)
    }

    fileprivate func externalRequest(_ path: String, method: String, payload: Data?,
                                     accept: String) throws -> URLRequest {
        let url = try endpoint.url(path)
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 25)
        request.httpMethod = method
        request.setValue(accept, forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let payload {
            request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            request.httpBody = payload
        }
        return request
    }
}

/// The calls the desktop answers, dialled over the selected network.
///
/// `RemoteSession` schedules them; this is where they actually go out. The two
/// are split by a protocol so the scheduling — in particular that a stream must
/// not block a request — can be tested without the tunnel framework.
extension RemoteApi: RemoteTransport {}

/// The pairing calls, dialled over the selected network at one address.
///
/// The controller supplies the address on each call. Keeping it out of this
/// object prevents an earlier queued dial from accidentally using a later
/// request's computer address.
public final class RemotePairingTransport: PairingTransport {
    public init() {}

    public func pairRequest(origin: String, code: String, name: String) throws -> PairRequestResult {
        try RemoteApi(endpoint: try Endpoint(origin)).pairRequest(code: code, name: name)
    }

    public func pairClaim(origin: String, id: String, claim: String) throws -> PairClaimResult {
        try RemoteApi(endpoint: try Endpoint(origin)).pairClaim(id: id, claim: claim)
    }
}

/// A snapshot stream that can be cancelled.
///
/// Cancelling matters more than it sounds: the stream holds a tailnet socket
/// open, and leaving one behind per conversation visited would keep the node
/// busy for no reason.
public final class NodeStream: RemoteStreamHandle {
    private let api: RemoteApi
    private let path: String
    private var response: TailnetResponse?
    private var cancelled = false
    private let lock = NSLock()

    public init(api: RemoteApi, path: String) {
        self.api = api
        self.path = path
    }

    public func cancel() {
        lock.lock()
        cancelled = true
        let open = response
        lock.unlock()
        open?.close()
    }

    /// Feeds chunks to `onChunk` until the stream ends, is cancelled, or fails.
    ///
    /// Ends normally when the bridge reports the end of the stream, which
    /// arrives as a nil chunk rather than as an error — see
    /// `TailnetResponse.nextChunk`.
    public func run(onChunk: @escaping (Data) throws -> Void) throws {
        let target = try api.endpoint.url(path).absoluteString
        let node = try EmbeddedNetwork.shared.currentNode()
        let opened = try node.open("GET", target: target, token: api.token ?? "", payload: "")
        lock.lock()
        if cancelled {
            lock.unlock()
            opened.close()
            return
        }
        response = opened
        lock.unlock()
        defer { opened.close() }

        let status = opened.statusCode()
        guard status == 200 else {
            throw RemoteApi.Failure(status: status, detail: "")
        }
        guard opened.contentType().lowercased().hasPrefix("text/event-stream") else {
            throw RemoteApiError.unexpectedContentType
        }
        while let chunk = try opened.nextChunk() {
            lock.lock()
            let stopped = cancelled
            lock.unlock()
            if stopped { return }
            if !chunk.isEmpty { try onChunk(chunk) }
        }
    }
}

/// SSE over the system VPN route. The session delegate feeds chunks as they
/// arrive and cancellation closes the URLSession task, matching NodeStream's
/// blocking lifetime without sharing a worker with ordinary requests.
public final class ExternalStream: RemoteStreamHandle {
    private let api: RemoteApi
    private let path: String
    private let lock = NSLock()
    private var request: ExternalHTTP?
    private var cancelled = false

    public init(api: RemoteApi, path: String) {
        self.api = api
        self.path = path
    }

    public func cancel() {
        lock.lock()
        cancelled = true
        let running = request
        lock.unlock()
        running?.cancel()
    }

    public func run(onChunk: @escaping (Data) throws -> Void) throws {
        let prepared = try api.externalRequest(path, method: "GET", payload: nil,
                                               accept: "text/event-stream")
        let external = ExternalHTTP(request: prepared, expectedContentType: "text/event-stream", mode: .stream)
        lock.lock()
        if cancelled {
            lock.unlock()
            return
        }
        request = external
        lock.unlock()
        defer {
            lock.lock()
            request = nil
            lock.unlock()
        }
        do {
            let result = try external.run(onChunk: onChunk)
            guard result.status == 200 else {
                throw RemoteApi.Failure(status: result.status,
                                        detail: RemoteApi.detail(from: result.body))
            }
        } catch ExternalHTTP.Failure.cancelled {
            return
        } catch ExternalHTTP.Failure.unexpectedContentType {
            throw RemoteApiError.unexpectedContentType
        }
    }
}

public enum RemoteApiError: Error, LocalizedError {
    case invalidCredential
    case unsupportedProtocol
    case invalidJSON
    case invalidPayload
    case tooLarge
    case sizeChanged
    case unexpectedContentType

    public var errorDescription: String? {
        switch self {
        case .invalidCredential: return "设备令牌无效，请重新配对。"
        case .unsupportedProtocol: return "电脑端协议版本不受支持，请更新电脑端。 [UNSUPPORTED_PROTOCOL]"
        case .invalidJSON: return "Invalid JSON"
        case .invalidPayload: return "请求无法编码。"
        case .tooLarge: return "响应过大。"
        case .sizeChanged: return "文件大小已变化，未保存。 [SIZE_CHANGED]"
        case .unexpectedContentType: return "电脑返回了意外的内容类型。"
        }
    }
}
