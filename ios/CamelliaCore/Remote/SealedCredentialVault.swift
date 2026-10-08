import CryptoKit
import Foundation

/// Holds the key the credentials are sealed under.
///
/// Android asks the AndroidKeyStore for an AES key and never sees the bytes.
/// iOS has no object quite like that — the Secure Enclave does not do symmetric
/// encryption of arbitrary data — so the closest equivalent is a random key
/// kept as a Keychain item whose protection class keeps it off backups and off
/// other devices. The key is generated once and never leaves the process except
/// as keychain bytes.
///
/// `FileSecretKeyStore` is the other answer, used when the Keychain is not
/// available to the build at all.
public protocol SecretKeyStore {
    func key() throws -> SymmetricKey
}

public enum FileSecretKeyError: Error, Equatable {
    case invalidLength
}

/// A key kept in a file beside the credentials it protects.
///
/// Strictly worse than the Keychain, and only used when the Keychain is not
/// available to the build — an unsigned bundle has no `application-identifier`
/// entitlement and every Keychain call fails with `errSecMissingEntitlement`.
/// Keeping the key in a separate file from the ciphertext at least means one of
/// the two has to be found, and the app tells the user which mode it is in.
public final class FileSecretKeyStore: SecretKeyStore {
    private static let keyBytes = 32

    private let url: URL
    private let lock = NSLock()

    public init(url: URL) { self.url = url }

    public func key() throws -> SymmetricKey {
        lock.lock()
        defer { lock.unlock() }
        do {
            let data = try Data(contentsOf: url)
            guard data.count == Self.keyBytes else { throw FileSecretKeyError.invalidLength }
            return SymmetricKey(data: data)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            // Only a genuinely missing file authorizes making a new key. A
            // damaged or temporarily unreadable key must not be overwritten:
            // every stored conversation and pairing depends on its bytes.
        }
        var bytes = Data(count: Self.keyBytes)
        for index in 0..<Self.keyBytes { bytes[index] = UInt8.random(in: 0...255) }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try bytes.write(to: url, options: .atomic)
        return SymmetricKey(data: bytes)
    }
}

/// The credentials, sealed and written to a file.
///
/// One file, one JSON object, exactly the shape Android keeps in its encrypted
/// preference: the current computer at the top level and every known computer
/// under `computers`. Read back through `ComputerStore`, which owns the meaning.
///
/// Deliberately free of anything device-specific, so a write followed by a read
/// can be checked without a phone: the crypto and the stored shape are the parts
/// that quietly break, and both are pure.
public final class SealedCredentialVault: CredentialVault {
    public enum Failure: LocalizedError {
        case unreadable
        case notSaved

        public var errorDescription: String? {
            switch self {
            case .unreadable: return "Stored pairing could not be decrypted. Pair again."
            case .notSaved: return "Pairing could not be saved"
            }
        }
    }

    private let url: URL
    private let keys: SecretKeyStore
    private let lock = NSLock()

    public init(url: URL, keys: SecretKeyStore) {
        self.url = url
        self.keys = keys
    }

    public func load() throws -> JSONObject {
        lock.lock()
        defer { lock.unlock() }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return JSONObject()
        }
        guard !data.isEmpty else { throw Failure.unreadable }
        guard let envelope = try? JSONBody.object(data), let sealed = SealedCredential(json: envelope) else {
            throw Failure.unreadable
        }
        let opened = try CredentialSeal.open(sealed, using: keys.key())
        guard let object = try? JSONBody.object(opened) else { throw Failure.unreadable }
        return object
    }

    public func save(_ value: JSONObject) throws {
        lock.lock()
        defer { lock.unlock() }
        guard let payload = try? JSONSerialization.data(withJSONObject: value.raw) else {
            throw Failure.notSaved
        }
        let sealed = try CredentialSeal.seal(payload, using: keys.key())
        let envelope = try JSONSerialization.data(withJSONObject: sealed.json)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try envelope.write(to: url, options: .atomic)
        // Set after writing rather than as a write option: an atomic write
        // replaces the file, and the replacement does not inherit the old one's
        // protection attribute.
        try? (url as NSURL).setResourceValue(URLFileProtection.complete, forKey: .fileProtectionKey)
    }

    public func clear() throws {
        lock.lock()
        defer { lock.unlock() }
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }
}
