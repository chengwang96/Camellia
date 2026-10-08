import Foundation
import Security
import Tailnet

/// The private state of the embedded node.
///
/// This is the most sensitive thing Camellia stores: the keys that sign this
/// device into the tailnet, and the only thing that lets the phone reach the
/// desktop. Whoever holds it can impersonate the device.
///
/// The protocol exists so the backend can be replaced in a test harness. The
/// Keychain needs the `application-identifier` entitlement, which only a signed
/// bundle carries, so an unsigned harness cannot use it — see `makeStore` in
/// `EmbeddedNetwork` for what that costs and what it does not.
public protocol NodeStateStore: TailnetStorageProtocol {
    /// Discards everything, so the next start registers as a new device.
    func clear() throws
}

/// The private store the embedded node keeps its state in.
///
/// Ported from the `CredentialStore` plus anonymous `Storage` pair in
/// `EmbeddedNetwork.java`. Android wraps an AES-GCM key held in the
/// AndroidKeyStore around a SharedPreferences blob; iOS adds no envelope of its
/// own, because a Keychain item stored with
/// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` is already encrypted under a
/// key that never leaves the device. Re-encrypting it on top would protect
/// nothing that the Keychain does not already protect.
///
/// The contract the Go bridge depends on is identical on both platforms: one
/// opaque string per key. `bridge.go` decodes those strings with
/// `base64.StdEncoding` before handing them to `ipn`, so the values are
/// base64text and stay printable in the Keychain payload.
final class KeychainTailnetStore: NSObject, NodeStateStore {
    /// Failures the Keychain can report that the person holding the phone can
    /// act on. Anything else is surfaced verbatim as `OSStatus`.
    enum Failure: LocalizedError {
        case corrupt
        case keychain(OSStatus)
        case missingKey

        var errorDescription: String? {
            switch self {
            case .corrupt:
                return "Stored embedded network state is unreadable"
            case .keychain(let status):
                let detail = SecCopyErrorMessageString(status, nil) as String? ?? "unknown error"
                return "Keychain rejected the embedded network state: \(detail) (\(status))"
            case .missingKey:
                return "Embedded network state was written without a key"
            }
        }
    }

    private let service: String
    private let account: String
    private let lock = NSLock()

    /// `service` is normally the bundle identifier, so that two builds of
    /// Camellia signed by different identities keep separate node state.
    init(service: String, account: String = "tailnet-private") {
        self.service = service
        self.account = account
        super.init()
    }

    // MARK: - TailnetStorageProtocol

    /// A key that was never written reads back as empty and *without* an error.
    ///
    /// `stateStore.ReadState` in `bridge.go` turns an empty string into
    /// `ipn.ErrStateNotExist`, which is how tsnet tells "first run" apart from
    /// "the store is broken". Reporting an error here instead would turn a
    /// first launch into a failure to start.
    func read(_ key: String?, error: NSErrorPointer) -> String {
        lock.lock()
        defer { lock.unlock() }
        guard let key, !key.isEmpty else { return "" }
        do {
            return try load()[key] ?? ""
        } catch let failure {
            error?.pointee = failure as NSError
            return ""
        }
    }

    func write(_ key: String?, value: String?) throws {
        lock.lock()
        defer { lock.unlock() }
        guard let key, !key.isEmpty else { throw Failure.missingKey }
        var state = try load()
        state[key] = value ?? ""
        try save(state)
    }

    /// Drops the node identity, so the next start registers as a new device.
    /// Backs `EmbeddedNetwork.forget()`.
    func clear() throws {
        lock.lock()
        defer { lock.unlock() }
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw Failure.keychain(status)
        }
    }

    // MARK: - Keychain

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private func load() throws -> [String: String] {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        switch SecItemCopyMatching(query as CFDictionary, &item) {
        case errSecSuccess:
            guard let data = item as? Data else { return [:] }
            guard let state = try? JSONDecoder().decode([String: String].self, from: data) else {
                throw Failure.corrupt
            }
            return state
        case errSecItemNotFound:
            return [:]
        case let status:
            throw Failure.keychain(status)
        }
    }

    private func save(_ state: [String: String]) throws {
        let data = try JSONEncoder().encode(state)
        var attributes: [String: Any] = [kSecValueData as String: data]
        // The node state signs the device into the tailnet, so it is kept off
        // backups and off other devices on purpose: a fresh install should
        // register as a new device rather than silently adopt an old identity.
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly

        switch SecItemUpdate(baseQuery() as CFDictionary, attributes as CFDictionary) {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var insert = baseQuery()
            insert.merge(attributes) { _, new in new }
            let status = SecItemAdd(insert as CFDictionary, nil)
            guard status == errSecSuccess else { throw Failure.keychain(status) }
        case let status:
            throw Failure.keychain(status)
        }
    }
}
