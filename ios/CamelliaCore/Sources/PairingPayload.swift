import Foundation

/// Failures raised while reading a pairing code.
///
/// Descriptions mirror the Android client so both platforms explain a rejected
/// code identically.
public enum PairingError: Error, Equatable, CustomStringConvertible {
    case empty
    case notAnObject
    case keysMustBeStrings
    case malformed
    case flatValuesOnly
    case unterminatedString
    case notCamellia
    case unsupportedVersion
    case incomplete
    case invalidAddress
    case invalidCode

    public var description: String {
        switch self {
        case .empty: return "Empty pairing code"
        case .notAnObject: return "Pairing code must be a JSON object"
        case .keysMustBeStrings: return "Pairing code keys must be strings"
        case .malformed: return "Pairing code is malformed"
        case .flatValuesOnly: return "Pairing code must only contain strings and numbers"
        case .unterminatedString: return "Pairing code has an unterminated string"
        case .notCamellia: return "Not a Camellia pairing code"
        case .unsupportedVersion: return "Unsupported pairing version"
        case .incomplete: return "Pairing code is incomplete"
        case .invalidAddress: return "Pairing code has an invalid address"
        case .invalidCode: return "Pairing code is invalid"
        }
    }
}

/// The desktop shows a QR code that carries everything the phone needs to pair:
/// the Tailscale address and the one-time code.
///
/// Ported from `PairingPayload.java`. The payload is deliberately parsed by hand
/// instead of with `JSONSerialization`: it has to stay a flat, versioned object
/// with string or number values, and anything else is rejected rather than fed
/// through the pairing request. Duplicate keys resolve to the last value, a
/// trailing comma is tolerated, and nesting is refused, exactly as on Android.
public struct PairingPayload: Equatable, Sendable {
    public static let type = "camellia-pair"
    public static let version = "1"
    /// Twenty-four hexadecimal characters, matched case-insensitively.
    public static let codeLength = 24

    /// The validated `http://100.x.x.x:port` origin.
    public let address: String
    /// The one-time code, normalised to lower-case hexadecimal.
    public let code: String
    public let computerName: String

    public init(_ text: String?) throws {
        guard let text else { throw PairingError.empty }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let characters = Array(trimmed)
        guard characters.count >= 2, characters[0] == "{", characters[characters.count - 1] == "}" else {
            throw PairingError.notAnObject
        }

        let fields = try Self.flatObject(characters)
        guard fields["type"] == Self.type else { throw PairingError.notCamellia }
        guard fields["v"] == Self.version else { throw PairingError.unsupportedVersion }
        guard let address = fields["address"], let code = fields["code"] else {
            throw PairingError.incomplete
        }

        let endpoint: Endpoint
        do {
            endpoint = try Endpoint(address)
        } catch {
            throw PairingError.invalidAddress
        }
        guard Self.isPairingCode(code) else { throw PairingError.invalidCode }

        self.address = endpoint.origin
        self.code = code.lowercased()
        computerName = fields["name"] ?? ""
    }

    /// Whether the text is twenty-four hexadecimal characters.
    public static func isPairingCode(_ text: String) -> Bool {
        text.count == codeLength && text.allSatisfy { $0.isASCII && $0.isHexDigit }
    }

    // MARK: - The flat object reader

    private static func flatObject(_ characters: [Character]) throws -> [String: String] {
        var fields: [String: String] = [:]
        var index = 1
        let end = characters.count - 1
        while true {
            index = skipSpace(characters, index, end)
            if index == end { return fields }
            guard characters[index] == "\"" else { throw PairingError.keysMustBeStrings }
            var key = ""
            index = try readString(characters, index, end, into: &key)
            index = skipSpace(characters, index, end)
            guard index < end, characters[index] == ":" else { throw PairingError.malformed }
            index = skipSpace(characters, index + 1, end)
            guard index < end else { throw PairingError.malformed }
            var field = ""
            if characters[index] == "\"" {
                index = try readString(characters, index, end, into: &field)
            } else {
                index = try readNumber(characters, index, end, into: &field)
            }
            fields[key] = field
            index = skipSpace(characters, index, end)
            if index == end { return fields }
            guard characters[index] == "," else { throw PairingError.malformed }
            index += 1
        }
    }

    private static func skipSpace(_ characters: [Character], _ start: Int, _ end: Int) -> Int {
        var index = start
        while index < end {
            let character = characters[index]
            guard character == " " || character == "\n" || character == "\r" || character == "\t" else { break }
            index += 1
        }
        return index
    }

    private static func readString(_ characters: [Character], _ start: Int, _ end: Int, into out: inout String) throws -> Int {
        var index = start + 1
        while index < end {
            let current = characters[index]
            index += 1
            if current == "\"" { return index }
            if current != "\\" {
                out.append(current)
                continue
            }
            guard index < end else { break }
            let escape = characters[index]
            index += 1
            switch escape {
            case "\"", "\\", "/": out.append(escape)
            case "b": out.append("\u{08}")
            case "f": out.append("\u{0C}")
            case "n": out.append("\n")
            case "r": out.append("\r")
            case "t": out.append("\t")
            case "u":
                // Stricter than Java's Integer.parseInt: exactly four hexadecimal
                // digits, and a code point that is a real scalar value.
                guard index + 4 <= end else { throw PairingError.malformed }
                let digits = String(characters[index..<(index + 4)])
                guard digits.count == 4, digits.allSatisfy({ $0.isASCII && $0.isHexDigit }),
                      let value = UInt32(digits, radix: 16), let scalar = Unicode.Scalar(value) else {
                    throw PairingError.malformed
                }
                out.append(Character(scalar))
                index += 4
            default:
                throw PairingError.malformed
            }
        }
        throw PairingError.unterminatedString
    }

    private static func readNumber(_ characters: [Character], _ start: Int, _ end: Int, into out: inout String) throws -> Int {
        var index = start
        while index < end {
            let character = characters[index]
            guard character == "-" || (character.isASCII && character.isNumber) else { break }
            index += 1
        }
        guard index > start else { throw PairingError.flatValuesOnly }
        out.append(contentsOf: characters[start..<index])
        return index
    }
}
