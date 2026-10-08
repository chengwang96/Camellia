import CryptoKit
import Foundation

extension String {
    /// Lowercase hex SHA-256 of the UTF-8 bytes.
    ///
    /// Used to key local state by a credential without storing the credential:
    /// the read state of two computers that happen to share a session id must
    /// not be conflated, and a digest of address, token and conversation id is
    /// how Android separates them.
    public var sha256: String {
        let digest = SHA256.hash(data: Data(utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

extension Data {
    public var sha256Hex: String {
        let digest = SHA256.hash(data: self)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
