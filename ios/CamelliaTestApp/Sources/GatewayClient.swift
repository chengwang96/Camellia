import Foundation

/// Requests to the desktop gateway, issued over the embedded network.
///
/// This is what S1 is finally judged on. A node that starts and reaches the
/// control plane has proved the tunnel exists; only a real request leaving the
/// phone and coming back classified proves it carries traffic.
enum GatewayClient {
    struct Answer {
        let target: String
        let status: Int
        let contentType: String
        let byteCount: Int
        let body: String
        /// Whatever the read did beyond the plain result, such as how a stream
        /// ended. Empty for a request with a body of known length.
        let note: String
    }

    /// The desktop paths a diagnostic run uses.
    ///
    /// All of them are on the shared allowlist and `Endpoint.url(_:)` re-checks
    /// that, so the app cannot be pointed anywhere the shipping client could
    /// not go. The stream path is separate because it is read differently, not
    /// because it is less trusted.
    static let paths = ["/v1/status", "/v1/conversations"]
    static let streamPath = "/v1/conversations/events"

    /// Issues a GET and reads the whole body.
    static func fetch(endpoint: Endpoint, path: String, token: String) throws -> Answer {
        let node = try EmbeddedNetwork.shared.currentNode()
        let target = try endpoint.url(path).absoluteString
        let response = try node.open("GET", target: target, token: token, payload: "")
        defer { response.close() }
        let body = try response.readAll()
        return Answer(
            target: target,
            status: response.statusCode(),
            contentType: response.contentType(),
            byteCount: body.count,
            body: String(decoding: body.prefix(4000), as: UTF8.self),
            note: ""
        )
    }

    /// Opens the snapshot stream and reads it for `seconds`.
    ///
    /// A stream is the one thing a body-sized GET does not exercise: it ends by
    /// being closed rather than by announcing a length, and on this bridge a
    /// clean end arrives as a zero-length chunk that the generated binding
    /// cannot express — see `TailnetResponse.nextChunk`. Reading a real stream
    /// is how that is checked on hardware instead of in a simulator.
    static func sampleStream(endpoint: Endpoint, path: String, token: String, seconds: Double) throws -> Answer {
        let node = try EmbeddedNetwork.shared.currentNode()
        let target = try endpoint.url(path).absoluteString
        let response = try node.open("GET", target: target, token: token, payload: "")
        defer { response.close() }

        // Closing the response is what ends the read. A snapshot stream stays
        // open until it is told to stop, so a deadline is the only way to get a
        // bounded answer out of one.
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { response.close() }

        var body = Data()
        var chunks = 0
        var ending = "still open when the sample ended"
        do {
            while let chunk = try response.nextChunk() {
                chunks += 1
                body.append(chunk)
                if body.count > 1 << 20 { break }
            }
            // Reaching here rather than throwing is the point: `nextChunk`
            // turns the bridge's end-of-stream into `nil`, and this is where
            // that shows up as a normal finish instead of an error.
            ending = "closed by the stream"
        } catch {
            ending = "read failed: \(FailureText.describe(error))"
        }
        return Answer(
            target: target,
            status: response.statusCode(),
            contentType: response.contentType(),
            byteCount: body.count,
            body: String(decoding: body.prefix(4000), as: UTF8.self),
            note: "\(chunks) chunks, \(ending)"
        )
    }
}

/// Turning a thrown error into something worth reading.
enum FailureText {
    /// The bridge raises failures as `CAMELLIA_<CODE>` messages, and those are
    /// the ones with a written explanation attached, so they are looked up
    /// rather than printed raw.
    static func describe(_ error: Error) -> String {
        let message: String
        if let localized = (error as? LocalizedError)?.errorDescription, !localized.isEmpty {
            message = localized
        } else {
            let bridged = error as NSError
            message = (bridged.userInfo[NSLocalizedDescriptionKey] as? String) ?? bridged.localizedDescription
        }
        guard let code = ConnectionFailureCode.parse(message) else { return message }
        return "\(code.rawValue) · \(code.text(chinese: true))"
    }
}
