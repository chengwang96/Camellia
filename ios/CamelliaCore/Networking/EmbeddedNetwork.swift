import Foundation
import Network
import Tailnet

/// Owns the embedded Tailscale node the phone dials the desktop through.
///
/// Ported from `EmbeddedNetwork.java`. The embedded node runs in userspace
/// inside this process, so it needs no VPN profile and no network extension;
/// only Camellia's own requests travel through the tunnel.
///
/// The shape of the port follows the original closely, because the parts that
/// look incidental are not:
///
/// * the node is **rebuilt whenever the underlying route changes**, because
///   tsnet binds its sockets at start-up and a Wi-Fi-to-cellular switch leaves
///   it dialling from a dead interface;
/// * the rebuild is **deferred by a short delay**, so that a switch which
///   produces several path updates in a row restarts the node once;
/// * the node **outlives backgrounding by five minutes**, so a transfer that
///   was already in flight can finish before the tunnel is torn down.
public final class EmbeddedNetwork {
    public static let shared = EmbeddedNetwork()

    /// Failures that stop the node from starting, tagged with the same code the
    /// Go bridge would have raised, so one wording table covers both.
    public struct Failure: LocalizedError {
        public let code: ConnectionFailureCode
        public let detail: String?

        public var errorDescription: String? { message(chinese: false) }

        public func message(chinese: Bool) -> String {
            guard let detail, !detail.isEmpty else { return code.text(chinese: chinese) }
            return code.text(chinese: chinese) + "\n" + detail
        }
    }

    /// The node state as `bridge.go` serialises it.
    public struct Status: Decodable, Sendable {
        public let state: String
        public let loginUrl: String
    }

    /// How long the tunnel survives after the app leaves the foreground.
    private static let backgroundGrace: TimeInterval = 5 * 60
    /// How long to wait for a path change to settle before rebuilding.
    private static let routeSettleDelay: TimeInterval = 0.4

    private let lock = NSRecursiveLock()
    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "app.camellia.embedded-network.monitor")
    private let worker = DispatchQueue(label: "app.camellia.embedded-network.worker")

    private var node: TailnetNode?
    private var nodeRevision: Int64 = -1
    private var revision: Int64 = 0
    private var stale = false
    private var started = false
    private var online = true
    private var routeWorkItem: DispatchWorkItem?
    private var routeGeneration: Int64 = 0
    private var backgroundDeadline: Date?
    private var transfers = 0
    private var listener: (() -> Void)?

    /// Whether the interface list is injected before the node starts.
    ///
    /// Android must inject it, because the platform blocks the netlink socket
    /// tsnet would enumerate interfaces with. Darwin backs `net.Interfaces()`
    /// with `getifaddrs`, which the iOS sandbox permits — the smoke run
    /// enumerates all 25 interfaces without it — so the injection is off. The
    /// switch is kept for a device where the default discovery misbehaves.
    /// `CAMELLIA_INJECT_INTERFACES=1` forces it on for a run.
    public var injectsInterfaces =
        ProcessInfo.processInfo.environment["CAMELLIA_INJECT_INTERFACES"] == "1"

    /// Builds the store the node keeps its private state in.
    ///
    /// The default is the Keychain, and a shipping build needs nothing else:
    /// Xcode grants every signed app the `application-identifier` entitlement
    /// the Keychain checks for, on a free Apple ID as much as a paid one.
    ///
    /// A test harness is the exception. An unsigned bundle cannot carry that
    /// entitlement, and the simulator refuses to launch a bundle that *claims*
    /// it without a provisioning profile, so a harness has to be unsigned and
    /// therefore cannot reach the Keychain at all. Replacing this factory with a
    /// file-backed store is what lets the harness run. Only the key-value
    /// backend changes; the tsnet start-up path under test is the same code.
    public var makeStore: () -> NodeStateStore = {
        KeychainTailnetStore(service: Bundle.main.bundleIdentifier ?? "app.camellia.mobile")
    }

    private init() {}

    // MARK: - Lifecycle

    /// Starts watching the network path. Safe to call more than once.
    public func start() {
        lock.lock()
        defer { lock.unlock() }
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] path in
            self?.pathChanged(path)
        }
        monitor.start(queue: monitorQueue)
    }

    private func pathChanged(_ path: NWPath) {
        let reachable = path.status == .satisfied
        lock.lock()
        online = reachable
        lock.unlock()
        // The callback itself means the system path changed. Comparing only
        // reachability or interface names would miss one Wi-Fi network being
        // replaced by another while both remain "satisfied" on `en0`.
        routeChanged()
    }

    private func routeChanged() {
        lock.lock()
        routeWorkItem?.cancel()
        routeGeneration += 1
        let generation = routeGeneration
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.lock.lock()
            guard generation == self.routeGeneration else {
                self.lock.unlock()
                return
            }
            self.revision += 1
            let listener = self.listener
            self.routeWorkItem = nil
            self.lock.unlock()
            DispatchQueue.main.async { listener?() }
        }
        routeWorkItem = item
        lock.unlock()
        worker.asyncAfter(deadline: .now() + Self.routeSettleDelay, execute: item)
    }

    /// The app came back to the foreground.
    public func foreground() {
        lock.lock()
        if let deadline = backgroundDeadline, Date() >= deadline { stale = true }
        backgroundDeadline = nil
        lock.unlock()
        // `NWPathMonitor.cancel()` is terminal; a cancelled instance cannot be
        // started again. The monitor stays registered while the process is
        // suspended. Refresh the synchronous reachability label here; any real
        // path callback queued while asleep still performs the debounced node
        // rebuild through `pathChanged`.
        lock.lock()
        online = monitor.currentPath.status == .satisfied
        lock.unlock()
    }

    /// The app left the foreground. The tunnel is kept for `backgroundGrace`
    /// so an in-flight transfer can finish.
    public func background() {
        lock.lock()
        backgroundDeadline = Date().addingTimeInterval(Self.backgroundGrace)
        lock.unlock()
    }

    /// Called by the platform when the extra background time is spent.
    public func endBackground() {
        lock.lock()
        backgroundDeadline = Date()
        let expired = hasExpiredLocked()
        lock.unlock()
        if expired { close() }
    }

    /// Keeps the tunnel alive while bytes are moving, regardless of the grace
    /// period.
    public func retainTransfer() {
        lock.lock()
        transfers += 1
        lock.unlock()
    }

    public func releaseTransfer() {
        lock.lock()
        transfers = max(0, transfers - 1)
        let expired = hasExpiredLocked()
        lock.unlock()
        if expired { close() }
    }

    /// Called when the node is rebuilt or the path changes, so the UI can
    /// re-subscribe.
    public func setListener(_ listener: (() -> Void)?) {
        lock.lock()
        self.listener = listener
        lock.unlock()
    }

    public var isOnline: Bool {
        lock.lock()
        defer { lock.unlock() }
        return online
    }

    // MARK: - Mode

    private static let modeKey = "network-mode.embedded"

    /// Whether Camellia should reach the desktop through the embedded network
    /// at all. Defaults to on, matching Android.
    public var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: Self.modeKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.modeKey)
            if !newValue { worker.async { [weak self] in self?.close() } }
        }
    }

    // MARK: - The node

    /// The running node, started on first use.
    public func currentNode() throws -> TailnetNode {
        lock.lock()
        defer { lock.unlock() }

        if let node, !stale, nodeRevision == revision { return node }
        closeLocked()

        guard isEnabled else {
            throw Failure(code: .networkStopped, detail: nil)
        }

        do {
            if injectsInterfaces {
                // Go applies this through sync.Once, so repeated calls are
                // harmless and the first one wins.
                TailnetSetInterfaces(InterfaceSnapshot())
            }
            let directory = try stateDirectory()
            let store = makeStore()
            var failure: NSError?
            guard let created = TailnetNewNode(directory.path, store, &failure) else {
                throw failure ?? Failure(code: .networkStartFailed, detail: nil)
            }
            node = created
            nodeRevision = revision
            stale = false
            return created
        } catch let error as Failure {
            throw error
        } catch {
            throw Failure(code: .networkStartFailed, detail: error.localizedDescription)
        }
    }

    /// The current node state, or `nil` when the node is not running.
    public func status() throws -> Status {
        let running = try currentNode()
        var failure: NSError?
        // `status` returns a non-null string, so Swift keeps the error as an
        // out-parameter instead of turning the call into a throw.
        let text = running.status(&failure)
        if let failure { throw failure }
        return try JSONDecoder().decode(Status.self, from: Data(text.utf8))
    }

    /// Starts the interactive sign-in. The URL to open comes from `status()`.
    public func login() throws {
        try currentNode().login()
    }

    public func close() {
        lock.lock()
        defer { lock.unlock() }
        closeLocked()
    }

    private func closeLocked() {
        stale = false
        node?.close()
        node = nil
        nodeRevision = -1
    }

    /// Drops the stored node identity as well as the live node. The next start
    /// registers as a brand new device in the tailnet.
    public func forget() throws {
        lock.lock()
        defer { lock.unlock() }
        closeLocked()
        try makeStore().clear()
    }

    private func hasExpiredLocked() -> Bool {
        guard let deadline = backgroundDeadline else { return false }
        return node != nil && transfers == 0 && Date() >= deadline
    }

    // MARK: - Details

    /// Private state, kept out of iCloud and out of iTunes backups.
    ///
    /// The node identity is what signs this device into the tailnet, and it is
    /// also the only thing that lets the phone reach the desktop. A restored
    /// copy on another device would silently adopt that identity, so the whole
    /// directory is excluded from backup the same way Android keeps it under
    /// `getNoBackupFilesDir()`.
    private func stateDirectory() throws -> URL {
        let manager = FileManager.default
        let base = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("tailnet", isDirectory: true)
        if !manager.fileExists(atPath: directory.path) {
            try manager.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
            )
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = directory
        try mutable.setResourceValues(values)
        return directory
    }

    /// Validates the sign-in URL before it is handed to the system browser.
    ///
    /// Ported from `EmbeddedNetwork.loginUrl`. Only the tailnet control plane
    /// over HTTPS is accepted; a URL carrying credentials, a port or a fragment
    /// is refused rather than opened, so a tampered `loginUrl` cannot redirect
    /// the browser somewhere else.
    public static func loginURL(_ value: String?) -> URL? {
        guard let value, let components = URLComponents(string: value) else { return nil }
        guard components.scheme == "https",
              components.host == "login.tailscale.com",
              components.user == nil,
              components.password == nil,
              components.port == nil,
              components.fragment == nil
        else { return nil }
        return components.url
    }
}
