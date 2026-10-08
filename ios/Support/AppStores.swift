import Foundation
import Security
import CryptoKit
import Tailnet

/// Where this process keeps the two things it must protect: the node's tailnet
/// identity and the pairing credentials.
///
/// Both want the Keychain, and both are decided by the same question — does the
/// Keychain answer this process at all? A build Xcode signs always carries the
/// `application-identifier` entitlement the Keychain checks for, on a free
/// Apple ID as much as a paid one. A sideloaded build may not, and is then
/// answered with `errSecMissingEntitlement` on every call.
///
/// The answer is probed once and the fallback is a file inside the container.
/// Which one ran is reported, because "the credential is sealed with a key in
/// the Keychain" and "the key sits in a file beside the ciphertext" are
/// different guarantees and the user is entitled to know which they got.
enum AppStores {
    static let service: String = Bundle.main.bundleIdentifier ?? "app.camellia.mobile"

    /// Probed once: whether the entitlement is there cannot change while the
    /// process lives, and the probe costs a Keychain round trip.
    private static let keychainAnswers: Bool = {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "entitlement-probe",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        // Any other status still proves the process was allowed to ask.
        return SecItemCopyMatching(query as CFDictionary, &item) != errSecMissingEntitlement
    }()

    private static let choice: (vault: CredentialVault, keys: SecretKeyStore, degraded: Bool) = {
        var degraded = false
        let keys = CredentialVaultFactory.keyStore(service: service, degraded: &degraded)
        let vault = SealedCredentialVault(url: CredentialVaultFactory.file(), keys: keys)
        return (vault, keys, degraded)
    }()

    static var credentialVault: CredentialVault { choice.vault }

    /// The sealing key, shared with the attachment blobs so the device holds
    /// one key rather than two.
    static var credentialKeys: SecretKeyStore { choice.keys }

    /// Where a picked image or document waits until it is sent.
    ///
    /// Excluded from backup for the same reason the key is: the blobs are
    /// somebody's files, and a restore onto another device should not carry
    /// them along.
    static let attachmentStore = AttachmentStore(directory: attachmentDirectory, keys: choice.keys)
    static let computerStore = ComputerStore(vault: choice.vault, attachments: attachmentStore)

    /// Called on the loading worker. An unreadable owner or preserved damaged
    /// local state prevents collection for this launch.
    static func reconcileAttachments() {
        guard !localChatRecovered, !localChatUnavailable,
              let names = try? FileManager.default.contentsOfDirectory(atPath: localChatDirectory.path),
              !names.contains(where: { $0.hasPrefix("state.corrupt-") }) else { return }
        do {
            try computerStore.synchronizeAttachmentReferences()
            try attachmentStore.reconcile()
        } catch {
            // Keep files that may belong to temporarily unreadable state.
        }
    }

    /// True when the sealing key had to go in a file instead of the Keychain.
    static var credentialsOnFile: Bool { choice.degraded }

    /// True when the node's identity had to go in a file instead.
    static var nodeStateOnFile: Bool { !keychainAnswers }

    /// Everything the local-chat screens remember: conversations, workspaces
    /// and the imported provider configuration, sealed in separate records under the
    /// same key the credentials and attachments use.
    ///
    /// Opened once. Only a structurally damaged state is moved aside. A key
    /// that is temporarily unreadable, or a failed file read, must leave the
    /// original in place and disable writes until the next launch.
    static let localChatStore: LocalChatStore = {
        do {
            return try LocalChatStore(directory: localChatDirectory, keys: choice.keys,
                                      attachments: attachmentStore)
        } catch LocalChatStoreError.corruptState {
            let state = localChatDirectory.appendingPathComponent("state")
            let stamp = Int(Date().timeIntervalSince1970)
            do {
                try FileManager.default.moveItem(
                    at: state, to: localChatDirectory.appendingPathComponent("state.corrupt-\(stamp)"))
                let fresh = try LocalChatStore(directory: localChatDirectory, keys: choice.keys,
                                               attachments: attachmentStore)
                localChatRecovered = true
                return fresh
            } catch {
                return unavailableLocalChatStore()
            }
        } catch {
            return unavailableLocalChatStore()
        }
    }()

    /// Set when the local-chat state could not be opened and was moved aside.
    private(set) static var localChatRecovered = false

    /// The original state is untouched or preserved aside, but cannot be read.
    /// Do not offer a writable empty state over the same path.
    private(set) static var localChatUnavailable = false

    private struct UnavailableKeyStore: SecretKeyStore {
        func key() throws -> SymmetricKey { throw LocalChatStoreError.storageUnavailable }
    }

    static func placeholderLocalChatStore() -> LocalChatStore {
        try! LocalChatStore(directory: FileManager.default.temporaryDirectory
            .appendingPathComponent("camellia-loading-\(UUID().uuidString)"), keys: UnavailableKeyStore())
    }

    private static func unavailableLocalChatStore() -> LocalChatStore {
        localChatUnavailable = true
        // This new, per-launch directory has no state file. The key store
        // rejects every write, so no temporary conversation can masquerade as
        // saved data or replace the protected state after a transient failure.
        return try! LocalChatStore(
            directory: FileManager.default.temporaryDirectory
                .appendingPathComponent("camellia-unavailable-\(UUID().uuidString)"),
            keys: UnavailableKeyStore())
    }

    /// The conversation list each paired computer last sent, sealed under the
    /// same key as everything else.
    ///
    /// A cache, not a store: losing it costs one fetch, so an unopenable file
    /// reads as empty rather than being moved aside and reported the way the
    /// local-chat state is.
    static let remoteListCache: RemoteListCache = {
        RemoteListCache(url: remoteCacheDirectory.appendingPathComponent("list.json"), keys: choice.keys)
    }()

    static func nodeStore() -> NodeStateStore {
        keychainAnswers
            ? KeychainTailnetStore(service: service)
            : FileNodeStateStore(directory: fallbackDirectory)
    }

    /// Where the local-chat state lives, beside the credentials.
    private static var localChatDirectory: URL {
        let manager = FileManager.default
        let base = (try? manager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                     appropriateFor: nil, create: true)) ?? manager.temporaryDirectory
        let directory = base.appendingPathComponent("camellia-localchat", isDirectory: true)
        try? manager.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = directory
        try? mutable.setResourceValues(values)
        return directory
    }

    /// Where the remote list cache lives, beside the credentials. Excluded from
    /// backup for the same reason: it is somebody's conversation titles, and a
    /// restore onto another device should not carry them along.
    private static var remoteCacheDirectory: URL {
        let manager = FileManager.default
        let base = (try? manager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                     appropriateFor: nil, create: true)) ?? manager.temporaryDirectory
        let directory = base.appendingPathComponent("camellia-remote-cache", isDirectory: true)
        try? manager.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = directory
        try? mutable.setResourceValues(values)
        return directory
    }

    /// Where sealed attachment blobs live, beside the credentials.
    private static var attachmentDirectory: URL {
        let manager = FileManager.default
        let base = (try? manager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                     appropriateFor: nil, create: true)) ?? manager.temporaryDirectory
        let directory = base.appendingPathComponent("camellia-attachments", isDirectory: true)
        try? manager.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = directory
        try? mutable.setResourceValues(values)
        return directory
    }

    /// Inside the container, and excluded from backup for the same reason the
    /// node's own directory is: this state signs the device into the tailnet,
    /// and a copy restored onto another device would adopt that identity.
    private static var fallbackDirectory: URL {
        let manager = FileManager.default
        let base = (try? manager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                     appropriateFor: nil, create: true)) ?? manager.temporaryDirectory
        let directory = base.appendingPathComponent("tailnet-fallback", isDirectory: true)
        try? manager.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = directory
        try? mutable.setResourceValues(values)
        return directory
    }
}
