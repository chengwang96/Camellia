import Foundation
import SwiftUI
import UIKit

/// The state the screens share.
///
/// Held in one place because the pairing flow, the computer list and the
/// conversation screens all change the same two things: which computer is
/// current, and whether that computer can be reached.
@MainActor
final class AppModel: ObservableObject {
    struct DetailAccessFailure {
        let status: Int
        let detail: String
        let restoredDraft: Bool
    }

    let store: ComputerStore
    let preferences: MobilePreferences
    let pairing: PairingController
    /// Whether the pairing form is on screen.
    ///
    /// Plain state, not `@Published`: nothing is drawn from it. It exists so
    /// `pairingChanged` knows whether a failure has somewhere to be read —
    /// inside the sheet, or only through the root alert, which cannot be
    /// presented on top of the sheet.
    var pairingSheetOpen = false

    @Published var computers: [PairedComputer] = []
    @Published var current: PairedComputer?
    /// What the last check found for each computer, by address.
    ///
    /// The list used to show a name and an address and nothing about whether the
    /// computer answered, so a phone with three pairings had no way to tell a
    /// live one from a dead one without opening each. Android shows the same
    /// per-row state and fills it from a bounded concurrent probe, and this is
    /// where that state lives.
    @Published var computerStates: [String: String] = [:]
    /// Whether a round of checks is in flight, so a second pull is ignored.
    @Published var checkingComputers = false
    /// Bumped when the app returns to the front or the tunnel is rebuilt.
    ///
    /// A screen that holds its own fetch — the computers sheet, whose check is
    /// not the model's to run on a timer — watches this to re-run it, which is
    /// what Android's `onStart` does by reloading whatever `screen` names.
    @Published var resumeTick = 0
    /// Bumped when something outside the composer asks it to take focus.
    ///
    /// The empty-conversation state has a "write a message" button, which is
    /// Android's `focusComposer`; the editor owns its own focus, so the request
    /// travels as a count rather than as a flag that would have to be cleared.
    @Published var composerFocusTick = 0
    @Published var conversations: [RemoteConversation] = []
    @Published var workspaces: [RemoteWorkspace] = []
    @Published var streamState: RemoteStreamState = .idle
    /// Android keeps the last one-shot 403/404 in its detail status line even
    /// while the event stream itself remains connected. It also removes the
    /// current message views without forgetting the outgoing send state.
    @Published private(set) var detailAccessFailure: DetailAccessFailure?
    @Published var listLoading = false
    @Published var listLoadingMore = false
    @Published var nextListOffset: Int64 = -1
    /// Why the last list fetch failed, when it did and there is nothing cached
    /// to show instead.
    ///
    /// Kept apart from `notice` because it has to outlive a toast: an empty list
    /// screen that says "还没有会话" while the real answer was a refused request
    /// is a lie the person cannot tell from the truth.
    @Published var listError: String?
    @Published var notice: Notice?
    /// The full status line captured when it is tapped, matching Android's
    /// selectable/copyable status-detail panel below the chat.
    @Published var statusDetails: String?

    /// The list's search text.
    ///
    /// Held here rather than in the screen so a refresh the desktop triggers
    /// through the event stream keeps filtering whatever was typed, instead of
    /// silently showing every conversation again.
    @Published var search = ""
    /// Whether the desktop allows conversations that belong to no workspace.
    ///
    /// Decides whether an empty independent group earns a heading, which is the
    /// same test Android makes with its own `allowIndependent` flag.
    @Published var includeUnassigned = false
    /// The workspace groups the user has folded away on this computer.
    ///
    /// Keyed by workspace id rather than by `address/workspace`: the model is
    /// already scoped to one computer and `select` rebuilds it from scratch, so
    /// the address would only ever be the current one. Persisted through
    /// `MobilePreferences` so the fold survives a relaunch, the way Android's
    /// `collapsed:` entries do.
    @Published var collapsedWorkspaces: Set<String> = []

    /// What this device may do on the current computer.
    ///
    /// Everything that offers an action reads this, so a read-only pairing
    /// never shows a button the desktop would refuse. It starts read-only
    /// because that is what an unpaired or silent desktop amounts to.
    @Published var access: RemoteAccess = .readOnly
    /// The engines a new conversation may be created with on the current
    /// computer. Starts as the five Android always offers and is replaced by the
    /// desktop's own list once it says one.
    @Published var availableEngines: [RemoteEngine] = RemoteEngine.fallback
    /// The engine picker waiting on the person, if a new conversation was asked
    /// for. Android opens the same panel before it sends the create command.
    @Published var engineChoice: EngineChoice?
    /// A successful remote create asks the list to push the new conversation.
    /// The list owns navigation, so the model publishes the id rather than
    /// trying to call `open` while the list is still on screen.
    @Published var createdConversationId: String?
    /// The instance the conversation list belongs to, which list-level
    /// commands have to name.
    @Published var listInstanceId = ""

    @Published var transcript = RemoteTranscript()
    @Published var openId: String?
    private struct DetailIdentity: Equatable {
        let address: String
        let token: String
        let conversationId: String
    }
    private var activeDetailIdentity: DetailIdentity?

    private func detailIdentity(for id: String) -> DetailIdentity? {
        guard let current, current.isPaired, let token = current.token else { return nil }
        return DetailIdentity(address: current.address, token: token, conversationId: id)
    }
    @Published var draft = ""
    /// Whether an earlier-messages page is in flight, so the top control can
    /// show its spinner and refuse a second request.
    @Published var loadingOlder = false
    /// Bumped once an earlier page lands, so the view can restore the reading
    /// position after the new rows are inserted above it.
    @Published var olderTick = 0
    /// The user turn being rewritten, if any.
    ///
    /// Only the newest user message is editable, because every reply below it
    /// was generated from it — rewriting an older question would leave the
    /// answers describing a prompt that no longer exists. The desktop enforces
    /// the same rule and answers `409` otherwise, so refusing here saves a
    /// round trip rather than being the rule itself.
    @Published var editingSeq: Int64?
    @Published var outgoing: OutgoingState?
    /// Presentation metadata from the same pending-command journal Android
    /// keeps until the outgoing row is settled.
    private(set) var outgoingAt: Int64 = 0
    private(set) var outgoingLegacyImage = false
    /// The desktop echoes the wire prompt, which can include a location note
    /// deliberately omitted from the user's pending bubble. Its instance and
    /// expected sequence must match too, or an older identical prompt could
    /// make an unsynced send disappear.
    private var outgoingEcho: RemoteOutgoingEcho?
    @Published var configuring = false

    /// The consent sheet waiting on the person, if the message being sent looks
    /// like it needs to know where they are.
    ///
    /// Held here rather than inside the composer so the answer survives the
    /// screen redrawing, and so the sheet is presented by whichever screen is
    /// on top rather than by the one that happened to make the request.
    @Published var locationConsent: LocationConsent?
    /// The send waiting on that sheet.
    private var pendingSend: PreparedSend?
    private let location = LocationService()

    /// The files waiting to go out with the next message.
    ///
    /// Kept as references, not bytes: the bytes are already sealed on disk, and
    /// holding twenty photos in memory so the composer can redraw is exactly
    /// what the attachment store exists to avoid.
    @Published var attachments: [RemoteAttachment] = []
    /// Small images for the tray, keyed by reference. Cleared with the
    /// selection, because a preview for a blob nobody selected is a leak.
    @Published var attachmentPreviews: [String: UIImage] = [:]
    /// Whether a pick or encode is in flight, so the send button can wait.
    @Published var attaching = false
    /// Identifies the picker/encoder currently allowed to update the tray.
    ///
    /// Switching computers resets attachment state and permits a new pick. A
    /// worker from the old computer can still finish afterwards, so the target
    /// address alone is not enough: without this token that old worker could
    /// clear the new worker's loading state or append its files to the new
    /// computer.
    private var attachmentTaskId: UUID?
    /// The conversation's files, as the desktop lists them.
    @Published var artifacts: [RemoteArtifact] = []
    @Published var artifactsLoading = false
    @Published var artifactsError: String?
    @Published var artifactsMore = false
    private var artifactsNext: Int64 = -1
    private var artifactSheetOpen = false
    private var artifactSheetGeneration = 0

    private var pendingAttachments: [RemoteAttachment] = []
    /// Composer state per conversation, so switching away and back does not
    /// lose what was typed — or the blobs attached to it, or the turn being
    /// rewritten. Android keeps the edit target the same way, which is why
    /// leaving a conversation mid-edit and returning resumes it.
    private var drafts: [String: (text: String, attachments: [RemoteAttachment], edit: Int64?)] = [:]

    @Published var nodeState = ""
    @Published var loginURL: URL?
    @Published var remoteEntryState: RemoteEntryGate = .connecting
    private var entryGate = EntryGateTracker(now: ProcessInfo.processInfo.systemUptime)
    private var entryDeadline: DispatchWorkItem?
    private var entryDeadlineRevision = 0
    private var nodeProbeRevision = 0
    private var nodeProbeSerial = 0
    private var appliedNodeProbeSerial = 0
    @Published var pairingPhase: PairingController.Phase = .idle

    /// Preferences are stored by `MobilePreferences`, but views observe this
    /// model. All preference writes therefore go through the methods below so
    /// SwiftUI redraws the root or composer immediately.
    var interfaceLocale: Locale {
        guard let tag = preferences.language.tag else { return .current }
        return Locale(identifier: tag)
    }

    var preferredColorScheme: ColorScheme? {
        switch preferences.theme {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    var usesChinese: Bool {
        switch preferences.language {
        case .simplifiedChinese: return true
        case .english: return false
        case .system:
            return Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") == true
        }
    }

    private var session: RemoteSession?
    private var remoteScreenActive = false
    private var listFetchId: UUID?
    private var deferredListRefresh = false
    private var listCursor: Int64 = -1
    private struct PendingListEvent {
        let instance: String
        let cursor: Int64
        let maySkipUnchanged: Bool
        let finish: (Result<Void, Error>) -> Void
    }
    private var pendingListEvent: PendingListEvent?
    private var searchWork: DispatchWorkItem?
    private var listPoll: DispatchWorkItem?
    private var pairingTicket = 0

    /// The pool the computer checks run on, four at a time.
    ///
    /// Four because each check blocks a thread for a tunnel round trip: one
    /// after another would make a list of five computers take five round trips
    /// to settle, and one thread per pairing would open as many sockets as the
    /// user has ever paired. Android uses the same width.
    private let computerQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 4
        queue.qualityOfService = .userInitiated
        return queue
    }()
    /// Optional first-page cache warming must never delay a status probe.
    private let computerPreloadQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 2
        queue.qualityOfService = .utility
        return queue
    }()
    /// Bumped per round so an answer from an abandoned round lands nowhere.
    private var computerGeneration = 0

    /// The list each computer last sent, so a launch draws it before the tunnel
    /// has answered.
    private let listCache = AppStores.remoteListCache
    /// Snapshots fetched ahead of a tap, so opening a recent conversation is
    /// instant rather than a blank screen and a spinner.
    private let prefetch = RemotePrefetch()
    /// Cache warming is optional work and must not queue ahead of a tap or a
    /// command on `RemoteSession`'s serial request lane.
    private let prefetchWorkQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .utility
        return queue
    }()
    /// Bumped when a prefetch round is abandoned, so a late response cannot
    /// write into a new screen's cache.
    private var prefetchGeneration = 0
    private var prefetchPlan = RemotePrefetchPlan()
    private var prefetchTimer: DispatchWorkItem?
    private var prefetchActive = false
    private var prefetchAbort: RemoteRequestCancellation?
    private var lastPrefetchInteraction = ProcessInfo.processInfo.systemUptime
    private var detailPrefetchStarted = false

    /// Which replies this phone has already shown, so the desktop's unread
    /// mark can be cleared once and not once per snapshot.
    private var readState = RemoteReadState()
    /// Whether the app is on screen. A conversation nobody is looking at has
    /// not been read, so the cursor is not moved while backgrounded.
    private var foregrounded = true

    struct Notice: Identifiable, Equatable {
        enum Kind: Equatable { case standard, rejectedSend, transportUnconfirmed }
        let id = UUID()
        let text: String
        let serious: Bool
        let kind: Kind

        init(text: String, serious: Bool, kind: Kind = .standard) {
            self.text = text
            self.serious = serious
            self.kind = kind
        }
    }

    enum OutgoingState: Equatable {
        case sending(String)
        case preparing(String)
        case accepted(String)
        case unconfirmed(String, String)
        case failed(String)
    }

    /// Android serializes user commands: one unresolved operation owns the
    /// idempotency journal until the desktop gives a terminal answer. Keeping
    /// the same invariant here prevents two callbacks from clearing each
    /// other's request record.
    @Published private(set) var commandBusy = false
    private var commandTaskId: UUID?

    init(store: ComputerStore = AppStores.computerStore) {
        self.store = store
        preferences = MobilePreferences(store: UserDefaultsPreferenceStore(), modelName: deviceModel())
        // Serial, so the five-second polls cannot overlap each other: each one
        // is scheduled only after the previous answered.
        let pairingQueue = DispatchQueue(label: "app.camellia.pairing", qos: .utility)
        // The controller's own defaults are the right ones here, and the
        // diagnostics app has been running on them: the request runs on a
        // worker queue because dialling the tunnel blocks, and the phase comes
        // back on the main queue because `pairingChanged` writes `@Published`.
        //
        // This used to override both with `{ $0() }`, which ran the dial on the
        // main thread. Two things went wrong with that: the screen froze for as
        // long as the dial took, and the whole flow — `.requesting` then
        // `.failed` — resolved inside a single turn of the run loop, so
        // `PairingView`'s `onChange` never saw the intermediate state and the
        // failure never reached the sheet.
        //
        // The polls are scheduled on a serial background queue for the same
        // reason: `DispatchScheduler` fires on the main queue by default, which
        // would hand the main thread a tunnel dial every five seconds.
        pairing = PairingController(
            transport: RemotePairingTransport(),
            store: store,
            scheduler: DispatchScheduler(queue: pairingQueue),
            clock: { Int64(Date().timeIntervalSince1970 * 1000) },
            pollInterval: 5)
        pairing.onChange = { [weak self] phase in self?.pairingChanged(phase) }
    }

    // MARK: - Preferences

    func setLanguage(_ value: AppLanguage) {
        guard preferences.language != value else { return }
        preferences.language = value
        objectWillChange.send()
    }

    func setTheme(_ value: AppTheme) {
        guard preferences.theme != value else { return }
        preferences.theme = value
        objectWillChange.send()
    }

    func setEnterMode(_ value: EnterMode) {
        guard preferences.enterMode != value else { return }
        preferences.enterMode = value
        objectWillChange.send()
    }

    func setKeepAlive(_ value: Bool) {
        guard preferences.keepAlive != value else { return }
        preferences.keepAlive = value
        objectWillChange.send()
    }

    func setDeviceName(_ value: String) {
        let trimmed = ComposerText.androidTrim(value)
        guard !trimmed.isEmpty, ComposerText.utf16Length(trimmed) <= 80 else { return }
        guard preferences.deviceName != trimmed else { return }
        preferences.deviceName = trimmed
        objectWillChange.send()
    }

    // MARK: - Boot

    func boot() {
        restartRemoteEntry()
        EmbeddedNetwork.shared.makeStore = { AppStores.nodeStore() }
        EmbeddedNetwork.shared.start()
        watchNetwork()
        reload()
        loadStoredDrafts(from: current)
        // The cached list is drawn before anything can be fetched, because on
        // this platform the tunnel may never come up on its own: Android draws
        // it in `listScreen()`, the moment the screen is built, and a launch
        // that waits for the node instead shows an empty screen for as long as
        // the sign-in takes — and forever if it is never signed in, which is a
        // screen that says the desktop has no conversations when the truth is
        // that nobody has asked it yet.
        loadCachedList()
        // Nothing can be reached before the tunnel is up, pairing included, so
        // the node is watched from launch rather than asked for lazily on the
        // first request. If a computer is already paired the list is marked as
        // loading straight away, because the first fetch cannot start until the
        // node reports Running.
        if current?.isPaired == true { listLoading = true }
        Task { await watchNode() }
    }

    /// Subscribes to the tunnel being rebuilt, which is when a stream has to be
    /// reopened.
    ///
    /// The listener is cleared in the background and set again on the way back,
    /// the same lifetime Android gives it between `onStart` and `onStop`.
    private func watchNetwork() {
        EmbeddedNetwork.shared.setListener { [weak self] in
            self?.networkRouteChanged()
        }
    }

    func foreground() {
        foregrounded = true
        EmbeddedNetwork.shared.foreground()
        watchNetwork()
        restartRemoteEntry()
        refreshNode()
        // Coming back to the front is the one moment the screen is known to be
        // suspect: iOS tears the tunnel's sockets down while the app is
        // suspended, so whatever is on screen may be minutes old and the stream
        // behind it is holding a socket that is gone. Android reloads the
        // current screen here for the same reason.
        resumeTick += 1
        resume()
    }

    func background() {
        foregrounded = false
        // A command may have reached the desktop even if iOS suspends before
        // its answer. Keep the persisted request id, but do not leave a
        // spinner blocking the foreground reconnect or poll it off-screen.
        abandonActiveCommand()
        // A suspended probe cannot finish the visible refresh. Let the next
        // foreground visit start a new round; late answers keep decrementing
        // their own continuation but cannot repaint the computer rows.
        computerGeneration += 1
        checkingComputers = false
        computerPreloadQueue.cancelAllOperations()
        cancelPrefetch()
        listPoll?.cancel()
        stashDraft()
        EmbeddedNetwork.shared.setListener(nil)
        EmbeddedNetwork.shared.background()
        if !preferences.keepAlive { EmbeddedNetwork.shared.endBackground() }
    }

    /// The platform says the extra background time is spent.
    func endBackground() {
        EmbeddedNetwork.shared.endBackground()
    }

    /// The tunnel was rebuilt — a network change, or the node coming back after
    /// a spell in the background.
    ///
    /// Android routes this through its `networkRouteChanged`; the work is the
    /// same, keyed off which screen is open rather than off Android's `screen`
    /// string. Nothing is re-subscribed while offline, because a stream opened
    /// now would fail on the way out; the reconnect happens on the next route
    /// change, which is what the going-online event is.
    private func networkRouteChanged() {
        restartRemoteEntry()
        refreshNode()
        objectWillChange.send()
        guard foregrounded, EmbeddedNetwork.shared.isOnline else { return }
        resumeTick += 1
        resume()
    }

    /// Reopens whatever subscription the open screen depends on.
    ///
    /// Opening a conversation replaces the list stream with the conversation's
    /// own, so the two cases are exclusive and the open one is the one to
    /// rebuild. Both paths refetch as well as re-subscribe, so anything that
    /// happened while the phone was away is drawn rather than left to the next
    /// event to reveal.
    private func resume() {
        guard remoteScreenActive, foregrounded, current?.isPaired == true,
              session != nil, !commandBusy else { return }
        if let id = openId {
            open(id)
            return
        }
        startListStream()
        refreshList()
    }

    /// Follows the node's own state and connects once it can carry traffic.
    private func watchNode() async {
        var wasRunning = false
        while !Task.isCancelled {
            let revision = nodeProbeRevision
            nodeProbeSerial += 1
            let serial = nodeProbeSerial
            let observation = await readNode()
            guard revision == nodeProbeRevision, serial >= appliedNodeProbeSerial else {
                wasRunning = false
                continue
            }
            appliedNodeProbeSerial = serial
            acceptNode(observation)
            let running = NodeState(raw: observation.state).isRunning
            // Only on the edge: a node that stays up must not have its session
            // torn down and rebuilt every time this loop comes round.
            if running, !wasRunning, current?.isPaired == true {
                connect()
            }
            wasRunning = running
            // A node that is waiting on a sign-in changes the moment the person
            // finishes it, so it is polled closely; one that is up only needs
            // checking for a drop.
            try? await Task.sleep(nanoseconds: running ? 10_000_000_000 : 2_000_000_000)
        }
    }

    private struct NodeObservation {
        let state: String
        let loginURL: URL?
        let failed: Bool
    }

    private func readNode() async -> NodeObservation {
        if !EmbeddedNetwork.shared.isEnabled {
            return NodeObservation(state: EmbeddedNetwork.shared.isOnline ? "Running" : "Stopped",
                                   loginURL: nil, failed: false)
        }
        let result = await withCheckedContinuation {
            (continuation: CheckedContinuation<(EmbeddedNetwork.Status?, Bool), Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    continuation.resume(returning: (try EmbeddedNetwork.shared.status(), false))
                } catch {
                    continuation.resume(returning: (nil, true))
                }
            }
        }
        return NodeObservation(state: result.0?.state ?? "",
                               loginURL: EmbeddedNetwork.loginURL(result.0?.loginUrl),
                               failed: result.1)
    }

    private func acceptNode(_ observation: NodeObservation) {
        nodeState = observation.state
        loginURL = observation.loginURL
        let old = remoteEntryState
        remoteEntryState = entryGate.observe(
            now: ProcessInfo.processInfo.systemUptime,
            online: EmbeddedNetwork.shared.isOnline,
            embedded: EmbeddedNetwork.shared.isEnabled,
            node: NodeState(raw: observation.state),
            hasLoginURL: observation.loginURL != nil,
            failed: observation.failed)
        if remoteEntryState != old {
            if remoteEntryState == .connecting { armEntryDeadline() }
            else { cancelEntryDeadline() }
        }
    }

    private func cancelEntryDeadline() {
        entryDeadlineRevision += 1
        entryDeadline?.cancel()
        entryDeadline = nil
    }

    /// The deadline is independent of the probe, because creating or asking a
    /// node can itself block beyond thirty seconds.
    private func armEntryDeadline() {
        cancelEntryDeadline()
        let revision = entryDeadlineRevision
        let remaining = entryGate.remaining(now: ProcessInfo.processInfo.systemUptime)
        let work = DispatchWorkItem { [weak self] in
            guard let self, revision == self.entryDeadlineRevision,
                  self.remoteEntryState == .connecting else { return }
            self.remoteEntryState = .timedOut
            self.entryDeadline = nil
        }
        entryDeadline = work
        DispatchQueue.main.asyncAfter(deadline: .now() + remaining, execute: work)
    }

    /// Whether the node is up and carrying traffic.
    var nodeStatus: NodeState { NodeState(raw: nodeState) }

    var nodeRunning: Bool { nodeStatus.isRunning }

    /// External mode follows the system VPN route, not the embedded node.
    /// Android makes its home entry ready whenever that route is online;
    /// whether the VPN actually reaches a computer is checked by the request.
    var remoteReady: Bool {
        remoteEntryState == .ready
    }

    /// Whether Tailscale still needs the person to sign this device in.
    var needsLogin: Bool { nodeStatus.awaitsSignIn }

    func networkModeChanged() {
        nodeState = ""
        loginURL = nil
        restartRemoteEntry()
        refreshNode()
        if EmbeddedNetwork.shared.isOnline, current?.isPaired == true {
            connect()
        } else {
            session?.shutdown()
            session = nil
            transcript.suspend()
        }
        objectWillChange.send()
    }

    /// What to call the current node state on screen.
    var nodeLabel: String { nodeStatus.label() }

    /// Reads the node's status once, for a screen that wants to refresh itself.
    func refreshNode() {
        let revision = nodeProbeRevision
        nodeProbeSerial += 1
        let serial = nodeProbeSerial
        Task { @MainActor in
            let observation = await readNode()
            guard revision == nodeProbeRevision, serial >= appliedNodeProbeSerial else { return }
            appliedNodeProbeSerial = serial
            acceptNode(observation)
        }
    }

    func retryRemoteEntry() {
        restartRemoteEntry()
        refreshNode()
    }

    private func restartRemoteEntry() {
        nodeProbeRevision += 1
        entryGate.restart(now: ProcessInfo.processInfo.systemUptime)
        remoteEntryState = .connecting
        armEntryDeadline()
    }

    // MARK: - Computers

    func reload() {
        do {
            computers = try store.all()
            current = try store.current()
            // A state for a computer that is gone is a row that no longer
            // exists; keeping it would only grow the dictionary across
            // pair-and-forget cycles.
            let known = Set(computers.map { $0.address })
            computerStates = computerStates.filter { known.contains($0.key) }
        } catch {
            notice = Notice(text: Self.describe(error), serious: true)
        }
    }

    /// What to show for one computer's status line.
    func computerState(_ address: String) -> String {
        computerStates[address] ?? ComputerStatus.unchecked
    }

    /// Checks every paired computer at once, four at a time.
    ///
    /// Mirrors Android's `refreshComputers`: every row goes to "checking"
    /// immediately so the list settles as a whole rather than one row at a
    /// time. A successful status probe also fetches the first list page into
    /// the sealed cache, as Android does on the computers screen. A `401` is taken as the desktop
    /// having revoked this device — which is the one answer that has to throw
    /// the caches away, because the titles sealed under that token are for a
    /// pairing that no longer exists.
    ///
    /// Nothing is reported through `notice`: a computer that is simply asleep is
    /// the normal case for this screen, and it already says so on its own row.
    func refreshComputers() async {
        guard !checkingComputers else { return }
        // Presence of a token, not its shape: Android probes any computer that
        // has one and lets the desktop answer, which is the only authority on
        // whether a token is still good anyway.
        let targets = computers.filter { $0.isPaired && $0.token != nil }
        guard !targets.isEmpty else { return }
        let chinese = usesChinese
        computerGeneration += 1
        let ticket = computerGeneration
        computerPreloadQueue.cancelAllOperations()
        checkingComputers = true
        for computer in targets { computerStates[computer.address] = ComputerStatus.checking }

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            var remaining = targets.count
            for computer in targets {
                // Captured strongly on purpose: the block is short-lived, and a
                // weak self that had gone would return before decrementing
                // `remaining`, leaving the continuation — and the pull-to-refresh
                // spinner waiting on it — stuck forever.
                computerQueue.addOperation { [self] in
                    let result = Self.check(computer, chinese: chinese)
                    DispatchQueue.main.async {
                        // Skipping the write is not enough on its own: the
                        // continuation has to run regardless, or a round that
                        // was superseded would leave its pull-to-refresh
                        // spinner turning forever.
                        if ticket == self.computerGeneration {
                            if let token = result.revoked {
                                self.revokeComputer(address: result.address, token: token, announce: false)
                            }
                            self.computerStates[result.address] = result.state
                            if let status = result.status {
                                self.preloadComputerList(computer, status: status, ticket: ticket)
                            }
                        }
                        remaining -= 1
                        let finished = remaining == 0
                        if finished {
                            if ticket == self.computerGeneration { self.checkingComputers = false }
                            continuation.resume()
                        }
                    }
                }
            }
        }
    }

    /// Warms the list cache without making the status spinner wait for a second
    /// round trip. A separate low-priority queue keeps these optional requests
    /// from occupying the four slots reserved for status probes. A newer round
    /// cancels preloads that have not started; late answers are ticket-guarded.
    private func preloadComputerList(_ computer: PairedComputer, status: RemoteStatus, ticket: Int) {
        guard foregrounded, let token = computer.token, let endpoint = computer.endpoint else { return }
        computerPreloadQueue.addOperation { [self] in
            do {
                let body = try RemoteApi(endpoint: endpoint, token: token)
                    .json("/v1/conversations?offset=0")
                // Android's computer-list preload rejects a missing list;
                // otherwise a malformed reply could replace a useful cache
                // with a falsely empty one.
                guard body.raw["conversations"] is [Any] else { return }
                let page = RemoteListPage(body)
                DispatchQueue.main.async {
                    guard ticket == self.computerGeneration, self.foregrounded,
                          self.computers.contains(where: { $0.address == computer.address && $0.token == token })
                    else { return }
                    let owner = RemotePrefetchPlan.Owner(address: computer.address, token: token,
                                                         endpoint: endpoint)
                    self.schedulePrefetch(owner, rows: page.conversations,
                                          nextOffset: page.nextOffset, initial: true)
                    // The current list may have fetched newer pages in parallel.
                    // A one-page probe must not replace them.
                    if self.current?.address == computer.address && !self.conversations.isEmpty { return }
                    self.listCache.save(address: computer.address, token: token,
                                        conversations: page.conversations, nextOffset: page.nextOffset,
                                        workspaces: status.workspaces,
                                        includeUnassigned: status.includeUnassigned)
                }
            } catch {
                guard (error as? RemoteApi.Failure)?.status == 401 else { return }
                DispatchQueue.main.async {
                    guard ticket == self.computerGeneration, self.foregrounded,
                          self.computers.contains(where: { $0.address == computer.address && $0.token == token })
                    else { return }
                    self.revokeComputer(address: computer.address, token: token, announce: false)
                    self.computerStates[computer.address] = ComputerStatus.failure(
                        status: 401, detail: "", message: error.localizedDescription,
                        online: EmbeddedNetwork.shared.isOnline, chinese: self.usesChinese)
                }
            }
        }
    }

    /// One computer's check, run off the main thread.
    ///
    /// `nonisolated` because it blocks: `RemoteApi.status()` waits on a tunnel
    /// round trip, and four of those on the main actor would freeze the list
    /// they are trying to fill in.
    nonisolated private static func check(_ computer: PairedComputer, chinese: Bool) -> ComputerCheck {
        // A row that cannot even be addressed is not "awaiting a check" — it is
        // a failure, and saying so is more honest than leaving it grey forever.
        // The caller only offers paired computers, so this is a corrupt store
        // rather than a normal state.
        guard computer.isPaired, let token = computer.token, let endpoint = computer.endpoint else {
            let state = ComputerStatus.failure(status: nil, detail: "", message: "Invalid credential",
                                               online: EmbeddedNetwork.shared.isOnline, chinese: chinese)
            return ComputerCheck(address: computer.address, state: state, revoked: nil, status: nil)
        }
        do {
            let api = try RemoteApi(endpoint: endpoint, token: token)
            let status = try api.status()
            return ComputerCheck(address: computer.address, state: ComputerStatus.connected,
                                 revoked: nil, status: status)
        } catch {
            let failure = error as? RemoteApi.Failure
            // The bridge reports a protocol mismatch as its own error, and
            // Android folds it back to the same `Unsupported protocol` text the
            // classifier knows, so the row reads the same on both platforms.
            var message = error.localizedDescription
            if let apiError = error as? RemoteApiError, case .unsupportedProtocol = apiError {
                message = "Unsupported protocol"
            }
            let state = ComputerStatus.failure(status: failure?.status,
                                               detail: failure?.detail ?? "",
                                               message: message,
                                               online: EmbeddedNetwork.shared.isOnline, chinese: chinese)
            return ComputerCheck(address: computer.address, state: state,
                                 revoked: failure?.status == 401 ? token : nil, status: nil)
        }
    }

    /// One computer's check result, carried back to the main actor.
    private struct ComputerCheck: Sendable {
        let address: String
        let state: String
        /// The token whose caches the desktop just refused, if it did.
        let revoked: String?
        /// The successful response also carries the workspace fields that a
        /// list-page preload must preserve, including for older desktops.
        let status: RemoteStatus?
    }

    /// Removes a token the desktop has rejected while retaining the address,
    /// local label, drafts and device id needed to explain and repair the
    /// pairing. Android performs the same transition on an authenticated 401.
    private func revokeComputer(address: String, token: String, announce: Bool = true) {
        if current?.address == address { stashDraft() }
        do {
            var revoked = false
            let updated = try store.update(address: address) { computer in
                // A late 401 from an older probe must not revoke credentials
                // that a newer pairing has already replaced.
                guard computer.token == token else { return }
                computer.token = nil
                computer.permission = nil
                revoked = true
            }
            guard revoked else { adopt(updated); return }
            listCache.remove(address: address, token: token)
            prefetch.forgetComputer(address: address, token: token)
            if let endpoint = try? Endpoint(address) {
                prefetchPlan.remove(.init(address: address, token: token, endpoint: endpoint))
            }
            adopt(updated)
            if current?.address == address {
                resetComputerContext()
                if announce {
                    notice = Notice(text: "凭据已失效、配对已过期或被拒绝，请重新配对。", serious: true)
                }
            }
        } catch {
            if announce { notice = Notice(text: Self.describe(error), serious: true) }
        }
    }

    @discardableResult
    private func handleAuthenticatedFailure(_ error: Error, session: RemoteSession) -> Bool {
        guard (error as? RemoteHttpError)?.status == 401 else { return false }
        guard let token = session.computer.token else { return true }
        revokeComputer(address: session.computer.address, token: token)
        return true
    }

    /// Android drops displayed detail and its prefetch entry after any 403 or
    /// 404, whether it came from the stream, a snapshot, or a command. A 404
    /// also releases a command that this conversation can no longer acknowledge.
    @discardableResult
    private func discardDeniedDetail(error: RemoteHttpError, session: RemoteSession) -> Bool {
        let status = error.status
        // Removing cached entries alone is not enough: a speculative request
        // already in flight could write the refused snapshot back afterward.
        cancelPrefetch()
        if let token = session.computer.token {
            if status == 403 || openId == nil {
                prefetch.forgetComputer(address: session.computer.address, token: token)
            } else if let id = openId {
                prefetch.forget(address: session.computer.address, token: token, id: id)
            }
        }
        guard let id = openId else { return false }
        let restored = status == 404 && releasePendingForUnavailableConversation(id)
        transcript.hideMessagesAfterAccessFailure()
        detailAccessFailure = DetailAccessFailure(status: status, detail: error.detail,
                                                  restoredDraft: restored)
        publish()
        return restored
    }

    private func acceptStreamState(_ state: RemoteStreamState, session: RemoteSession) {
        if case .failed(let error?) = state,
           handleAuthenticatedFailure(error, session: session) { return }
        if case .failed(let error?) = state,
           let http = error as? RemoteHttpError,
           http.status == 403 || http.status == 404 {
            discardDeniedDetail(error: http, session: session)
        }
        if openId != nil {
            if case .connected = state {
                // The snapshot callback applies the fresh permission.
            } else {
                // Android clears `connected` when a detail stream ends. A
                // cached control permission must not enable commands while
                // the stream is reconnecting or has failed.
                transcript.suspend()
            }
        }
        streamState = state
        if case .unsupported = state, openId == nil {
            scheduleListPoll(session)
        } else {
            listPoll?.cancel()
        }
    }

    /// A desktop without list events is still kept current every 15 seconds.
    /// The stream's 404 is not itself a failed connection.
    private func scheduleListPoll(_ session: RemoteSession) {
        listPoll?.cancel()
        guard foregrounded, self.session === session, openId == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.foregrounded, self.session === session,
                  self.openId == nil else { return }
            guard case .unsupported = self.streamState else { return }
            self.refreshList()
        }
        listPoll = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: work)
    }

    @discardableResult
    func select(_ address: String) -> Bool {
        guard address != current?.address else { return true }
        do {
            stashDraft()
            let selected = try store.select(address)
            current = selected
            resetComputerContext()
            connect()
            return true
        } catch {
            notice = Notice(text: Self.describe(error), serious: true)
            return false
        }
    }

    /// Clears everything whose meaning is scoped to one desktop.
    ///
    /// This is deliberately one operation for selecting, forgetting and
    /// approving a computer. Leaving even one field behind is observable: a
    /// newly selected read-only computer could briefly inherit the old one's
    /// create controls, an empty workspace could show the old workspace rows,
    /// or a late command callback could put an attachment back under the new
    /// computer. The session generation drops late callbacks before the
    /// published state is reset.
    private func resetComputerContext() {
        session?.shutdown()
        session = nil
        location.cancel()
        pendingSend = nil
        locationConsent = nil

        transcript.reset()
        conversations = []
        workspaces = []
        streamState = .idle
        detailAccessFailure = nil
        listLoading = false
        listLoadingMore = false
        nextListOffset = -1
        listFetchId = nil
        deferredListRefresh = false
        listCursor = -1
        pendingListEvent = nil
        searchWork?.cancel()
        listPoll?.cancel()
        listError = nil
        search = ""
        includeUnassigned = false
        collapsedWorkspaces = []
        access = .readOnly
        availableEngines = RemoteEngine.fallback
        engineChoice = nil
        createdConversationId = nil
        listInstanceId = ""

        openId = nil
        activeDetailIdentity = nil
        loadingOlder = false
        olderTick = 0
        outgoing = nil
        outgoingEcho = nil
        outgoingAt = 0
        outgoingLegacyImage = false
        configuring = false
        commandBusy = false
        commandTaskId = nil
        attaching = false
        attachmentTaskId = nil
        artifacts = []
        artifactsLoading = false
        artifactsError = nil
        artifactsMore = false
        artifactsNext = -1
        clearComposerMemory()
        loadStoredDrafts(from: current)

        // A prefetch walk begun on the last computer is abandoned: the
        // generation bump makes any answer still in flight land nowhere.
        cancelPrefetch()
        publish()
    }

    /// Clears only the in-memory state for the computer being left.
    ///
    /// Drafts are encrypted in that computer's stored profile and must survive
    /// switching away, relaunching, and returning later. Their blobs are
    /// removed only when the profile is forgotten or a persisted draft stops
    /// referencing them.
    private func clearComposerMemory() {
        drafts = [:]
        draft = ""
        attachments = []
        attachmentPreviews = [:]
        pendingAttachments = []
        editingSeq = nil
        publish()
    }

    func rename(_ address: String, to name: String) -> Bool {
        let trimmed = ComposerText.androidTrim(name)
        guard !trimmed.isEmpty, ComposerText.utf16Length(trimmed) <= 80 else {
            notice = Notice(text: "请输入 1–80 个字符的名称。", serious: false)
            return false
        }
        do {
            try store.rename(address: address, name: trimmed)
            reload()
            return true
        } catch {
            notice = Notice(text: Self.describe(error), serious: true)
            return false
        }
    }

    func remove(_ address: String) -> Bool {
        do {
            // Read the token before the store drops it: the cache and the
            // prefetched snapshots are keyed by it, and an unremoved entry would
            // keep that computer's conversation titles sealed on disk forever
            // after the pairing that earned them is gone.
            let wasCurrent = current?.address == address
            if wasCurrent { stashDraft() }
            // `stashDraft` may have just added the visible tray's references.
            // Read the final stored profile before deleting it so those files
            // are included in the sweep.
            let removed = try store.all().first(where: { $0.address == address })
            try store.remove(address)
            if let removed {
                let references = AttachmentStore.references(in: removed.draftAttachments?.raw ?? [:])
                    .union(AttachmentStore.references(in: removed.pendingCommand?.raw ?? [:]))
                for reference in references { AppStores.attachmentStore.remove(reference) }
            }
            if let token = removed?.token {
                listCache.remove(address: address, token: token)
                prefetch.forgetComputer(address: address, token: token)
                if let endpoint = removed?.endpoint {
                    prefetchPlan.remove(.init(address: address, token: token, endpoint: endpoint))
                }
            }
            reload()
            if wasCurrent {
                resetComputerContext()
                connect()
            }
            return true
        } catch {
            notice = Notice(text: Self.describe(error), serious: true)
            return false
        }
    }

    private func pairingChanged(_ phase: PairingController.Phase) {
        pairingPhase = phase
        switch phase {
        case .approved:
            stashDraft()
            reload()
            resetComputerContext()
            connect()
        case .requesting, .awaitingApproval:
            // The controller has saved a new current computer (and then its
            // claim). Keep the picker and resume action in sync with that store.
            reload()
        case .failed(let message):
            // A refused claim may have been removed; a transport failure keeps
            // it. The stored record, not the previous in-memory copy, decides
            // whether the form can resume the pending request.
            reload()
            // The sheet reports this itself — an alert cannot be presented
            // while the sheet is up, so raising one here would either be
            // dropped or pop up later against a form that is already closed.
            // It is only worth raising for a request left waiting after the
            // sheet was dismissed, which is the case the flag marks.
            if !pairingSheetOpen { notice = Notice(text: message, serious: true) }
        case .expired:
            reload()
            if !pairingSheetOpen {
                notice = Notice(text: "配对码已过期，请在电脑上重新生成。", serious: false)
            }
        default:
            break
        }
    }

    // MARK: - Connection

    /// Android stops the remote API when leaving the remote pages. Keeping its
    /// list stream alive under Home or local chat wastes the tunnel and lets a
    /// late list answer repaint a page no longer being viewed.
    func remoteScreenChanged(active: Bool) {
        guard remoteScreenActive != active else { return }
        remoteScreenActive = active
        if active {
            connect()
        } else {
            abandonActiveCommand()
            stashDraft()
            cancelPrefetch()
            listPoll?.cancel()
            listPoll = nil
            listFetchId = nil
            listLoading = false
            listLoadingMore = false
            deferredListRefresh = false
            pendingListEvent = nil
            session?.shutdown()
            session = nil
            streamState = .idle
            detailAccessFailure = nil
            openId = nil
            activeDetailIdentity = nil
        }
    }

    /// Opens a session to the current computer and starts whatever stream the
    /// open screen needs.
    func connect() {
        guard remoteScreenActive else { return }
        abandonActiveCommand()
        session?.shutdown()
        session = nil
        pendingListEvent = nil
        let sameDetail = openId.flatMap { detailIdentity(for: $0) }
            .map { $0 == activeDetailIdentity } ?? false
        if sameDetail { transcript.suspend() } else { transcript.reset() }
        publish()
        guard let computer = current, computer.isPaired else { return }
        do {
            // The transport is built here rather than inside the session: the
            // session schedules the work and knows nothing about the tunnel, so
            // that its scheduling can be checked without one.
            guard let endpoint = computer.endpoint, let token = computer.token else {
                throw RemoteSession.SessionError.notPaired
            }
            session = try RemoteSession(computer: computer,
                                        transport: try RemoteApi(endpoint: endpoint, token: token,
                                                                 attachments: AppStores.attachmentStore))
        } catch {
            notice = Notice(text: Self.describe(error), serious: true)
            return
        }
        if let id = openId {
            open(id)
        } else {
            // The cached list is drawn first and the live fetch replaces it, so
            // a launch shows the conversations immediately instead of a spinner
            // for the length of a tunnel round trip. `boot()` has usually
            // already drawn it; this is the reconnect case, where it only fills
            // a screen that is still empty.
            loadCachedList(onlyIfEmpty: true)
            startListStream()
            refreshList()
        }
    }

    /// Draws the list this computer last sent, if there is one.
    ///
    /// `onlyIfEmpty` is what keeps a reconnect from undoing the screen. Android
    /// draws the cache exactly once, when `listScreen()` builds the list; this
    /// is called a second time from `connect()` — which runs on every return to
    /// the foreground and every network change — and replacing rows the person
    /// is reading with a strictly older cached copy is the one thing the cache
    /// must not do.
    private func loadCachedList(onlyIfEmpty: Bool = false) {
        if onlyIfEmpty, !conversations.isEmpty { return }
        guard let computer = current, computer.isPaired, let token = computer.token,
              let entry = listCache.load(address: computer.address, token: token) else { return }
        conversations = entry.conversations
        workspaces = entry.workspaces
        nextListOffset = entry.nextOffset
        includeUnassigned = entry.includeUnassigned
        loadCollapsed()
        publish()
    }

    /// Opens the conversation-list event stream, once.
    ///
    /// Kept apart from `refreshList` on purpose. Watching a *different*
    /// subject tears the old stream down first, so fetching inside the
    /// snapshot callback would restart the stream that delivered the snapshot
    /// and spin: a snapshot, a refetch, a new stream, another snapshot.
    private func startListStream() {
        guard remoteScreenActive, let session else { return }
        streamState = .idle
        listPoll?.cancel()
        listFetchId = nil
        listLoadingMore = false
        deferredListRefresh = false
        pendingListEvent = nil
        session.watchList(onEvent: { [weak self, weak session] snapshot, maySkipUnchanged, finish in
            guard let self, let session, self.session === session, self.remoteScreenActive,
                  self.openId == nil else {
                finish(.failure(CancellationError()))
                return
            }
            let event = PendingListEvent(instance: snapshot.instanceId, cursor: snapshot.cursor,
                                         maySkipUnchanged: maySkipUnchanged, finish: finish)
            if self.listFetchId != nil {
                // The initial/manual fetch is already on the request queue.
                // Hold this receipt until its result says whether a second
                // fetch is needed; the stream does not advance meanwhile.
                self.pendingListEvent = event
            } else {
                self.applyListEvent(event)
            }
        }, onState: { [weak self, weak session] state in
            guard let self, let session else { return }
            self.acceptStreamState(state, session: session)
        })
    }

    private func applyListEvent(_ event: PendingListEvent) {
        if event.maySkipUnchanged, listCursor >= 0,
           event.instance == listInstanceId, event.cursor == listCursor {
            event.finish(.success(()))
        } else {
            fetchList(preservingVisibleCount: true, event: event)
        }
    }

    /// Fetches the list once, leaving any open stream alone.
    func refreshList(preservingVisibleCount: Bool = false) {
        fetchList(preservingVisibleCount: preservingVisibleCount, event: nil)
    }

    private func fetchList(preservingVisibleCount: Bool, event: PendingListEvent?) {
        guard remoteScreenActive, let session else {
            event?.finish(.failure(CancellationError()))
            return
        }
        if listFetchId != nil {
            deferredListRefresh = true
            if let event { pendingListEvent = event }
            return
        }
        let id = UUID()
        listFetchId = id
        // Only a first load shows a spinner in place of the list; a refresh of
        // a list already on screen would otherwise blank it on every event.
        listLoading = conversations.isEmpty
        // Cleared on the way in: the retry button re-runs this, and a stale
        // message beside a fresh attempt reads as the retry having failed.
        listError = nil
        let count = isSearching ? Int.max : (preservingVisibleCount ? max(100, conversations.count) : 0)
        session.conversations(minimumCount: count) { [weak self] result in
            guard let self, self.listFetchId == id else { return }
            self.listFetchId = nil
            self.listLoading = false
            switch result {
            case .success(let page):
                self.conversations = page.conversations
                self.workspaces = page.workspaces
                self.nextListOffset = page.nextOffset
                self.access = page.access
                self.availableEngines = page.availableEngines
                self.listInstanceId = page.instanceId
                // Android records the event cursor after a successful event-
                // driven refetch; ordinary fetches use the page's own cursor.
                self.listCursor = event?.cursor ?? page.cursor
                self.includeUnassigned = page.includeUnassigned
                self.loadCollapsed()
                self.saveCachedList()
                // A list that arrived proves the computer is up, which is what
                // Android's list path records too — so the computers screen
                // shows "connected" without the person having to pull to check.
                if let address = self.current?.address {
                    self.computerStates[address] = ComputerStatus.connected
                }
                event?.finish(.success(()))
            case .failure(let error):
                if self.handleAuthenticatedFailure(error, session: session) {
                    event?.finish(.failure(error))
                    return
                }
                if let http = error as? RemoteHttpError,
                   http.status == 403 || http.status == 404 {
                    self.discardDeniedDetail(error: http, session: session)
                }
                // A failed refresh leaves the cached list where it is, which is
                // the whole reason it is on disk: an offline launch still shows
                // the conversations rather than an empty screen and an error.
                //
                // It is also *recorded*, not just announced. With nothing cached
                // the screen would otherwise say "这台电脑上还没有会话" — which
                // is a claim about the desktop, made from a request that never
                // answered. Android shows the failure and stops there.
                self.listError = Self.describe(error)
                self.notice = Notice(text: Self.describe(error), serious: false)
                event?.finish(.failure(error))
            }
            self.finishListFetch()
        }
    }

    /// Android fetches one page on entry and exposes the next page as a row.
    /// Searching drains the tail after a short debounce so later-page titles
    /// remain findable without making every first paint wait for the full list.
    func loadMoreConversations(searching: Bool = false) {
        guard let session, nextListOffset >= 0, listFetchId == nil else { return }
        let id = UUID()
        let offset = nextListOffset
        listFetchId = id
        listLoadingMore = true
        session.conversations(offset: Int(offset), minimumCount: searching ? Int.max : 0) { [weak self] result in
            guard let self, self.listFetchId == id else { return }
            self.listFetchId = nil
            self.listLoadingMore = false
            switch result {
            case .success(let page):
                if !self.listInstanceId.isEmpty && page.instanceId != self.listInstanceId {
                    self.refreshList()
                    return
                }
                var rows = self.conversations
                var indices = Dictionary(uniqueKeysWithValues: rows.enumerated().map { ($0.element.id, $0.offset) })
                for row in page.conversations {
                    if let index = indices[row.id] {
                        rows[index] = row
                    } else {
                        indices[row.id] = rows.count
                        rows.append(row)
                    }
                }
                self.conversations = rows
                self.nextListOffset = page.nextOffset
                self.listError = nil
                self.saveCachedList()
            case .failure(let error):
                if self.handleAuthenticatedFailure(error, session: session) { return }
                if let http = error as? RemoteHttpError,
                   http.status == 403 || http.status == 404 {
                    self.discardDeniedDetail(error: http, session: session)
                }
                self.notice = Notice(text: Self.describe(error), serious: false)
            }
            self.finishListFetch()
        }
    }

    func searchChanged() {
        searchWork?.cancel()
        guard isSearching, nextListOffset >= 0 else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.loadMoreConversations(searching: true)
        }
        searchWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    private func finishListFetch() {
        if deferredListRefresh {
            deferredListRefresh = false
            refreshList(preservingVisibleCount: true)
            return
        }
        if let event = pendingListEvent {
            pendingListEvent = nil
            applyListEvent(event)
            return
        }
        if isSearching && nextListOffset >= 0 {
            searchChanged()
        } else if let session, case .unsupported = streamState {
            scheduleListPoll(session)
        }
    }

    /// Remembers this computer's list, then queues its snapshots and later
    /// pages on the same schedule Android uses.
    private func saveCachedList() {
        guard let computer = current, computer.isPaired,
              let token = computer.token, let endpoint = computer.endpoint else { return }
        listCache.save(address: computer.address, token: token,
                       conversations: conversations, nextOffset: nextListOffset,
                       workspaces: workspaces, includeUnassigned: includeUnassigned)
        let owner = RemotePrefetchPlan.Owner(address: computer.address, token: token,
                                             endpoint: endpoint)
        schedulePrefetch(owner, rows: conversations, nextOffset: nextListOffset, initial: true)
    }

    private func schedulePrefetch(_ owner: RemotePrefetchPlan.Owner,
                                  rows: [RemoteConversation], nextOffset: Int64,
                                  initial: Bool) {
        guard foregrounded else { return }
        prefetchPlan.schedule(owner, rows: rows, nextOffset: nextOffset,
                              initial: initial, now: ProcessInfo.processInfo.systemUptime,
                              cache: prefetch)
        if prefetchPlan.hasImmediate {
            prefetchTimer?.cancel()
            prefetchTimer = nil
        }
        pumpPrefetch()
    }

    /// Reset the optional walk, but leave already cached snapshots available.
    private func cancelPrefetch() {
        prefetchGeneration += 1
        prefetchTimer?.cancel()
        prefetchTimer = nil
        prefetchAbort?.cancel()
        prefetchAbort = nil
        prefetchActive = false
        prefetchPlan.cancel()
        prefetchWorkQueue.cancelAllOperations()
        detailPrefetchStarted = false
    }

    /// Called when a touch begins or a remote-list control is used. Immediate
    /// work remains immediate; older snapshots and pages wait for quiet again.
    func userInteracted() {
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastPrefetchInteraction >= 0.05 else { return }
        lastPrefetchInteraction = now
        prefetchTimer?.cancel()
        prefetchTimer = nil
        pumpPrefetch()
    }

    private func pumpPrefetch() {
        guard foregrounded, !prefetchActive, prefetchTimer == nil,
              let delay = prefetchPlan.delay(now: ProcessInfo.processInfo.systemUptime,
                                             lastInteraction: lastPrefetchInteraction) else { return }
        let ticket = prefetchGeneration
        let work = DispatchWorkItem { [weak self] in
            guard let self, ticket == self.prefetchGeneration else { return }
            self.prefetchTimer = nil
            self.prefetchNext()
        }
        prefetchTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private enum PrefetchResponse {
        case snapshot(RemoteSnapshot)
        case page(RemoteListPage)
    }

    /// One speculative request at a time on a utility lane, never in front of
    /// a tap or command on RemoteSession's user-request lane.
    private func prefetchNext() {
        guard foregrounded else { return }
        let now = ProcessInfo.processInfo.systemUptime
        guard let work = prefetchPlan.take(idle: now - lastPrefetchInteraction >= 2,
                                           cache: prefetch) else {
            pumpPrefetch()
            return
        }
        prefetchActive = true
        let ticket = prefetchGeneration
        let abort = RemoteRequestCancellation()
        prefetchAbort = abort
        prefetchWorkQueue.addOperation { [self] in
            let result: Result<PrefetchResponse, Error> = Result {
                let api = try RemoteApi(endpoint: work.owner.endpoint, token: work.owner.token)
                guard abort.install({ api.cancel() }) else { throw CancellationError() }
                defer { abort.clear() }
                switch work.target {
                case .snapshot(let row):
                    return .snapshot(try api.conversation(id: row.id))
                case .page(let offset):
                    let body = try api.json("/v1/conversations?offset=\(offset)")
                    guard body.raw["conversations"] is [Any] else { throw RemoteApiError.invalidJSON }
                    return .page(RemoteListPage(body))
                }
            }
            DispatchQueue.main.async {
                guard ticket == self.prefetchGeneration, self.foregrounded else { return }
                self.prefetchAbort = nil
                self.prefetchActive = false
                let owner = work.owner
                guard self.computers.contains(where: {
                    $0.address == owner.address && $0.token == owner.token
                }) else {
                    self.pumpPrefetch()
                    return
                }
                switch result {
                case .success(.snapshot(let snapshot)):
                    if case .snapshot(let row) = work.target,
                       snapshot.conversation?.id == row.id {
                        self.prefetch.store(address: owner.address, token: owner.token,
                                            snapshot: snapshot)
                    }
                case .success(.page(let page)):
                    self.prefetchPlan.completedPage(work, rows: page.conversations,
                                                    nextOffset: page.nextOffset,
                                                    now: ProcessInfo.processInfo.systemUptime,
                                                    cache: self.prefetch)
                case .failure(let error):
                    let status = (error as? RemoteApi.Failure)?.status
                    if status == 404, case .snapshot(let row) = work.target {
                        self.prefetchPlan.removeSnapshot(row.id, for: owner)
                        self.prefetch.forget(address: owner.address, token: owner.token, id: row.id)
                    } else {
                        // A failed computer is not walked repeatedly into an
                        // outage. Authentication failure also invalidates the
                        // snapshots it previously supplied.
                        self.prefetchPlan.remove(owner)
                        if status == 401 || status == 403 {
                            self.prefetch.forgetComputer(address: owner.address, token: owner.token)
                        }
                    }
                }
                self.pumpPrefetch()
            }
        }
    }

    /// Drops the prefetched snapshots of conversations that are now gone.
    private func forgetPrefetched(_ ids: [String]) {
        guard let computer = current, computer.isPaired, let token = computer.token,
              let endpoint = computer.endpoint else { return }
        let owner = RemotePrefetchPlan.Owner(address: computer.address, token: token,
                                             endpoint: endpoint)
        for id in ids {
            prefetchPlan.removeSnapshot(id, for: owner)
            prefetch.forget(address: computer.address, token: token, id: id)
        }
    }

    // MARK: - List layout

    /// The conversations the search box currently admits.
    ///
    /// Matching is on the title alone, case-insensitively, which is what the
    /// desktop's list gives the phone to match on — there is no server-side
    /// search endpoint, so this is the same comparison Android runs. Pages are
    /// completed by `searchChanged`, which drains later pages after a debounce.
    var visibleConversations: [RemoteConversation] {
        let needle = ComposerText.androidTrim(search).lowercased()
        guard !needle.isEmpty else { return conversations }
        return conversations.filter { $0.title.lowercased().contains(needle) }
    }

    /// Whether anything is matching right now.
    var hasMatches: Bool { !visibleConversations.isEmpty }

    /// Whether the search box is doing anything.
    var isSearching: Bool { !ComposerText.androidTrim(search).isEmpty }

    /// Folds or unfolds one workspace group, remembering the choice.
    func toggleCollapsed(_ workspace: String) {
        guard let address = current?.address else { return }
        let collapsed = !collapsedWorkspaces.contains(workspace)
        preferences.setWorkspace(workspace, collapsed: collapsed, address: address)
        if collapsed { collapsedWorkspaces.insert(workspace) } else { collapsedWorkspaces.remove(workspace) }
        objectWillChange.send()
    }

    /// Reads which groups are folded for the current computer.
    ///
    /// Only the groups the list actually has are asked about, so a workspace the
    /// desktop has since removed cannot keep a stale preference alive — the same
    /// reason Android stores one key per `address/workspace` rather than one
    /// blob per computer.
    private func loadCollapsed() {
        guard let address = current?.address else {
            collapsedWorkspaces = []
            return
        }
        var keys = Set(workspaces.map(\.id))
        for conversation in conversations { keys.insert(conversation.workspaceId ?? "") }
        keys.insert("")
        collapsedWorkspaces = Set(keys.filter {
            preferences.isWorkspaceCollapsed(address: address, workspace: $0)
        })
    }

    /// Whether a conversation has a reply this phone has not shown yet.
    ///
    /// The same test `syncRead` uses to decide whether to report a read, which
    /// is what keeps the row's mark and the desktop's unread count from
    /// disagreeing.
    func isUnread(_ conversation: RemoteConversation) -> Bool {
        guard let computer = current, computer.isPaired, let token = computer.token else { return false }
        return readState.unread(address: computer.address, token: token, conversation: conversation)
    }

    // MARK: - Conversation

    func open(_ id: String) {
        let identity = detailIdentity(for: id)
        let sameDetail = identity != nil && identity == activeDetailIdentity && openId == id
        if sameDetail, commandBusy { return }
        if commandBusy { abandonActiveCommand() }
        cancelPrefetch()
        listPoll?.cancel()
        listFetchId = nil
        listLoading = false
        listLoadingMore = false
        deferredListRefresh = false
        pendingListEvent = nil
        // Reappearing or reconnecting to this same detail must not discard
        // pages the person already loaded. A new detail still starts fresh.
        if !sameDetail {
            if let previous = activeDetailIdentity,
               previous.address == current?.address, previous.token == current?.token {
                stashDraft()
            }
            loadDraft(id)
            restorePendingOutgoing(for: id)
            detailAccessFailure = nil
        }
        openId = id
        activeDetailIdentity = identity
        streamState = .idle
        loadingOlder = false
        if sameDetail {
            transcript.suspend()
        } else {
            transcript.reset()
            artifacts = []
            artifactsError = nil
            artifactsLoading = false
            artifactsMore = false
            artifactsNext = -1
            // A prefetched snapshot draws instantly, but it is not evidence
            // that the computer is still connected or still grants control.
            if let computer = current, computer.isPaired, let token = computer.token,
               let cached = prefetch.cached(address: computer.address, token: token, id: id) {
                transcript.showPrefetched(cached)
            }
        }
        publish()
        guard let session else { return }
        // The stream is opened *before* the fetch, not after. Opening it bumps
        // the session's generation — that is how the previous screen's stream is
        // retired — and a fetch submitted first would have its answer discarded
        // as stale when it came back. The old order also lost the fetch twice
        // over: the stream held the queue it was submitted to.
        session.watch(conversationId: id, onSnapshot: { [weak self] snapshot in
            guard let self else { return }
            guard self.transcript.apply(snapshot) else { return }
            if snapshot.hasMessages {
                self.detailAccessFailure = nil
                self.syncRead(snapshot)
                self.settleOutgoing()
            }
            self.remember(snapshot)
            self.publish()
        }, onState: { [weak self, weak session] state in
            guard let self, let session else { return }
            self.acceptStreamState(state, session: session)
        })
        session.snapshot(conversationId: id) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let snapshot):
                guard self.transcript.apply(snapshot) else { return }
                if snapshot.hasMessages {
                    self.detailAccessFailure = nil
                    self.syncRead(snapshot)
                }
                self.remember(snapshot)
                self.publish()
            case .failure(let error):
                if self.handleAuthenticatedFailure(error, session: session) { return }
                let http = error as? RemoteHttpError
                let status = http?.status
                let restored: Bool
                if let http, http.status == 403 || http.status == 404 {
                    restored = self.discardDeniedDetail(error: http, session: session)
                } else {
                    restored = false
                }
                if status == 404, restored {
                    self.notice = Notice(
                        text: "会话不可用，可能已归档或不再授权。未确认的消息已恢复到输入框且未发送。",
                        serious: false)
                } else {
                    self.notice = Notice(text: Self.describe(error), serious: false)
                }
            }
        }
        if artifactSheetOpen { loadArtifacts() }
    }

    /// Releases a journal that can never be acknowledged because its target
    /// conversation no longer exists or is no longer visible to this device.
    private func releasePendingForUnavailableConversation(_ id: String) -> Bool {
        guard !commandBusy, let address = current?.address,
              let pending = current?.pendingCommand,
              pending.text("conversationId") == id,
              let payload = pending.object("payload") else { return false }
        do {
            let updated = try store.update(address: address) { computer in
                guard computer.pendingCommand?.text("conversationId") == id else { return }
                computer.pendingCommand = nil
            }
            adopt(updated)
        } catch {
            notice = Notice(text: "无法保存操作结果，请重试同一请求。", serious: false)
            return false
        }
        let action = payload.text("action")
        if action == "send" || action == "resend" {
            draft = pending.text("draft", fallback: payload.text("prompt"))
            let edit = payload.long("editSeq", fallback: -1)
            editingSeq = edit > 0 ? edit : nil
            restoreAttachments(AttachmentRules.restore(payload))
            pendingAttachments = []
            outgoingAt = pending.long("at")
            outgoingLegacyImage = payload.has("image")
            outgoingEcho = RemoteOutgoingEcho(instanceId: payload.text("instanceId"),
                                              expectedSeq: payload.long("expectedSeq"),
                                              prompt: payload.text("prompt"))
            outgoing = .failed(draft)
            stashDraft()
        } else {
            outgoing = nil
        }
        if let computer = current, let token = computer.token {
            prefetch.forget(address: computer.address, token: token, id: id)
        }
        publish()
        return true
    }

    /// Keeps a snapshot for the next time this conversation is opened.
    ///
    /// A stream snapshot counts as much as a fetched one — it is the same
    /// payload — so a conversation being watched stays hot instead of going
    /// stale behind the freshness window.
    private func remember(_ snapshot: RemoteSnapshot) {
        guard let computer = current, computer.isPaired, let token = computer.token,
              let endpoint = computer.endpoint else { return }
        prefetch.store(address: computer.address, token: token, snapshot: snapshot)
        if !detailPrefetchStarted, openId == snapshot.conversation?.id {
            detailPrefetchStarted = true
            if let cached = listCache.load(address: computer.address, token: token) {
                schedulePrefetch(.init(address: computer.address, token: token, endpoint: endpoint),
                                 rows: cached.conversations, nextOffset: cached.nextOffset,
                                 initial: false)
            }
        }
    }

    /// Records that a conversation's replies have been shown.
    ///
    /// Mirrors Android's `syncReplyRead`: it fires only for a reply newer than
    /// what the desktop already knows is read, and it is skipped in the
    /// background, because a conversation nobody is looking at has not been
    /// read. The local cursor moves before the POST goes out, so a stream that
    /// repeats the same snapshot does not send the same request twice; that is
    /// also why a failed POST is not reported — the next snapshot will offer
    /// the same reply again.
    private func syncRead(_ snapshot: RemoteSnapshot) {
        guard foregrounded, let session, let conversation = snapshot.conversation,
              let computer = current, computer.isPaired, let token = computer.token
        else { return }
        guard readState.unread(address: computer.address, token: token, conversation: conversation) else { return }
        readState.markRead(address: computer.address, token: token, conversation: conversation)
        session.markRead(conversationId: conversation.id, lastReplyAt: conversation.lastReplyAt)
    }

    func close() {
        abandonActiveCommand()
        stashDraft()
        cancelPrefetch()
        openId = nil
        activeDetailIdentity = nil
        detailAccessFailure = nil
        draft = ""
        editingSeq = nil
        outgoing = nil
        outgoingEcho = nil
        outgoingAt = 0
        outgoingLegacyImage = false
        attachments = []
        attachmentPreviews = [:]
        pendingAttachments = []
        artifacts = []
        transcript.reset()
        loadingOlder = false
        publish()
        // Back to the list, which means watching the list again: opening the
        // conversation replaced this stream with the conversation's own.
        startListStream()
        refreshList()
    }

    /// A stream replacement invalidates the session generation and therefore
    /// drops a command callback. The encrypted journal remains the authority;
    /// only the transient spinner is released and the message becomes
    /// explicitly retryable.
    private func abandonActiveCommand() {
        guard commandBusy else { return }
        commandTaskId = nil
        commandBusy = false
        configuring = false
        switch outgoing {
        case .sending(let text), .preparing(let text):
            outgoing = .unconfirmed(text, "连接已切换；点击重试同一请求，避免重复发送。")
        default:
            break
        }
        publish()
    }

    /// Whether the open conversation has earlier messages the desktop can serve.
    var hasOlder: Bool { transcript.hasOlder }

    /// Fetches one earlier page (`?before=`), keeping what is already on screen.
    ///
    /// Mirrors Android's `loadOlder`: refused while one is in flight, when the
    /// desktop has no cursor, or once rows were evicted locally (a cursor into
    /// history the phone has dropped would point at a hole). The page is folded
    /// in with `mergeOlder`, never `apply` — an older page's first seq is
    /// smaller than anything cached, so the supersede rule would delete the
    /// rows the person is reading. A page from a different desktop instance is
    /// dropped rather than merged, the same guard Android makes before render.
    func loadOlder() {
        guard !loadingOlder, transcript.hasOlder, let session, let id = openId,
              let before = transcript.nextBefore else { return }
        loadingOlder = true
        publish()
        session.snapshot(conversationId: id, before: before) { [weak self] result in
            guard let self else { return }
            self.loadingOlder = false
            switch result {
            case .success(let snapshot):
                if self.openId != id { self.publish(); return }
                if self.transcript.mergeOlder(snapshot) {
                    self.olderTick += 1
                }
            case .failure(let error):
                if self.handleAuthenticatedFailure(error, session: session) { return }
                guard self.openId == id else { self.publish(); return }
                let http = error as? RemoteHttpError
                let status = http?.status
                let restored: Bool
                if let http, http.status == 403 || http.status == 404 {
                    restored = self.discardDeniedDetail(error: http, session: session)
                } else {
                    restored = false
                }
                if status == 404, restored {
                    self.notice = Notice(
                        text: "会话不可用，可能已归档或不再授权。未确认的消息已恢复到输入框且未发送。",
                        serious: false)
                } else {
                    self.notice = Notice(text: Self.describe(error), serious: false)
                }
            }
            self.publish()
        }
    }

    // MARK: - Commands

    /// Whether this device may drive the current computer at all.
    var canDrive: Bool {
        guard foregrounded, remoteScreenActive else { return false }
        guard case .connected = streamState else { return false }
        return transcript.connected && transcript.permission == .control
    }

    /// What a command turned out to be.
    private enum CommandOutcome {
        /// The desktop took it, and said which user sequence it landed on.
        case accepted(CommandResult)
        /// The desktop gave a terminal refusal, so a fresh operation is safe.
        case refused(String)
        /// The request may have run. Its journal remains and only that same
        /// request id may be retried.
        case unconfirmed(String)
        /// A transport failure needs Android's explicit warning in addition
        /// to the persistent same-request retry state.
        case transportUnconfirmed(String)
    }

    private enum PendingSlot { case list, detail }

    var hasPendingListOperation: Bool { current?.pendingCreate != nil }
    var hasPendingDetailOperation: Bool { current?.pendingCommand != nil }

    private func pendingRequestId(_ computer: PairedComputer, slot: PendingSlot) -> String? {
        switch slot {
        case .list: return computer.pendingCreate?.string("requestId")
        case .detail: return computer.pendingCommand?.object("payload")?.string("requestId")
        }
    }

    /// Drives one command to a decision.
    ///
    /// A desktop that answers `pending` is asking to be asked again, and the
    /// same request id is what makes the retry safe — which is why the id is
    /// minted once, here, rather than per attempt. Every caller goes through
    /// this so the retry rule is stated once instead of in six places.
    @discardableResult
    private func deliver(session: RemoteSession, action: String, conversationId: String? = nil,
                         payload: [String: Any], draft: String? = nil,
                         pendingSlot requestedSlot: PendingSlot? = nil,
                         attempt: Int = 0, requestId: String = UUID().uuidString,
                         journaled: Bool = false, taskId: UUID? = nil,
                         outcome: @escaping (CommandOutcome) -> Void) -> Bool {
        let slot: PendingSlot = requestedSlot ?? (conversationId == nil ? .list : .detail)
        let address = session.computer.address
        var body = payload
        body["action"] = action
        body["requestId"] = requestId

        let deliveryId: UUID
        if journaled {
            guard let taskId, commandTaskId == taskId else { return false }
            deliveryId = taskId
        } else {
            guard !commandBusy else {
                outcome(.unconfirmed("请等待当前操作完成。"))
                return false
            }
            var stored = false
            do {
                let updated = try store.update(address: address) { computer in
                    let vacant = slot == .list
                        ? computer.pendingCreate == nil : computer.pendingCommand == nil
                    guard vacant else { return }
                    let command = JSONObject(dictionary: body)
                    switch slot {
                    case .list:
                        var journal = body
                        if let conversationId { journal["moveSessionId"] = conversationId }
                        computer.pendingCreate = JSONObject(dictionary: journal)
                    case .detail:
                        var wrapper: [String: Any] = [
                            "conversationId": conversationId ?? "",
                            "payload": command.raw,
                        ]
                        if let draft {
                            wrapper["draft"] = draft
                            wrapper["at"] = Int64(Date().timeIntervalSince1970 * 1000)
                        }
                        computer.pendingCommand = JSONObject(dictionary: wrapper)
                    }
                    stored = true
                }
                adopt(updated)
            } catch {
                outcome(.refused("无法保存操作：\(Self.describe(error))"))
                return false
            }
            guard stored else {
                outcome(.unconfirmed("已有一项操作尚未确认，请重试原请求。"))
                return false
            }
            deliveryId = UUID()
            commandTaskId = deliveryId
            commandBusy = true
            publish()
        }

        session.command(action, conversationId: conversationId, payload: body) { [weak self] result in
            guard let self, self.commandTaskId == deliveryId else { return }
            // Any newer command answer supersedes the previous status line.
            // A new 403/404 below immediately replaces it with its own cause.
            if slot == .detail { self.detailAccessFailure = nil }
            switch result {
            case .failure(let error):
                let status = (error as? RemoteHttpError)?.status
                let terminal = status.map { $0 >= 400 && $0 < 500 && $0 != 429 } ?? false
                self.finishCommand(id: deliveryId, slot: slot, address: address,
                                   requestId: requestId, clearJournal: terminal,
                                   outcome: terminal
                                    ? .refused(Self.describe(error))
                                    : .transportUnconfirmed(Self.describe(error)),
                                   completion: outcome)
                if status == 401 {
                    self.handleAuthenticatedFailure(error, session: session)
                } else if let http = error as? RemoteHttpError,
                          http.status == 403 || http.status == 404 {
                    self.discardDeniedDetail(error: http, session: session)
                }
            case .success(let value):
                switch CommandAck(result: value) {
                case .pending:
                    guard attempt < 5 else {
                        self.finishCommand(id: deliveryId, slot: slot, address: address,
                                           requestId: requestId, clearJournal: false,
                                           outcome: .unconfirmed("等待电脑确认超时；请重试同一请求，不要重复操作。"),
                                           completion: outcome)
                        return
                    }
                    self.markPreparing()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                        let active = self.foregrounded && self.remoteScreenActive
                            && self.session === session
                            && (slot == .list ? self.openId == nil
                                : self.openId == conversationId && self.canDrive)
                        guard active else {
                            self.finishCommand(id: deliveryId, slot: slot, address: address,
                                               requestId: requestId, clearJournal: false,
                                               outcome: .unconfirmed("连接或页面已切换；请重试同一请求。"),
                                               completion: outcome)
                            return
                        }
                        self.deliver(session: session, action: action, conversationId: conversationId,
                                     payload: payload, draft: draft, pendingSlot: slot,
                                     attempt: attempt + 1,
                                     requestId: requestId, journaled: true, taskId: deliveryId,
                                     outcome: outcome)
                    }
                case .accepted, .queued:
                    self.finishCommand(id: deliveryId, slot: slot, address: address,
                                       requestId: requestId, clearJournal: true,
                                       outcome: .accepted(value), completion: outcome)
                case .rejected:
                    self.finishCommand(id: deliveryId, slot: slot, address: address,
                                       requestId: requestId, clearJournal: true,
                                       outcome: .refused(value.error.isEmpty
                                        ? "电脑端拒绝了这次操作。" : value.error),
                                       completion: outcome)
                case .unknown:
                    // The desktop has lost the idempotency record, so a retry
                    // could apply the command twice; the person decides instead.
                    self.finishCommand(id: deliveryId, slot: slot, address: address,
                                       requestId: requestId, clearJournal: false,
                                       outcome: .unconfirmed("电脑无法确认请求结果；请先到电脑核对，不会自动重复执行。"),
                                       completion: outcome)
                }
            }
        }
        return true
    }

    /// Ends one delivery, conditionally removing only its own journal entry.
    private func finishCommand(id: UUID, slot: PendingSlot, address: String,
                               requestId: String, clearJournal: Bool,
                               outcome: CommandOutcome,
                               completion: @escaping (CommandOutcome) -> Void) {
        guard commandTaskId == id else { return }
        var final = outcome
        if clearJournal {
            do {
                let updated = try store.update(address: address) { computer in
                    guard self.pendingRequestId(computer, slot: slot) == requestId else { return }
                    switch slot {
                    case .list: computer.pendingCreate = nil
                    case .detail: computer.pendingCommand = nil
                    }
                }
                adopt(updated)
            } catch {
                // The desktop may already have acted. If clearing the journal
                // did not persist, the only safe state is still "unconfirmed".
                final = .unconfirmed("无法保存操作结果：\(Self.describe(error))。请重试同一请求。")
            }
        }
        commandTaskId = nil
        commandBusy = false
        completion(final)
        publish()
    }

    private func markPreparing() {
        switch outgoing {
        case .sending(let text), .unconfirmed(let text, _): outgoing = .preparing(text)
        default: break
        }
    }

    /// Reports a refusal and stays quiet about a success, for the commands a
    /// user cannot see the effect of directly.
    private func report(_ result: CommandOutcome) {
        switch result {
        case .accepted: break
        case .refused(let message), .unconfirmed(let message):
            notice = Notice(text: message, serious: false)
        case .transportUnconfirmed(let error):
            notice = Notice(text: error, serious: true, kind: .transportUnconfirmed)
        }
    }

    /// Reuses the exact list-level request saved before a connection failure or
    /// process exit. A new request id is deliberately never minted here.
    func retryPendingListOperation() {
        guard foregrounded, openId == nil, !commandBusy,
              let session, let pending = current?.pendingCreate,
              let action = pending.string("action"),
              let requestId = pending.string("requestId") else { return }
        var payload = pending.raw
        payload.removeValue(forKey: "action")
        payload.removeValue(forKey: "requestId")
        var target: String?
        if action == "move" || action == "fork" {
            target = payload.removeValue(forKey: "moveSessionId") as? String
        }
        let taskId = UUID()
        commandTaskId = taskId
        commandBusy = true
        publish()
        let started = deliver(session: session, action: action, conversationId: target,
                              payload: payload, pendingSlot: .list,
                              requestId: requestId, journaled: true, taskId: taskId) { [weak self] result in
            guard let self else { return }
            switch result {
            case .accepted(let value):
                if action == "delete" {
                    let ids = pending.array("targets").compactMap { JSONObject($0)?.string("id") }
                    self.forgetPrefetched(ids)
                }
                self.refreshList()
                if (action == "create" || action == "fork"), let conversation = value.conversation {
                    if !self.conversations.contains(where: { $0.id == conversation.id }) {
                        self.conversations.append(conversation)
                    }
                    self.createdConversationId = conversation.id
                }
            case .refused, .unconfirmed, .transportUnconfirmed:
                self.report(result)
            }
        }
        if !started {
            commandTaskId = nil
            commandBusy = false
            publish()
        }
    }

    /// Retries the unconfirmed operation belonging to the open conversation.
    func retryPendingDetailOperation() {
        guard foregrounded, canDrive, !commandBusy,
              let session, let pending = current?.pendingCommand,
              let target = pending.string("conversationId"),
              let payloadObject = pending.object("payload"),
              let action = payloadObject.string("action"),
              let requestId = payloadObject.string("requestId") else { return }
        guard target == openId else {
            notice = Notice(text: "另一会话有未确认操作，请先打开该会话核对结果。", serious: false)
            return
        }
        var payload = payloadObject.raw
        payload.removeValue(forKey: "action")
        payload.removeValue(forKey: "requestId")
        let visibleText = pending.text("draft", fallback: payloadObject.text("prompt"))
        let submitted = action == "send" || action == "resend"
        if submitted {
            outgoingAt = pending.long("at")
            outgoingLegacyImage = payloadObject.has("image")
            outgoingEcho = RemoteOutgoingEcho(instanceId: payloadObject.text("instanceId"),
                                              expectedSeq: payloadObject.long("expectedSeq"),
                                              prompt: payloadObject.text("prompt"))
            outgoing = .sending(visibleText)
        }
        let taskId = UUID()
        commandTaskId = taskId
        commandBusy = true
        publish()
        let started = deliver(session: session, action: action, conversationId: target,
                              payload: payload, pendingSlot: .detail,
                              requestId: requestId, journaled: true, taskId: taskId) { [weak self] result in
            guard let self else { return }
            switch result {
            case .accepted(let value):
                if submitted {
                    self.outgoing = value.state == "queued" ? nil : .accepted(visibleText)
                    self.outgoingEcho?.userSeq = value.userSeq
                    if value.state == "queued" {
                        self.outgoingEcho = nil
                        self.outgoingAt = 0
                        self.outgoingLegacyImage = false
                    }
                    self.removeAttachmentBlobs(in: payloadObject)
                    self.pendingAttachments = []
                }
            case .refused(let message):
                if submitted {
                    self.draft = visibleText
                    let edit = payloadObject.long("editSeq", fallback: -1)
                    self.editingSeq = edit > 0 ? edit : nil
                    let restored = AttachmentRules.restore(payloadObject)
                    self.restoreAttachments(restored)
                    self.pendingAttachments = []
                    self.outgoing = .failed(visibleText)
                    self.notice = Notice(text: message, serious: true, kind: .rejectedSend)
                    self.stashDraft()
                } else {
                    self.notice = Notice(text: message, serious: false)
                }
            case .unconfirmed(let message):
                if submitted { self.outgoing = .unconfirmed(visibleText, message) }
                else { self.notice = Notice(text: message, serious: false) }
            case .transportUnconfirmed(let error):
                if submitted { self.outgoing = .unconfirmed(visibleText, "未收到电脑确认：\(error)") }
                self.report(result)
            }
            self.publish()
        }
        if !started {
            commandTaskId = nil
            commandBusy = false
            publish()
        }
    }

    private func removeAttachmentBlobs(in payload: JSONObject) {
        for attachment in AttachmentRules.restore(payload) {
            AppStores.attachmentStore.remove(attachment.data)
        }
    }

    /// A send that has been checked but not yet made.
    ///
    /// Held while a location consent sheet is up, because that sheet is the one
    /// step between pressing send and sending. Everything the person can change
    /// while it is open is in here, so the send can be re-checked rather than
    /// made against a message that is no longer on screen.
    private struct PreparedSend {
        let conversationId: String
        let computerAddress: String
        let instanceId: String
        let draft: String
        let prompt: String
        let editing: Int64?
        let sending: [RemoteAttachment]
    }

    func send() {
        guard let prepared = prepareSend() else { return }
        // A rewrite is never sent anywhere but over the turn it replaces, and a
        // location note baked into it would be part of a message the person is
        // only correcting — so the question is asked for a fresh prompt only.
        guard prepared.editing == nil, LocationContext.isRelevant(prepared.prompt) else {
            perform(prepared, context: "")
            return
        }
        pendingSend = prepared
        locationConsent = LocationConsent(destination: locationDestination)
        publish()
    }

    /// Validates a send and describes it, without making it.
    ///
    /// Split out so the location step can sit between deciding to send and
    /// sending, which is the only place it can: the note is part of the prompt,
    /// so it has to be known before the payload is built.
    private func prepareSend() -> PreparedSend? {
        // An empty prompt is only legal when there is something attached to
        // look at; the desktop is told to review the attachments instead.
        guard canSubmitDraft, let id = openId, let session else { return nil }
        guard transcript.conversation != nil || conversations.contains(where: { $0.id == id }) else { return nil }
        // Editing is only ever the last user turn, and only while nothing runs;
        // the desktop refuses anything else, so a stale edit target is dropped
        // rather than sent.
        let editing = editingSeq.flatMap { $0 == transcript.lastUserSeq ? $0 : nil }
        if editingSeq != nil, editing == nil { editingSeq = nil }

        let sending = attachments
        do {
            try AttachmentRules.validateRemote(sending, sizes: try attachmentSizes(sending),
                                               expanded: access.usesExpandedAttachments,
                                               files: access.canAttachFiles,
                                               multiImage: access.allowsMultipleImages)
        } catch {
            notice = Notice(text: Self.describe(error), serious: false)
            return nil
        }
        return PreparedSend(conversationId: id,
                            computerAddress: session.computer.address,
                            instanceId: transcript.instanceId,
                            draft: draft,
                            prompt: ComposerText.remotePrompt(draft, chinese: usesChinese),
                            editing: editing, sending: sending)
    }

    /// Makes the send, with whatever location note was collected.
    private func perform(_ prepared: PreparedSend, context: String) {
        guard canSubmitDraft, let session,
              session.computer.address == prepared.computerAddress,
              transcript.instanceId == prepared.instanceId,
              openId == prepared.conversationId,
              let conversation = transcript.conversation ?? conversations.first(where: { $0.id == prepared.conversationId })
        else { return }
        let editing = prepared.editing
        let sending = prepared.sending
        var payload: [String: Any] = [
            "instanceId": prepared.instanceId,
            // The note is appended to the prompt rather than sent as a field of
            // its own: the desktop forwards a prompt verbatim, and a note that
            // travelled beside it would be dropped by every desktop that does
            // not know the field — including one too old to have this feature.
            "prompt": prepared.prompt + context,
            "expectedSeq": conversation.seq,
        ]
        // A rewrite is the same request under a different action, with the seq
        // it replaces; the desktop drops everything from that seq onward and
        // regenerates, which is what "edit and resend" means here.
        if let editing { payload["editSeq"] = editing }
        // A desktop with a message queue takes every plain send as an enqueue,
        // which it drains immediately when nothing is running. Saying so is what
        // lets a message be composed while a reply is still streaming; a desktop
        // without the feature refuses the option, so it is only sent when the
        // snapshot said the field exists.
        if editing == nil, transcript.canQueue { payload["queue"] = true }
        if !sending.isEmpty {
            // A desktop that advertises either file capability takes the
            // structured list; one that does not only understands the older
            // single-image fields, and documents were refused above.
            if access.canAttachFiles {
                payload["attachments"] = AttachmentRules.payload(sending)
            } else if let legacy = AttachmentRules.legacyField(for: sending) {
                payload[legacy.key] = legacy.value
            }
        }

        // The pending bubble and encrypted retry journal show the person's
        // draft, while only the outbound payload substitutes the attachment
        // prompt. Android stores `composer.getText()` separately for this.
        let visibleText = prepared.draft
        let submitted = deliver(session: session, action: editing == nil ? "send" : "resend",
                conversationId: prepared.conversationId, payload: payload,
                draft: visibleText) { [weak self] result in
            guard let self else { return }
            switch result {
            case .accepted(let value):
                self.outgoing = value.state == "queued" ? nil : .accepted(visibleText)
                self.outgoingEcho?.userSeq = value.userSeq
                if value.state == "queued" {
                    self.outgoingEcho = nil
                    self.outgoingAt = 0
                    self.outgoingLegacyImage = false
                }
                self.clearPendingBlobs()
            case .refused(let message):
                // The edit target comes back with the draft, so a retry is the
                // same rewrite rather than a new message appended after it.
                self.draft = prepared.draft
                self.editingSeq = editing
                self.restoreAttachments(self.pendingAttachments)
                self.pendingAttachments = []
                self.outgoing = .failed(visibleText)
                self.notice = Notice(text: message, serious: true, kind: .rejectedSend)
                self.stashDraft()
            case .unconfirmed(let message):
                self.outgoing = .unconfirmed(visibleText, message)
            case .transportUnconfirmed(let error):
                self.outgoing = .unconfirmed(visibleText, "未收到电脑确认：\(error)")
                self.report(result)
            }
            self.publish()
        }
        guard submitted else { return }
        draft = ""
        // The tray empties on submit. Its durable owner is now the encrypted
        // pending-command journal; a terminal refusal puts it back into a
        // normal draft, while an unconfirmed result leaves it only there.
        pendingAttachments = sending
        attachments = []
        attachmentPreviews = [:]
        outgoingAt = current?.pendingCommand?.long("at")
            ?? Int64(Date().timeIntervalSince1970 * 1000)
        outgoingLegacyImage = payload["image"] != nil
        outgoing = .sending(visibleText)
        outgoingEcho = RemoteOutgoingEcho(instanceId: prepared.instanceId,
                                          expectedSeq: conversation.seq,
                                          prompt: prepared.prompt + context)
        editingSeq = nil
        drafts.removeValue(forKey: prepared.conversationId)
        persistDrafts()
        publish()
    }

    // MARK: - Location consent

    /// Whether the message waiting on the sheet is still the one on screen.
    ///
    /// The consent sheet takes time, and the person can keep typing or attach
    /// something while it is up. Android re-checks the composer, the target and
    /// the selection before sending; this is that guard, and without it consent
    /// given for one message would send a different one.
    private func isStillCurrent(_ prepared: PreparedSend) -> Bool {
        openId == prepared.conversationId
            && session?.computer.address == prepared.computerAddress
            && transcript.instanceId == prepared.instanceId
            && draft == prepared.draft
            && attachments == prepared.sending
    }

    /// Who the location would be going to, named in the sheet.
    private var locationDestination: String {
        (current?.displayName ?? "") + (usesChinese
            ? "（电脑及其模型服务商；会保存到会话历史）"
            : " (computer and model provider; saved in chat history)")
    }

    /// The person allowed this answer to use an approximate location.
    func allowLocation() {
        guard let prepared = pendingSend, var sheet = locationConsent else { return }
        sheet.requesting = true
        locationConsent = sheet
        publish()
        let id = sheet.id
        location.request { [weak self] note in
            guard let self, self.locationConsent?.id == id else { return }
            self.locationConsent = nil
            self.pendingSend = nil
            guard self.isStillCurrent(prepared) else { return }
            self.perform(prepared, context: note)
        }
    }

    /// The person declined; the message goes anyway, with a note saying so.
    func skipLocation() {
        guard let prepared = pendingSend else { return }
        location.cancel()
        locationConsent = nil
        pendingSend = nil
        publish()
        guard isStillCurrent(prepared) else { return }
        perform(prepared, context: LocationContext.unavailable)
    }

    /// The person cancelled the send, or swiped the sheet away.
    ///
    /// Nothing is sent and nothing is cleared: the composer keeps the text and
    /// the attachments, which is what Android's cancel does — the message was
    /// never handed over, so taking it off the screen would be a loss.
    func cancelLocation() {
        location.cancel()
        locationConsent = nil
        pendingSend = nil
        publish()
    }

    /// The sheet closed on its own. A swipe is a cancel, but only while a send
    /// is still waiting; once the message has gone there is nothing to abandon.
    func locationDismissed() {
        guard pendingSend != nil else { return }
        cancelLocation()
    }

    // MARK: - Editing

    /// Starts editing the last user turn.
    ///
    /// The original turn's attachments are not in the snapshot, so only the
    /// text comes back — the same limit the desktop's own client has. Whatever
    /// is already staged in the tray stays, because it belongs to the message
    /// about to be sent rather than to the one being rewritten.
    func beginEdit(_ seq: Int64) {
        guard openId != nil, !transcript.busy, !configuring, editingSeq == nil else { return }
        guard transcript.lastUserSeq == seq,
              let message = transcript.messages.first(where: { $0.id == seq })?.message,
              message.role == .user
        else { return }
        draft = message.text
        editingSeq = seq
        publish()
    }

    /// Leaves edit mode without sending.
    func cancelEdit() {
        guard editingSeq != nil else { return }
        editingSeq = nil
        draft = ""
        stashDraft()
        publish()
    }

    // MARK: - Attachments

    /// The size of each attachment, read from the store rather than the bytes.
    private func attachmentSizes(_ list: [RemoteAttachment]) throws -> [String: Int64] {
        var sizes: [String: Int64] = [:]
        for attachment in list {
            sizes[attachment.data] = try AppStores.attachmentStore.size(attachment.data)
        }
        return sizes
    }

    /// Seals picked photos and adds them to the tray.
    func addImages(_ images: [UIImage]) {
        addImages(count: images.count) { try AttachmentImage.encode(images[$0]) }
    }

    func addEncodedImages(_ images: [AttachmentImage.Encoded]) {
        addImages(count: images.count) { images[$0] }
    }

    private func addImages(count: Int, encode: @escaping (Int) throws -> AttachmentImage.Encoded) {
        guard access.canAttach, count > 0, !attaching,
              let target = openId, let computer = current?.address else { return }
        let room = access.attachmentCount - attachments.count
        guard room > 0, count <= room else {
            notice = Notice(text: "当前电脑最多 \(access.attachmentCount) 个附件，更新电脑端可提高限额。", serious: false)
            return
        }
        let existing = attachments
        let expanded = access.usesExpandedAttachments
        let files = access.canAttachFiles
        let multiImage = access.allowsMultipleImages
        let taskId = UUID()
        attachmentTaskId = taskId
        attaching = true
        publish()
        // Camera images are still encoded here; Photos already supplies bounded
        // JPEGs. Keep disk writes and validation off the main thread for both.
        DispatchQueue.global(qos: .userInitiated).async {
            let store = AppStores.attachmentStore
            var added: [RemoteAttachment] = []
            var previews: [String: UIImage] = [:]
            var failure: String?
            do {
                for index in 0..<count {
                    let encoded = try encode(index)
                    let reference = try store.save(encoded.data)
                    // Record the reference before writing its optional companion
                    // file so a preview-write failure also removes the blob.
                    added.append(RemoteAttachment(name: "mobile-image-\(added.count + 1).jpg",
                                                  data: reference, isImage: true))
                    try store.savePreview(reference, encoded.preview)
                    if let preview = UIImage(data: encoded.preview) { previews[reference] = preview }
                }
                var sizes: [String: Int64] = [:]
                for attachment in existing + added {
                    sizes[attachment.data] = try store.size(attachment.data)
                }
                try AttachmentRules.validateRemote(existing + added, sizes: sizes,
                                                   expanded: expanded, files: files,
                                                   multiImage: multiImage)
            } catch {
                for attachment in added { store.remove(attachment.data) }
                added = []
                previews = [:]
                failure = Self.describe(error)
            }
            DispatchQueue.main.async {
                guard self.attachmentTaskId == taskId else {
                    for attachment in added { store.remove(attachment.data) }
                    return
                }
                self.attachmentTaskId = nil
                self.attaching = false
                guard self.openId == target, self.current?.address == computer else {
                    for attachment in added { store.remove(attachment.data) }
                    self.publish()
                    return
                }
                self.attachments.append(contentsOf: added)
                for (key, value) in previews { self.attachmentPreviews[key] = value }
                if !added.isEmpty { self.stashDraft() }
                if let failure { self.notice = Notice(text: failure, serious: false) }
                self.publish()
            }
        }
    }

    /// Seals Files selections, including images, and adds them to the tray.
    func addFiles(_ filesToAdd: [PickedFile]) {
        guard !filesToAdd.isEmpty, !attaching,
              let target = openId, let computer = current?.address else { return }
        guard access.canAttachFiles else {
            notice = Notice(text: AttachmentError.documentsUnsupported.errorDescription ?? "", serious: false)
            return
        }
        let room = access.attachmentCount - attachments.count
        guard room > 0, filesToAdd.count <= room else {
            notice = Notice(text: "当前电脑最多 \(access.attachmentCount) 个附件，更新电脑端可提高限额。", serious: false)
            return
        }
        let existing = attachments
        let expanded = access.usesExpandedAttachments
        let files = access.canAttachFiles
        let multiImage = access.allowsMultipleImages
        let taskId = UUID()
        attachmentTaskId = taskId
        attaching = true
        publish()
        DispatchQueue.global(qos: .userInitiated).async {
            let store = AppStores.attachmentStore
            var added: [RemoteAttachment] = []
            var previews: [String: UIImage] = [:]
            var failure: String?
            do {
                for file in filesToAdd {
                    if file.isImage {
                        let encoded = try AttachmentImage.encode(file.loadImage())
                        let reference = try store.save(encoded.data)
                        added.append(RemoteAttachment(name: "mobile-image-\(added.count + 1).jpg",
                                                      data: reference, isImage: true))
                        try store.savePreview(reference, encoded.preview)
                        if let preview = UIImage(data: encoded.preview) { previews[reference] = preview }
                    } else {
                        // The picker offers every file. Match Android's
                        // whitelist before the computer receives its bytes.
                        let read = try ChatDocument.read(name: file.name, data: file.readData(), local: false)
                        let reference = try store.save(read.bytes)
                        added.append(RemoteAttachment(name: read.name, data: reference, isImage: false))
                    }
                }
                var sizes: [String: Int64] = [:]
                for attachment in existing + added {
                    sizes[attachment.data] = try store.size(attachment.data)
                }
                try AttachmentRules.validateRemote(existing + added, sizes: sizes,
                                                   expanded: expanded, files: files,
                                                   multiImage: multiImage)
            } catch {
                for attachment in added { store.remove(attachment.data) }
                added = []
                previews = [:]
                failure = Self.describe(error)
            }
            DispatchQueue.main.async {
                guard self.attachmentTaskId == taskId else {
                    for attachment in added { store.remove(attachment.data) }
                    return
                }
                self.attachmentTaskId = nil
                self.attaching = false
                guard self.openId == target, self.current?.address == computer else {
                    for attachment in added { store.remove(attachment.data) }
                    self.publish()
                    return
                }
                self.attachments.append(contentsOf: added)
                for (key, value) in previews { self.attachmentPreviews[key] = value }
                if !added.isEmpty { self.stashDraft() }
                if let failure { self.notice = Notice(text: failure, serious: false) }
                self.publish()
            }
        }
    }

    func removeAttachment(_ attachment: RemoteAttachment) {
        attachments.removeAll { $0.data == attachment.data }
        attachmentPreviews.removeValue(forKey: attachment.data)
        // `persistDrafts` removes the old blob only after the new draft state
        // is safely stored. Deleting first would leave the encrypted profile
        // pointing at a missing file if that write failed.
        stashDraft()
        AppStores.attachmentStore.remove(attachment.data)
        publish()
    }

    func clearAttachments() {
        let previous = attachments
        attachments = []
        attachmentPreviews = [:]
        stashDraft()
        for attachment in previous { AppStores.attachmentStore.remove(attachment.data) }
        publish()
    }

    /// Puts a refused selection back, rebuilding the tray previews from disk.
    private func restoreAttachments(_ list: [RemoteAttachment]) {
        guard !list.isEmpty else { return }
        attachments = list
        attachmentPreviews = [:]
        for attachment in list where attachment.isImage {
            guard attachmentPreviews[attachment.data] == nil,
                  let data = try? AppStores.attachmentStore.preview(attachment.data),
                  let image = UIImage(data: data) else { continue }
            attachmentPreviews[attachment.data] = image
        }
    }

    /// Drops the blobs a send just succeeded with.
    private func clearPendingBlobs() {
        for attachment in pendingAttachments { AppStores.attachmentStore.remove(attachment.data) }
        pendingAttachments = []
    }

    /// Saves what is in the composer for the conversation being left.
    private func stashDraft() {
        guard let id = openId else { return }
        if draft.isEmpty, attachments.isEmpty, editingSeq == nil {
            drafts.removeValue(forKey: id)
        } else {
            drafts[id] = (draft, attachments, editingSeq)
        }
        persistDrafts()
    }

    /// Loads every remote composer saved for one computer.
    private func loadStoredDrafts(from computer: PairedComputer?) {
        drafts = [:]
        guard let computer else { return }
        let texts = computer.drafts?.raw ?? [:]
        let edits = computer.draftEdits?.raw ?? [:]
        let files = computer.draftAttachments?.raw ?? [:]
        let ids = Set(texts.keys).union(edits.keys).union(files.keys)
        for id in ids {
            let text = texts[id] as? String ?? ""
            let rawEdit = computer.draftEdits?.long(id, fallback: -1) ?? -1
            let edit = rawEdit > 0 ? rawEdit : nil
            let attachments = computer.draftAttachments?.object(id)
                .map(AttachmentRules.restore) ?? []
            if !text.isEmpty || edit != nil || !attachments.isEmpty {
                drafts[id] = (text, attachments, edit)
            }
        }
    }

    /// Writes the in-memory draft map into the selected encrypted profile.
    private func persistDrafts() {
        guard let address = current?.address, current?.isPaired == true else { return }
        var texts: [String: Any] = [:]
        var edits: [String: Any] = [:]
        var files: [String: Any] = [:]
        for (id, state) in drafts {
            if !state.text.isEmpty { texts[id] = state.text }
            if let edit = state.edit { edits[id] = edit }
            if !state.attachments.isEmpty {
                files[id] = ["attachments": state.attachments.map(\.json)]
            }
        }
        let oldReferences = AttachmentStore.references(in: current?.draftAttachments?.raw ?? [:])
        do {
            let updated = try store.update(address: address) { computer in
                computer.drafts = JSONObject(dictionary: texts)
                computer.draftEdits = JSONObject(dictionary: edits)
                computer.draftAttachments = JSONObject(dictionary: files)
            }
            adopt(updated)
            // A selection removed from a saved draft has no owner unless it is
            // also the operation currently awaiting acknowledgement.
            let retained = AttachmentStore.references(in: updated.draftAttachments?.raw ?? [:])
                .union(AttachmentStore.references(in: updated.pendingCommand?.raw ?? [:]))
            for reference in oldReferences.subtracting(retained) {
                AppStores.attachmentStore.remove(reference)
            }
        } catch {
            notice = Notice(text: "无法保存草稿：\(Self.describe(error))", serious: false)
        }
    }

    /// Replaces the in-memory copy of a profile after an atomic store update.
    private func adopt(_ updated: PairedComputer) {
        if current?.address == updated.address { current = updated }
        if let index = computers.firstIndex(where: { $0.address == updated.address }) {
            computers[index] = updated
        }
    }

    /// Brings back a conversation's saved composer state.
    private func loadDraft(_ id: String) {
        let saved = drafts[id]
        draft = saved?.text ?? ""
        editingSeq = saved?.edit
        restoreAttachments(saved?.attachments ?? [])
        if saved == nil { attachmentPreviews = [:] }
    }

    /// Rebuilds the unconfirmed bubble after a relaunch or a trip through the
    /// conversation list. The command payload, including attachment references,
    /// is the durable owner until the desktop gives a terminal answer.
    private func restorePendingOutgoing(for id: String) {
        outgoing = nil
        outgoingEcho = nil
        outgoingAt = 0
        outgoingLegacyImage = false
        pendingAttachments = []
        guard let pending = current?.pendingCommand,
              pending.text("conversationId") == id,
              let payload = pending.object("payload") else { return }
        let action = payload.text("action")
        guard action == "send" || action == "resend" else { return }
        let text = pending.text("draft", fallback: payload.text("prompt"))
        outgoingAt = pending.long("at")
        outgoingLegacyImage = payload.has("image")
        outgoingEcho = RemoteOutgoingEcho(instanceId: payload.text("instanceId"),
                                          expectedSeq: payload.long("expectedSeq"),
                                          prompt: payload.text("prompt"))
        outgoing = .unconfirmed(text, "未收到电脑确认：点击重试同一请求，避免重复发送。")
        pendingAttachments = AttachmentRules.restore(payload)
        // The journal owns this content. Showing a second editable copy would
        // invite a new request id for an operation that may already have run.
        draft = ""
        attachments = []
        attachmentPreviews = [:]
        editingSeq = nil
    }

    /// Clears the local bubble once the desktop has echoed the message back, or
    /// once it is clear it never will.
    private func settleOutgoing() {
        guard case .accepted = outgoing else { return }
        guard let outgoingEcho else { return }
        let matched = transcript.messages.contains {
            outgoingEcho.matches($0.message, currentInstanceId: transcript.instanceId)
        }
        if matched {
            outgoing = nil
            self.outgoingEcho = nil
            outgoingAt = 0
            outgoingLegacyImage = false
        }
    }

    /// Android suppresses the pending bubble as soon as its user row appears,
    /// even when the command remains unconfirmed and its retry status stays.
    var outgoingBubbleIsSynced: Bool {
        guard let outgoingEcho else { return false }
        return transcript.messages.contains {
            outgoingEcho.matches($0.message, currentInstanceId: transcript.instanceId)
        }
    }

    func stop() {
        guard canDrive, !commandBusy, !hasPendingDetailOperation,
              let id = openId, let runId = transcript.live?.runId, let session else { return }
        deliver(session: session, action: "stop", conversationId: id, payload: [
            "instanceId": transcript.instanceId, "runId": runId,
        ], outcome: { [weak self] in self?.report($0) })
    }

    /// Asks the composer to take focus, for the empty screen's button.
    func focusComposer() { composerFocusTick += 1 }

    /// Answers a tool request the desktop is waiting on.
    ///
    /// The payload is built by `RemoteApproval.answer` so that the required
    /// `allow` boolean lives next to the rule that needs it, and not in a screen
    /// where its absence reads as a stale approval.
    func approve(_ approval: RemoteApproval, allow: Bool) {
        guard canDrive, !commandBusy, !hasPendingDetailOperation,
              let id = openId, let runId = transcript.live?.runId, let session else { return }
        deliver(session: session, action: "approve", conversationId: id,
                payload: approval.answer(instanceId: transcript.instanceId, runId: runId, allow: allow),
                outcome: { [weak self] in self?.report($0) })
    }

    // MARK: - Queue and automation
    func subtaskCommand(_ task: RemoteSubtask, operation: String, extra: [String: Any] = [:]) {
        guard canDrive, !commandBusy, !hasPendingDetailOperation,
              let id = openId, let session,
              transcript.subagents.contains(where: { $0.id == task.id && $0.engine == task.engine }) else { return }
        var payload = task.command(operation: operation, instanceId: transcript.instanceId)
        for (key, value) in extra { payload[key] = value }
        deliver(session: session, action: "subagent-command", conversationId: id, payload: payload,
                outcome: { [weak self] in self?.report($0) })
    }

    /// Whether the composer should offer to enqueue rather than to send now.
    ///
    /// Only for a plain send: a rewrite cannot be queued, because the desktop
    /// has to drop the turns it replaces at the moment it applies it.
    var queuesInsteadOfSending: Bool {
        transcript.canQueue && editingSeq == nil && (transcript.busy || !transcript.queue.isEmpty)
    }

    /// The same gate drives the button and the command. A newly reset
    /// transcript has no sequence yet, and an accepted send may not yet have
    /// appeared in the next snapshot; neither is a safe moment to send again.
    var canSubmitDraft: Bool {
        guard canDrive, session != nil,
              !attaching, !hasPendingDetailOperation, !commandBusy else { return false }
        if case .accepted? = outgoing { return false }
        guard !transcript.busy || queuesInsteadOfSending else { return false }
        guard editingSeq == nil || transcript.queue.isEmpty else { return false }
        let text = ComposerText.androidTrim(draft)
        guard ComposerText.remoteHasMessage(composed: text, hasAttachments: !attachments.isEmpty) else { return false }
        let findWhileBusy = transcript.busy
            && text.range(of: "(?is)^/find(?:\\s.*)?$", options: .regularExpression) != nil
        return !findWhileBusy
    }

    /// Takes one queued message out of the queue.
    func removeQueued(_ queueId: String) {
        guard canDrive, !commandBusy, !hasPendingDetailOperation,
              let session, let id = openId else { return }
        deliver(session: session, action: "queue-remove", conversationId: id, payload: [
            "instanceId": transcript.instanceId, "queueId": queueId,
        ], outcome: { [weak self] in self?.report($0) })
    }

    /// Releases a queue the desktop paused — after a failure, a stop, or a
    /// change in remote access.
    func resumeQueue() {
        guard canDrive, !commandBusy, !hasPendingDetailOperation,
              let session, let id = openId else { return }
        deliver(session: session, action: "queue-resume", conversationId: id, payload: [
            "instanceId": transcript.instanceId,
        ], outcome: { [weak self] in self?.report($0) })
    }

    /// Pauses or resumes the conversation's goal.
    func controlGoal(_ pause: Bool) {
        guard canDrive, !commandBusy, !hasPendingDetailOperation,
              let session, let id = openId else { return }
        deliver(session: session, action: "goal-control", conversationId: id, payload: [
            "instanceId": transcript.instanceId, "operation": pause ? "pause" : "resume",
        ], outcome: { [weak self] in self?.report($0) })
    }

    /// Pauses or resumes one scheduled task.
    func controlTask(_ taskId: String, pause: Bool) {
        guard canDrive, !commandBusy, !hasPendingDetailOperation,
              let session, let id = openId else { return }
        deliver(session: session, action: "task-control", conversationId: id, payload: [
            "instanceId": transcript.instanceId,
            "operation": pause ? "pause" : "resume",
            "taskId": taskId,
        ], outcome: { [weak self] in self?.report($0) })
    }

    func configure(_ key: String, value: String) {
        guard canDrive, !commandBusy, !hasPendingDetailOperation,
              let session, let id = openId,
              let settings = transcript.settings, settings.editable else { return }
        configuring = true
        deliver(session: session, action: "configure", conversationId: id, payload: [
            "instanceId": transcript.instanceId,
            "expectedSettings": settings.version,
            "settings": [key: value],
        ]) { [weak self] result in
            guard let self else { return }
            self.configuring = false
            self.report(result)
        }
    }

    // MARK: - Conversation actions

    /// A new conversation that is waiting for its engine to be chosen.
    ///
    /// Carries the workspace the person already picked, so the two-step flow
    /// (which workspace, then which engine) does not lose the first answer.
    struct EngineChoice: Identifiable {
        let id = UUID()
        let workspaceId: String?
    }

    /// Asks which engine a new conversation should run, before creating it.
    ///
    /// Android opens this choice even when just one engine is advertised, so
    /// the phone only sends after a row is tapped. An explicitly empty list
    /// offers no row and never invents a default engine.
    func beginCreateConversation(workspaceId: String? = nil) {
        guard access.canCreate, workspaceId != nil || includeUnassigned else {
            notice = Notice(text: "请更新电脑端，并授权控制及对应会话范围。", serious: false)
            return
        }
        if hasPendingListOperation { retryPendingListOperation(); return }
        engineChoice = EngineChoice(workspaceId: workspaceId)
    }

    /// Creates a conversation on the desktop and opens it.
    ///
    /// `engine` names the execution engine the person chose; nil means "let the
    /// desktop default it", which is what an old desktop that advertised no list
    /// gets. Android sends the same `engine` field on the `create` command.
    func createConversation(workspaceId: String? = nil, engine: String? = nil) {
        guard !commandBusy, !hasPendingListOperation, let session,
              access.canCreate, workspaceId != nil || includeUnassigned else { return }
        var payload: [String: Any] = [
            "instanceId": listInstanceId,
            "workspaceId": workspaceId.map { $0 as Any } ?? NSNull(),
        ]
        if let engine { payload["engine"] = engine }
        deliver(session: session, action: "create", payload: payload) { [weak self] result in
            guard let self else { return }
            switch result {
            case .accepted(let value):
                self.refreshList()
                if let conversation = value.conversation {
                    if !self.conversations.contains(where: { $0.id == conversation.id }) {
                        self.conversations.append(conversation)
                    }
                    self.createdConversationId = conversation.id
                }
            case .refused, .unconfirmed, .transportUnconfirmed:
                self.report(result)
            }
        }
    }
    func forkConversation(_ conversation: RemoteConversation) {
        guard !commandBusy, !hasPendingListOperation, access.canCreate,
              access.capabilities.contains(.fork), let session else { return }
        deliver(session: session, action: "fork", conversationId: conversation.id,
                payload: ["instanceId": listInstanceId, "expectedSeq": conversation.seq], pendingSlot: .list) { [weak self] result in
            guard let self else { return }
            if case .accepted(let value) = result, let fork = value.conversation {
                self.conversations.append(fork); self.createdConversationId = fork.id; self.refreshList()
            } else { self.report(result) }
        }
    }

    /// Creates a workspace on the desktop.
    ///
    /// Android's `create-workspace` command, and the path is the part worth
    /// being careful about: the desktop makes a real folder there, so it is an
    /// absolute path *on the computer* — a path on this phone could not name
    /// anything on the other side of the tunnel. The same pair of permissions
    /// gates it as on Android: control, plus the desktop advertising that it
    /// takes the command at all.
    func createWorkspace(name: String, path: String) {
        guard !commandBusy, !hasPendingListOperation,
              access.canCreateWorkspace, let session else { return }
        let trimmedName = ComposerText.androidTrim(name)
        let trimmedPath = ComposerText.androidTrim(path)
        // The bounds the desktop enforces, checked here so the refusal is about
        // the field rather than a round trip.
        guard !trimmedName.isEmpty, ComposerText.utf16Length(trimmedName) <= 200 else {
            notice = Notice(text: trimmedName.isEmpty ? "请输入名称。" : "名称最多 200 字。", serious: false)
            return
        }
        guard !trimmedPath.isEmpty, ComposerText.utf16Length(trimmedPath) <= 1024 else {
            notice = Notice(text: trimmedPath.isEmpty ? "请输入电脑文件夹路径。" : "路径最多 1024 字。", serious: false)
            return
        }
        let payload: [String: Any] = ["instanceId": listInstanceId,
                                      "name": trimmedName, "path": trimmedPath]
        deliver(session: session, action: "create-workspace", payload: payload) { [weak self] result in
            guard let self else { return }
            switch result {
            case .accepted:
                self.refreshList()
            case .refused, .unconfirmed, .transportUnconfirmed:
                self.report(result)
            }
        }
    }

    /// Renames, pins or deletes conversations.
    ///
    /// The desktop takes these as one command naming every affected
    /// conversation together with the sequence the phone last saw for it, so a
    /// desktop that has moved on can refuse rather than act on a stale view.
    func conversationAction(_ action: String, ids: [String], extra: [String: Any] = [:],
                            onAccepted: (() -> Void)? = nil) {
        guard !commandBusy, !hasPendingListOperation,
              access.canManageConversations, let session else { return }
        guard ids.count <= 100 else {
            notice = Notice(text: "每次最多选择 100 个会话。", serious: false)
            return
        }
        let targets: [[String: Any]] = ids.compactMap { id in
            guard let conversation = conversations.first(where: { $0.id == id }) else { return nil }
            return ["id": id, "seq": conversation.seq]
        }
        guard !targets.isEmpty, targets.count == ids.count else {
            notice = Notice(text: "会话已变化，请刷新后再试。", serious: false)
            return
        }
        var payload: [String: Any] = ["instanceId": listInstanceId, "targets": targets]
        for (key, value) in extra { payload[key] = value }
        deliver(session: session, action: action, payload: payload) { [weak self] result in
            guard let self else { return }
            switch result {
            case .accepted:
                if action == "delete" { self.forgetPrefetched(ids) }
                onAccepted?()
                self.refreshList()
            case .refused, .unconfirmed, .transportUnconfirmed:
                self.report(result)
            }
        }
    }

    func renameConversation(_ conversation: RemoteConversation, to title: String) {
        let trimmed = ComposerText.androidTrim(title)
        // The same bound the desktop enforces, checked here so the refusal is
        // about the field the person is looking at rather than a round trip.
        guard !trimmed.isEmpty, ComposerText.utf16Length(trimmed) <= 100 else {
            notice = Notice(text: "请输入 1–100 字的标题。", serious: false)
            return
        }
        conversationAction("rename", ids: [conversation.id], extra: ["title": trimmed])
    }

    func togglePin(_ conversation: RemoteConversation) {
        conversationAction("pin", ids: [conversation.id], extra: ["pinned": !conversation.pinned])
    }

    func deleteConversations(_ ids: [String], onAccepted: (() -> Void)? = nil) {
        conversationAction("delete", ids: ids, onAccepted: onAccepted)
    }

    /// Archives one conversation.
    ///
    /// Unlike the others this names a single conversation and its sequence
    /// directly rather than sending a target list, which is the shape the
    /// desktop expects for it.
    func archiveConversation(_ conversation: RemoteConversation) {
        guard !commandBusy, !hasPendingListOperation, access.canArchive, let session else { return }
        deliver(session: session, action: "archive", payload: [
            "instanceId": listInstanceId,
            "conversationId": conversation.id,
            "expectedSeq": conversation.seq,
        ]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .accepted:
                self.forgetPrefetched([conversation.id])
                self.refreshList()
            case .refused, .unconfirmed, .transportUnconfirmed:
                self.report(result)
            }
        }
    }

    // MARK: - Artifacts

    func beginArtifactSheet() {
        artifactSheetOpen = true
        artifacts = []
        artifactsMore = false
        artifactsNext = -1
        artifactsError = nil
        artifactsLoading = false
        loadArtifacts()
    }

    func endArtifactSheet() {
        artifactSheetGeneration += 1
        artifactSheetOpen = false
        artifactsLoading = false
    }

    /// Loads the conversation's files, a page at a time.
    ///
    /// The desktop lists what this conversation referenced and that still
    /// exists, including files it produced in another directory. An empty list
    /// is a real answer rather than an error, which is why the screen says so
    /// instead of showing a failure.
    func loadArtifacts(more: Bool = false) {
        guard artifactSheetOpen, let session, let id = openId else { return }
        guard !artifactsLoading else { return }
        let offset = more ? artifactsNext : 0
        guard !more || offset >= 0 else { return }
        artifactSheetGeneration += 1
        let ticket = artifactSheetGeneration
        artifactsLoading = true
        artifactsError = nil
        publish()
        session.artifacts(conversationId: id, offset: offset) { [weak self] result in
            guard let self else { return }
            guard self.artifactSheetOpen, self.artifactSheetGeneration == ticket,
                  self.openId == id else { return }
            self.artifactsLoading = false
            switch result {
            case .success(let page):
                self.artifacts = more ? self.artifacts + page.items : page.items
                self.artifactsNext = page.nextOffset
                self.artifactsMore = !page.isLast
            case .failure(let error):
                self.artifactsError = Self.describe(error)
            }
            self.publish()
        }
    }

    /// Fetches one file into a private temporary directory for the Files picker.
    func downloadArtifact(_ artifact: RemoteArtifact, filename: String,
                          progress: @escaping (Int64, Int64) -> Void,
                          completion: @escaping (Result<URL, Error>) -> Void) -> ArtifactTransfer? {
        guard let session, let id = openId else {
            completion(.failure(RemoteSession.SessionError.notPaired))
            return nil
        }
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("camellia-export-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            completion(.failure(error))
            return nil
        }
        let destination = folder.appendingPathComponent(filename)
        return session.downloadArtifact(conversationId: id, hash: artifact.id, expectedSize: artifact.size,
                                        to: destination, progress: progress) { result in
            if case .failure = result { try? FileManager.default.removeItem(at: folder) }
            completion(result)
        }
    }

    // MARK: - Local-chat bridge

    /// Adopts this computer's provider bundle on the local-chat half.
    ///
    /// The one place the two halves meet: the keys live on the desktop and the
    /// phone wants them for its own direct calls. It goes through the same
    /// validator a pasted configuration does, so a desktop that answers with
    /// something unusable is reported on the local-chat side rather than here.
    /// The remote side only carries the bytes.
    func importApiKeys(into local: LocalChatModel) {
        guard let current else {
            local.notice = LocalChatModel.Notice(text: "还没有配对的电脑。先添加一台电脑再导入。", serious: false)
            return
        }
        importApiKeys(from: current, into: local)
    }

    /// Imports from the computer the person selected, not implicitly from the
    /// current remote-control tab. Android asks when several pairings exist;
    /// doing the same avoids replacing local keys from the wrong machine.
    func importApiKeys(from computer: PairedComputer, into local: LocalChatModel) {
        guard computer.isPaired, let endpoint = computer.endpoint, let token = computer.token else {
            local.notice = LocalChatModel.Notice(text: "这台电脑还没有完成配对。", serious: false)
            return
        }
        let source: RemoteSession
        do {
            source = try RemoteSession(computer: computer,
                                       transport: try RemoteApi(endpoint: endpoint, token: token))
        } catch {
            local.notice = LocalChatModel.Notice(text: Self.describe(error), serious: true)
            return
        }
        source.apiKeys { result in
            switch result {
            case .success(let raw):
                local.importRemoteConfig(raw)
            case .failure(let error):
                local.notice = LocalChatModel.Notice(text: Self.describe(error), serious: true)
            }
        }
    }

    // MARK: - Plumbing

    /// The transcript is a class, so changing it does not publish by itself.
    private func publish() {
        objectWillChange.send()
    }

    /// Turns any error into the sentence the person reads.
    ///
    /// `nonisolated` because the background encodes that fail on a photo need
    /// it too, and hopping to the main actor just to format a string would put
    /// the message a queue behind the failure.
    nonisolated static func describe(_ error: Error) -> String {
        if let failure = error as? RemoteApi.Failure {
            let language = MobilePreferences(store: UserDefaultsPreferenceStore()).language
            let chinese = language == .simplifiedChinese
                || (language == .system && Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") == true)
            return RemoteFailure.httpMessage(status: failure.status, detail: failure.detail, chinese: chinese)
        }
        return error.localizedDescription
    }
}

private func deviceModel() -> String {
    // `hw.machine` is `arm64` in the simulator, which makes a poor pairing
    // name. The user-visible device name is the closest iOS equivalent to
    // Android's Build.MODEL and can still be changed in Camellia settings.
    UIDevice.current.name
}
