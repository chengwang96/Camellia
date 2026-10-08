import CryptoKit
import Foundation

/// The sealed envelope the paired computer's credentials are stored in.
///
/// Android keeps one JSON blob of credentials and wraps it in
/// `AES/GCM/NoPadding` under a key the AndroidKeyStore holds and never hands
/// out. iOS splits that in two, because the Keychain and the filesystem protect
/// data differently here:
///
/// * the key is a Keychain item marked
///   `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, which is encrypted under a
///   device key and cannot be restored onto another device from a backup;
/// * the ciphertext is a plain file, which is all it needs to be — without the
///   Keychain item the bytes are unopenable.
///
/// Keeping Android's envelope shape (`iv` plus `data`, where `data` is
/// ciphertext followed by the GCM tag, exactly what Java's `cipher.doFinal`
/// returns) means one mental model for both clients, and one place to look when
/// a credential fails to open.
public struct SealedCredential: Equatable, Sendable {
    /// Twelve bytes, as GCM requires and as Java's default provider generates.
    public let nonce: Data
    public let ciphertext: Data
    /// Sixteen bytes, appended to `ciphertext` in the stored envelope.
    public let tag: Data

    public init(nonce: Data, ciphertext: Data, tag: Data) {
        self.nonce = nonce
        self.ciphertext = ciphertext
        self.tag = tag
    }
}

public enum SealedCredentialError: Error, Equatable, CustomStringConvertible {
    case invalidNonce
    case truncated
    case authenticationFailed

    public var description: String {
        switch self {
        case .invalidNonce:
            return "Stored credentials have an unusable nonce"
        case .truncated:
            return "Stored credentials are truncated"
        case .authenticationFailed:
            return "Stored credentials could not be authenticated"
        }
    }
}

public enum CredentialSeal {
    /// Bound into the ciphertext as additional authenticated data.
    ///
    /// Android passes its key alias as the AAD, so a blob written under one
    /// alias cannot be opened under another. The same idea, same value.
    public static let context = "camellia.remote.v1"
    public static let nonceBytes = 12
    public static let tagBytes = 16

    public static func seal(_ payload: Data, using key: SymmetricKey, context: String = context) throws -> SealedCredential {
        let box = try AES.GCM.seal(payload, using: key, nonce: nonce(), authenticating: Data(context.utf8))
        return SealedCredential(nonce: Data(box.nonce), ciphertext: box.ciphertext, tag: box.tag)
    }

    public static func open(_ envelope: SealedCredential, using key: SymmetricKey, context: String = context) throws -> Data {
        let nonce: AES.GCM.Nonce
        do {
            nonce = try AES.GCM.Nonce(data: envelope.nonce)
        } catch {
            throw SealedCredentialError.invalidNonce
        }
        let box: AES.GCM.SealedBox
        do {
            box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: envelope.ciphertext, tag: envelope.tag)
        } catch {
            throw SealedCredentialError.truncated
        }
        do {
            return try AES.GCM.open(box, using: key, authenticating: Data(context.utf8))
        } catch {
            // The only way this fails with a correct-looking box is a wrong
            // key or a blob edited on disk; both read to the user as the same
            // thing, and neither should leak which it was.
            throw SealedCredentialError.authenticationFailed
        }
    }

    private static func nonce() throws -> AES.GCM.Nonce {
        var bytes = Data(count: nonceBytes)
        for index in 0..<nonceBytes { bytes[index] = UInt8.random(in: 0...255) }
        return try AES.GCM.Nonce(data: bytes)
    }
}

extension SealedCredential {
    /// Reads the envelope Android writes: `iv` is the nonce and `data` is the
    /// ciphertext with the GCM tag appended, both base64.
    public init?(json: JSONObject) {
        guard let nonce = Data(base64Encoded: json.text("iv")),
              let sealed = Data(base64Encoded: json.text("data")),
              sealed.count > CredentialSeal.tagBytes else { return nil }
        self.init(
            nonce: nonce,
            ciphertext: sealed.prefix(sealed.count - CredentialSeal.tagBytes),
            tag: sealed.suffix(CredentialSeal.tagBytes)
        )
    }

    public var json: [String: Any] {
        ["iv": nonce.base64EncodedString(), "data": (ciphertext + tag).base64EncodedString()]
    }
}
