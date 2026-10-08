import CryptoKit
import Foundation

/// Holds the bytes of a picked file, encrypted, until it is sent.
///
/// Ported from `AttachmentStore.java`. Android keeps a picked image out of its
/// preferences JSON — a base64 photo in a preference is a photo that ends up in
/// a backup and in a crash report — and seals it on disk under the same key the
/// credentials use. iOS does the same thing with the same envelope layout, so
/// the two clients are one mental model: a `camellia-blob:` reference in the
/// draft means the bytes are on disk, sealed, and `open` is what unseals them.
///
/// The layout inside a file is Android's exactly — twelve bytes of nonce, then
/// the ciphertext with the sixteen-byte GCM tag appended — which is what lets
/// `size` be a subtraction rather than a decrypt. That matters because the
/// composer asks for sizes on every redraw.
///
/// Fresh UUID files isolate concurrent writes. Ownership and in-flight leases
/// share one lock so startup collection cannot race an import or durable save.
public final class AttachmentStore: @unchecked Sendable {
    public static let prefix = "camellia-blob:"
    public static let textPrefix = "camellia-text:"
    /// Bound into the ciphertext, so a blob sealed for attachments cannot be
    /// opened as credentials or vice versa.
    public static let context = "camellia.attachments.v1"
    /// A preview is a thumbnail, not a document; never read more than this.
    public static let previewLimit = 1024 * 1024

    /// Twelve-byte nonce plus sixteen-byte tag: the overhead every stored blob
    /// carries, and the amount `size` subtracts.
    private static let overhead = CredentialSeal.nonceBytes + CredentialSeal.tagBytes

    private static let referencePattern = try? NSRegularExpression(pattern: "^camellia-(blob|text):[a-f0-9-]{36}$")

    private let directory: URL
    private let keys: SecretKeyStore
    private let ownershipLock = NSLock()
    private var owners: [String: Set<String>] = [:]
    private var leases = Set<String>()
    private var collectionEnabled = false
    private var directoryReady = false

    public init(directory: URL, keys: SecretKeyStore) {
        self.directory = directory
        self.keys = keys
        directoryReady = FileManager.default.fileExists(atPath: directory.path)
    }

    /// Whether a value names a blob this store owns rather than raw base64.
    public static func isReference(_ value: String?) -> Bool {
        guard let value, let pattern = referencePattern else { return false }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return pattern.firstMatch(in: value, options: [], range: range)?.range == range
    }

    /// How many bytes a base64 string decodes to.
    ///
    /// Computed rather than decoded, because the composer asks on every redraw
    /// and decoding a four-megabyte photo to learn its length is wasteful. The
    /// arithmetic mirrors Android's, padding included, and is only ever used to
    /// decide whether a send goes ahead.
    public static func base64DecodedSize(_ value: String) -> Int64 {
        let padding = value.hasSuffix("==") ? 2 : (value.hasSuffix("=") ? 1 : 0)
        return Int64(value.count) / 4 * 3 - Int64(padding)
    }

    // MARK: - Writing

    /// Seals bytes and returns the reference to put in the draft.
    public func save(_ bytes: Data) throws -> String {
        let reference = Self.prefix + UUID().uuidString.lowercased()
        ownershipLock.lock()
        leases.insert(reference)
        ownershipLock.unlock()
        do {
            try seal(bytes, to: file(for: reference))
        } catch {
            remove(reference)
            throw error
        }
        return reference
    }

    /// Writes the small version shown in the tray.
    public func savePreview(_ reference: String, _ bytes: Data) throws {
        try seal(bytes, to: try file(for: reference).appendingPathExtension("thumb"))
    }

    // MARK: - Reading

    /// The bytes, whether the value is a blob reference or raw base64.
    public func open(_ value: String) throws -> Data {
        guard Self.isReference(value) else {
            guard let data = Data(base64Encoded: value) else { throw AttachmentError.storageUnavailable }
            return data
        }
        return try unseal(try file(for: value))
    }

    /// The bytes, refusing anything larger than a document once opened.
    public func read(_ value: String) throws -> Data {
        guard try size(value) <= Int64(AttachmentLimits.documentMaxBytes) else { throw AttachmentError.documentTooBig }
        return try open(value)
    }

    /// The thumbnail if there is one, otherwise the file itself, capped.
    public func preview(_ value: String) throws -> Data {
        if Self.isReference(value) {
            let thumbnail = try file(for: value).appendingPathExtension("thumb")
            if FileManager.default.fileExists(atPath: thumbnail.path),
               let data = try? unseal(thumbnail) {
                return data.prefix(Self.previewLimit)
            }
        }
        return try read(value)
    }

    /// How many bytes the value carries, without decrypting it.
    public func size(_ value: String) throws -> Int64 {
        guard Self.isReference(value) else { return Self.base64DecodedSize(value) }
        let target = try file(for: value)
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: target.path),
              let count = (attributes[.size] as? NSNumber)?.int64Value,
              count >= Int64(Self.overhead) else {
            throw AttachmentError.missing
        }
        return count - Int64(Self.overhead)
    }

    // MARK: - Cleaning up

    /// Releases an uncommitted selection. Durable owners always take precedence.
    public func remove(_ value: String) {
        guard let reference = Self.canonical(value) else { return }
        ownershipLock.lock()
        defer { ownershipLock.unlock() }
        let leased = leases.remove(reference) != nil
        guard (leased || collectionEnabled), !isOwned(reference) else { return }
        unlink(reference)
    }

    /// Called only after the owner's encrypted commit succeeds.
    public func updateReferences(owner: String, references: Set<String>) {
        let next = Set(references.compactMap(Self.canonical))
        ownershipLock.lock()
        defer { ownershipLock.unlock() }
        let previous = owners[owner] ?? []
        owners[owner] = next
        leases.subtract(next)
        if collectionEnabled {
            for reference in previous.subtracting(next) where !isOwned(reference) && !leases.contains(reference) {
                unlink(reference)
            }
        }
    }

    /// A prepared edit can replace history before cancellation is acknowledged.
    /// Keep its original files until the replacement starts or rollback commits.
    public struct ReferenceHold: Sendable {
        fileprivate let owner: String
    }

    public func holdReferences(_ references: Set<String>) -> ReferenceHold {
        let hold = ReferenceHold(owner: "rollback:\(UUID().uuidString)")
        ownershipLock.lock()
        owners[hold.owner] = Set(references.compactMap(Self.canonical))
        ownershipLock.unlock()
        return hold
    }

    public func releaseHeldReferences(_ hold: ReferenceHold) {
        ownershipLock.lock()
        defer { ownershipLock.unlock() }
        let previous = owners.removeValue(forKey: hold.owner) ?? []
        if collectionEnabled {
            for reference in previous where !isOwned(reference) && !leases.contains(reference) {
                unlink(reference)
            }
        }
    }

    /// Enables collection only after every owner has been read successfully.
    /// New imports hold leases before touching disk, including their thumbnails.
    public func reconcile(requiredOwners: Set<String> = ["local", "remote"]) throws {
        ownershipLock.lock()
        defer { ownershipLock.unlock() }
        guard requiredOwners.isSubset(of: Set(owners.keys)) else { return }
        guard FileManager.default.fileExists(atPath: directory.path) else {
            collectionEnabled = true
            return
        }
        let files = try FileManager.default.contentsOfDirectory(at: directory,
            includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        let retained = owners.values.reduce(into: leases) { $0.formUnion($1) }
        for file in files {
            let name = file.pathExtension == "thumb" ? file.deletingPathExtension().lastPathComponent : file.lastPathComponent
            guard UUID(uuidString: name) != nil,
                  file.lastPathComponent == name || file.lastPathComponent == name + ".thumb",
                  let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
                  values.isRegularFile == true, values.isSymbolicLink != true else { continue }
            let reference = Self.prefix + name.lowercased()
            if !retained.contains(reference) { try? FileManager.default.removeItem(at: file) }
        }
        collectionEnabled = true
    }

    private static func canonical(_ value: String) -> String? {
        guard isReference(value) else { return nil }
        return prefix + value.split(separator: ":", maxSplits: 1)[1]
    }

    private func isOwned(_ reference: String) -> Bool {
        owners.values.contains { $0.contains(reference) }
    }

    private func unlink(_ reference: String) {
        guard let target = try? file(for: reference) else { return }
        try? FileManager.default.removeItem(at: target)
        try? FileManager.default.removeItem(at: target.appendingPathExtension("thumb"))
    }

    /// Every blob reference nested anywhere in a saved draft.
    ///
    /// Needed because a draft is stored as one JSON object and the references
    /// inside it are the only handle on the files; without a sweep, a discarded
    /// draft leaks its attachments forever.
    public static func references(in value: Any) -> Set<String> {
        var found = Set<String>()
        collect(value, into: &found)
        return found
    }

    private static func collect(_ value: Any, into found: inout Set<String>) {
        switch value {
        case let object as [String: Any]:
            for nested in object.values { collect(nested, into: &found) }
        case let array as [Any]:
            for nested in array { collect(nested, into: &found) }
        case let text as String:
            if isReference(text) { found.insert(text) }
        default:
            break
        }
    }

    // MARK: - Details

    /// Resolving, reading and discarding a reference never creates a directory.
    private func file(for reference: String) throws -> URL {
        guard Self.isReference(reference), let colon = reference.firstIndex(of: ":") else {
            throw AttachmentError.storageUnavailable
        }
        let name = String(reference[reference.index(after: colon)...])
        return directory.appendingPathComponent(name)
    }

    private func ensureDirectory() throws {
        ownershipLock.lock()
        defer { ownershipLock.unlock() }
        guard !directoryReady else { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        directoryReady = true
    }

    private func seal(_ bytes: Data, to target: URL) throws {
        let sealed = try CredentialSeal.seal(bytes, using: keys.key(), context: Self.context)
        var blob = Data()
        blob.append(sealed.nonce)
        blob.append(sealed.ciphertext)
        blob.append(sealed.tag)
        try ensureDirectory()
        try blob.write(to: target, options: .atomic)
        // Set after writing: an atomic write replaces the file, and the
        // replacement does not inherit the original's protection attribute.
        try? (target as NSURL).setResourceValue(URLFileProtection.complete, forKey: .fileProtectionKey)
    }

    private func unseal(_ target: URL) throws -> Data {
        guard let blob = try? Data(contentsOf: target),
              blob.count >= Self.overhead else {
            throw AttachmentError.missing
        }
        let nonce = blob.prefix(CredentialSeal.nonceBytes)
        let body = blob.dropFirst(CredentialSeal.nonceBytes)
        let envelope = SealedCredential(
            nonce: Data(nonce),
            ciphertext: Data(body.dropLast(CredentialSeal.tagBytes)),
            tag: Data(body.suffix(CredentialSeal.tagBytes)))
        do {
            return try CredentialSeal.open(envelope, using: keys.key(), context: Self.context)
        } catch {
            // A wrong key and an edited file read to the user as the same
            // thing; neither should leak which it was.
            throw AttachmentError.storageUnavailable
        }
    }
}
