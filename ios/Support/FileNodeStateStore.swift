import Foundation
import Tailnet

/// A file-backed stand-in for the Keychain store.
///
/// Two builds need it, for the same reason: the Keychain checks for the
/// `application-identifier` entitlement on every call, and a build that is not
/// signed the way Xcode signs one does not carry it.
///
/// * the smoke harness cannot be signed at all — signing it with a restricted
///   entitlement and no provisioning profile makes the simulator refuse to
///   launch it — so it can never reach the Keychain;
/// * a sideloaded app may or may not be signed with that entitlement, depending
///   on how it was installed, so the app probes and falls back rather than
///   refusing to start its node at all.
///
/// A build that Xcode signs uses `KeychainTailnetStore` and nothing else. This
/// keeps the same shape as the real store — one JSON object, one key at a time,
/// and a missing key read as empty rather than as an error — so only the
/// key-value backend differs from a shipping build.
final class FileNodeStateStore: NSObject, NodeStateStore {
    private let url: URL
    private let lock = NSLock()

    /// Where the smoke harness keeps node state. Deliberately *not* the
    /// directory the node itself uses, so a leftover file cannot be mistaken
    /// for real state. The app passes its own directory instead.
    static var defaultDirectory: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("camellia-smoke-state", isDirectory: true)
    }

    init(directory: URL = FileNodeStateStore.defaultDirectory) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        url = directory.appendingPathComponent("state.json")
        super.init()
    }

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
        let data = try JSONEncoder().encode(state)
        try data.write(to: url, options: .atomic)
    }

    func clear() throws {
        lock.lock()
        defer { lock.unlock() }
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }

    enum Failure: LocalizedError {
        case missingKey

        var errorDescription: String? { "Embedded network state was written without a key" }
    }

    private func load() throws -> [String: String] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
        let data = try Data(contentsOf: url)
        guard !data.isEmpty else { return [:] }
        return try JSONDecoder().decode([String: String].self, from: data)
    }
}
