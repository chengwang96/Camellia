import CryptoKit
import Foundation
import Security

public enum SecretKeyError: Error, Equatable, CustomStringConvertible {
    /// The Keychain refused because the build carries no
    /// `application-identifier` entitlement, which is what an unsigned or
    /// ad-hoc signed bundle looks like.
    case unavailable(OSStatus)
    case keychain(OSStatus)
    case invalidKey

    public var description: String {
        switch self {
        case .unavailable(let status):
            return "The keychain is unavailable to this build (\(status)); credentials are stored without it"
        case .keychain(let status):
            let detail = SecCopyErrorMessageString(status, nil) as String? ?? "unknown error"
            return "The keychain rejected the credential key: \(detail) (\(status))"
        case .invalidKey:
            return "The keychain returned a credential key with an invalid length"
        }
    }
}

/// A key kept in the Keychain.
///
/// `WhenUnlockedThisDeviceOnly` is deliberate. It keeps the item out of backups
/// and off a restored device, which is what "cannot be impersonated by copying
/// the phone" means here. The cost is that the item cannot be read while the
/// device is locked; a background refresh that fires then has to fail and retry
/// rather than being able to read the token.
public final class KeychainSecretKeyStore: SecretKeyStore {
    private static let keyBytes = 32

    private let service: String
    private let account: String
    private let lock = NSLock()

    public init(service: String, account: String = "remote-private") {
        self.service = service
        self.account = account
    }

    public func key() throws -> SymmetricKey {
        lock.lock()
        defer { lock.unlock() }
        if let existing = try read() { return SymmetricKey(data: existing) }
        let generated = Self.randomBytes()
        do {
            try add(generated)
        } catch SecretKeyError.keychain(let status) where status == errSecDuplicateItem {
            // Another start generated a key first. Its key is the one in the
            // Keychain, so reading it back is the correct answer; failing here
            // would put this process on a key nothing else can open.
            if let existing = try read() { return SymmetricKey(data: existing) }
            throw SecretKeyError.keychain(status)
        }
        return SymmetricKey(data: generated)
    }

    /// Whether this build can hold the key in the Keychain.
    ///
    /// Asked once at startup to choose the fallback. Only a missing entitlement
    /// permits a file key. A locked device or a transient Keychain error must
    /// retain the Keychain choice: switching keys would make existing data
    /// appear undecryptable and could replace it on the next write.
    public var isAvailable: Bool {
        do {
            _ = try key()
            return true
        } catch SecretKeyError.unavailable(let status) where status == errSecMissingEntitlement {
            return false
        } catch {
            return true
        }
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private func read() throws -> Data? {
        var query = self.query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data, data.count == Self.keyBytes else {
                throw SecretKeyError.invalidKey
            }
            return data
        case errSecItemNotFound: return nil
        case errSecMissingEntitlement: throw SecretKeyError.unavailable(status)
        case errSecInteractionNotAllowed: throw SecretKeyError.keychain(status)
        default: throw SecretKeyError.keychain(status)
        }
    }

    private func add(_ bytes: Data) throws {
        var query = self.query
        query[kSecValueData as String] = bytes
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecMissingEntitlement { throw SecretKeyError.unavailable(status) }
        guard status == errSecSuccess else { throw SecretKeyError.keychain(status) }
    }

    private static func randomBytes() -> Data {
        var bytes = Data(count: keyBytes)
        for index in 0..<keyBytes { bytes[index] = UInt8.random(in: 0...255) }
        return bytes
    }
}

/// Picks the vault for the build that is running.
public enum CredentialVaultFactory {
    /// The credential file, under Application Support.
    public static func file(directory: URL? = nil) -> URL {
        let base = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("camellia-credentials", isDirectory: true)
            .appendingPathComponent("credential.json")
    }

    /// A vault whose key is in the Keychain if this build can use it, and in a
    /// file beside the ciphertext if it cannot.
    ///
    /// `degraded` reports which one was chosen, so the UI can say so rather
    /// than letting a sideloaded build look as protected as a signed one.
    public static func make(
        service: String,
        directory: URL? = nil,
        degraded: inout Bool
    ) -> CredentialVault {
        SealedCredentialVault(
            url: file(directory: directory),
            keys: keyStore(service: service, directory: directory, degraded: &degraded))
    }

    /// The key the credentials — and everything else sealed on this device, the
    /// attachment blobs included — are held under.
    ///
    /// Split out from `make` so that the attachment store can seal under the
    /// same key rather than minting a second one. Two keys would mean two
    /// Keychain items and two chances for one of them to go missing, and there
    /// is no security gained: both protect the same device's local state.
    public static func keyStore(
        service: String,
        directory: URL? = nil,
        degraded: inout Bool
    ) -> SecretKeyStore {
        let url = file(directory: directory)
        let keychain = KeychainSecretKeyStore(service: service)
        if keychain.isAvailable {
            degraded = false
            return keychain
        }
        degraded = true
        return FileSecretKeyStore(url: url.deletingLastPathComponent().appendingPathComponent("credential.key"))
    }
}
