import Foundation

/// Failures raised while validating a remote address or path.
///
/// The descriptions are the ones the Android client shows, kept verbatim so
/// both platforms explain a rejected address the same way.
public enum EndpointError: Error, Equatable, CustomStringConvertible {
    /// The text is not shaped like `http://100.x.x.x:port`.
    case malformedAddress
    /// The shape is right, but the address or port is outside the allowed range.
    case notTailnet
    /// The path is not on the remote allowlist.
    case unsupportedPath

    public var description: String {
        switch self {
        case .malformedAddress:
            return "Use the exact http://100.x.x.x:port address shown by Camellia."
        case .notTailnet:
            return "Only a Tailscale IPv4 address and a valid port are allowed."
        case .unsupportedPath:
            return "Unsupported remote endpoint"
        }
    }
}

/// A validated Camellia remote endpoint.
///
/// Ported from `Endpoint.java`. The accept/reject decision is identical to the
/// Android client, so a pairing code that works on one phone works on the other
/// and nothing the desktop would refuse is ever dialled from the device:
///
/// * the scheme must be exactly `http://`
/// * one optional trailing slash is tolerated
/// * the host must be a canonical `100.x.x.x` literal inside Tailscale's
///   `100.64.0.0/10` range, with no leading zeros, and no hostname, user info,
///   path, query or fragment
/// * the port must be 1...65535 written in decimal
public struct Endpoint: Equatable, Hashable, Sendable {
    public static let scheme = "http://"

    /// The dotted-quad host, always normalised (for example `100.64.0.1`).
    public let host: String
    public let port: Int

    /// The canonical origin used as the `Host` header and URL prefix.
    public var origin: String { "\(Self.scheme)\(host):\(port)" }

    /// Builds an endpoint from the exact text the desktop shows.
    public init(_ input: String) throws {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix(Self.scheme) else { throw EndpointError.malformedAddress }
        var remainder = String(text.dropFirst(Self.scheme.count))
        if remainder.hasSuffix("/") { remainder.removeLast() }

        let halves = remainder.split(separator: ":", omittingEmptySubsequences: false)
        guard halves.count == 2 else { throw EndpointError.malformedAddress }
        let labels = halves[0].split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count == 4, labels[0] == "100" else { throw EndpointError.malformedAddress }

        // The first octet is the literal "100". The second selects the
        // Tailscale block; the Java pattern additionally refuses a three-digit
        // second octet that does not begin with 1, which no legal value ever
        // has, so mirroring it keeps the two error messages aligned.
        let second = try Self.octet(labels[1], threeDigitsMustStartWithOne: true)
        let third = try Self.octet(labels[2], threeDigitsMustStartWithOne: false)
        let fourth = try Self.octet(labels[3], threeDigitsMustStartWithOne: false)
        guard (64...127).contains(second), third <= 255, fourth <= 255 else {
            throw EndpointError.notTailnet
        }

        let portText = halves[1]
        guard (1...5).contains(portText.count), portText.allSatisfy(Self.isASCIIDigit) else {
            throw EndpointError.malformedAddress
        }
        guard let value = Int(portText), (1...65535).contains(value) else {
            throw EndpointError.notTailnet
        }

        host = "100.\(second).\(third).\(fourth)"
        port = value
    }

    /// Builds an endpoint from an address and port pair, as the settings screen does.
    public init(host: String, port: String) throws {
        self = try Endpoint(Self.scheme + host.trimmingCharacters(in: .whitespaces) + ":" + port.trimmingCharacters(in: .whitespaces))
    }

    /// Whether the path is on the remote allowlist.
    ///
    /// `RemoteApi` only ever calls `url(_:)`, which enforces this; the predicate
    /// is public so the rule itself can be unit tested.
    public func isAllowed(path: String) -> Bool {
        let range = NSRange(path.startIndex..<path.endIndex, in: path)
        return Self.remotePath.firstMatch(in: path, options: [], range: range) != nil
    }

    /// Resolves an allowlisted path against this origin.
    public func url(_ path: String) throws -> URL {
        guard isAllowed(path: path), let url = URL(string: origin + path) else {
            throw EndpointError.unsupportedPath
        }
        return url
    }

    // MARK: - Rules

    private static func isASCIIDigit(_ character: Character) -> Bool {
        character.isASCII && character.isNumber
    }

    private static func octet(_ label: Substring, threeDigitsMustStartWithOne: Bool) throws -> Int {
        guard !label.isEmpty, label.count <= 3, label.allSatisfy(isASCIIDigit) else {
            throw EndpointError.malformedAddress
        }
        // "0" is legal, "01" is not: the Java pattern never allows a leading zero.
        if label.count > 1, label.first == "0" { throw EndpointError.malformedAddress }
        if threeDigitsMustStartWithOne, label.count == 3, label.first != "1" {
            throw EndpointError.malformedAddress
        }
        guard let value = Int(label) else { throw EndpointError.malformedAddress }
        return value
    }

    /// The same grammar as the Android client, with `[0-9]` in place of `\d`
    /// because ICU would otherwise accept non-ASCII decimal digits.
    ///
    /// `/read` is on the list because marking a conversation seen is a POST the
    /// desktop accepts from a read-only device: it moves the phone's read
    /// cursor and touches nothing else, so it is not a command and does not go
    /// through `/commands`.
    private static let remotePath: NSRegularExpression = {
        let pattern = "^/v1/(?:(?:status|commands|pair/(?:request|claim)"
            + "|conversations(?:/events|/[a-f0-9-]{36}(?:/(?:events|commands|read|artifacts(?:/[a-f0-9]{64})?))?)?)"
            + "(?:\\?(?:offset|before)=[0-9]{1,12})?|api-keys)$"
        guard let expression = try? NSRegularExpression(pattern: pattern) else {
            preconditionFailure("the remote path grammar is a literal and must compile")
        }
        return expression
    }()
}
