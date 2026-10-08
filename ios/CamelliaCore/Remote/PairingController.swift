import Foundation

/// What the pairing form holds.
///
/// Kept as strings rather than a validated `Endpoint` because that is what the
/// form is made of: the user is still typing, and half of an address has to be
/// representable so it can be reported back as a field error instead of as a
/// crash.
public struct PairingDraft: Equatable, Sendable {
    public var address: String
    public var port: String
    public var code: String
    public var name: String

    public static let defaultPort = "43127"

    public init(address: String = "", port: String = defaultPort, code: String = "", name: String = "") {
        self.address = address
        self.port = port
        self.code = code
        self.name = name
    }

    /// The draft after a QR code was read.
    ///
    /// The payload carries an origin, while the form wants the host and the port
    /// in separate fields; splitting them here is what stops the form from
    /// building `http://http://…:port:port` on submission.
    public init(payload: PairingPayload, name: String, port: String = defaultPort) {
        let endpoint = try? Endpoint(payload.address)
        address = endpoint?.host ?? ""
        self.port = endpoint.map { String($0.port) } ?? port
        code = payload.code
        self.name = name
    }
}

/// Which field a rejected submission belongs to.
public enum PairingField: String, Sendable, CaseIterable {
    case address
    case port
    case code
    case name
}

public struct PairingFieldError: Error, Equatable, LocalizedError {
    public let field: PairingField
    public let message: String

    public init(_ field: PairingField, _ message: String) {
        self.field = field
        self.message = message
    }

    public var errorDescription: String? { message }
}

public enum PairingFlowError: Error, Equatable, LocalizedError {
    /// The desktop answered, but not with credentials this phone may store.
    case unusableCredentials
    /// The stored request has no claim to resume.
    case nothingToResume

    public var errorDescription: String? {
        switch self {
        case .unusableCredentials:
            return "电脑返回的凭据无法通过校验，请重新配对。"
        case .nothingToResume:
            return "没有等待确认的配对请求。"
        }
    }
}

/// The two pairing calls, without the transport behind them.
///
/// `/v1/pair/request` and `/v1/pair/claim` are the only calls the desktop takes
/// without a bearer token, which is why they sit apart from the rest of the
/// remote API. Behind a protocol so the flow can be checked against a stub.
public protocol PairingTransport {
    /// The origin belongs to the call, not to mutable transport state: a
    /// second tap may choose another computer while the first dial is queued.
    func pairRequest(origin: String, code: String, name: String) throws -> PairRequestResult
    func pairClaim(origin: String, id: String, claim: String) throws -> PairClaimResult
}

/// The clock, in the pairing's own terms: epoch milliseconds, which is what
/// the desktop's `expiresAt` is written in.
public typealias PairingClock = () -> Int64

/// Schedules the next claim poll.
///
/// Android posts a delayed `Runnable` on the main looper; iOS would use a
/// `Timer`. Injected so the five-second rule is checked without waiting five
/// seconds, and so a test can decide exactly when the next poll happens.
public protocol PairingScheduler {
    func schedule(after seconds: TimeInterval, _ work: @escaping () -> Void)
    func cancel()
}

/// A scheduler that only runs when told to.
public final class ManualScheduler: PairingScheduler {
    private var due: [(TimeInterval, () -> Void)] = []

    public init() {}

    /// The delays that are waiting, in the order they were scheduled.
    public var pending: [TimeInterval] { due.map { $0.0 } }

    public func schedule(after seconds: TimeInterval, _ work: @escaping () -> Void) {
        due.append((seconds, work))
    }

    public func cancel() { due = [] }

    /// Runs everything that is due, including anything it schedules in turn.
    ///
    /// Bounded, because a stub that always answers "not yet" would otherwise
    /// loop forever; the limit is high enough that any real poll sequence fits.
    @discardableResult
    public func drain(limit: Int = 100) -> Int {
        var ran = 0
        while !due.isEmpty, ran < limit {
            let next = due.removeFirst()
            ran += 1
            next.1()
        }
        return ran
    }
}

/// A scheduler backed by the main queue, which is where the phases are read.
public final class DispatchScheduler: PairingScheduler {
    private let queue: DispatchQueue

    public init(queue: DispatchQueue = .main) { self.queue = queue }

    public func schedule(after seconds: TimeInterval, _ work: @escaping () -> Void) {
        queue.asyncAfter(deadline: .now() + seconds) { work() }
    }

    public func cancel() {}
}

/// Drives one pairing from the form to a stored token.
///
/// Ported from the `requestPairing` / `waitForApproval` / `pollPair` trio in
/// `MainActivity`. The interesting part is the middle: after the request is in,
/// the phone holds a claim handle and a deadline and does nothing else until the
/// desktop approves, polling every five seconds. Every one of those polls has to
/// be harmless to repeat, because the app is suspended and resumed, killed and
/// relaunched, and moved between networks while it waits — which is also why the
/// claim is persisted rather than kept in memory, so a relaunch resumes the same
/// request instead of asking for a new code.
public final class PairingController {
    /// Where one pairing has got to.
    public enum Phase: Equatable, Sendable {
        case idle
        case requesting
        /// The request is in. `expiry` is epoch milliseconds, 0 if the desktop
        /// did not give one.
        case awaitingApproval(expiry: Int64)
        case approved(PairedComputer)
        /// The deadline passed before the desktop answered.
        case expired
        case failed(String)

        public var isBusy: Bool {
            switch self {
            case .requesting, .awaitingApproval: return true
            default: return false
            }
        }
    }

    /// Android's interval between claim polls.
    public static let pollInterval: TimeInterval = 5

    private let transport: PairingTransport
    private let store: ComputerStore
    private let scheduler: PairingScheduler
    private let clock: PairingClock
    private let worker: (@escaping () -> Void) -> Void
    private let notify: (@escaping () -> Void) -> Void
    private let message: (Error) -> String
    private let pollInterval: TimeInterval
    private var generation = 0
    /// Guards `generation`, which is bumped on the caller's thread and read on
    /// the worker and poll queues.
    private let ticketLock = NSLock()

    /// The current phase. Published through `onChange` on the notify queue.
    public private(set) var phase: Phase = .idle

    public var onChange: ((Phase) -> Void)?
    /// The draft as the flow last saw it, so the form can be refilled after a
    /// restart. Cleared once a pairing is approved.
    public private(set) var draft = PairingDraft()

    public init(
        transport: PairingTransport,
        store: ComputerStore,
        scheduler: PairingScheduler = DispatchScheduler(),
        clock: @escaping PairingClock = { Int64(Date().timeIntervalSince1970 * 1000) },
        pollInterval: TimeInterval = PairingController.pollInterval,
        worker: @escaping (@escaping () -> Void) -> Void = { DispatchQueue.global(qos: .userInitiated).async(execute: $0) },
        notify: @escaping (@escaping () -> Void) -> Void = { DispatchQueue.main.async(execute: $0) },
        message: @escaping (Error) -> String = PairingController.defaultMessage
    ) {
        self.transport = transport
        self.store = store
        self.scheduler = scheduler
        self.clock = clock
        self.pollInterval = pollInterval
        self.worker = worker
        self.notify = notify
        self.message = message
    }

    // MARK: - Starting

    /// Validates the draft and sends the pairing request.
    ///
    /// Validation throws on the calling thread, so the form can point at the
    /// field that is wrong; the request itself runs on the worker queue, because
    /// it blocks on the tunnel.
    public func start(_ draft: PairingDraft) throws {
        let endpoint = try Self.validate(draft)
        let (name, code) = try Self.validate(name: draft.name, code: draft.code)

        // Invalidate older workers before changing the current computer. A
        // late result then cannot race this new request's initial save.
        let ticket = begin()
        self.draft = draft
        var computer = PairedComputer(address: endpoint.origin, name: name)
        // Keep the label this phone already gave the computer, so re-pairing
        // does not silently reset a name the user chose.
        if let previous = try? store.current(), previous.address == endpoint.origin {
            computer.computerName = previous.computerName
        }
        try store.save(computer)

        publish(.requesting, ticket: ticket)
        worker { [weak self] in self?.request(endpoint: endpoint, name: name, code: code, computer: computer, ticket: ticket) }
    }

    /// Picks a stored request back up, after a relaunch or a network change.
    public func resume() throws {
        let ticket = begin()
        let computer = try store.current()
        guard computer.isAwaitingApproval else { throw PairingFlowError.nothingToResume }
        draft = draft(for: computer)
        publish(.awaitingApproval(expiry: computer.expiresAt ?? 0), ticket: ticket)
        scheduleClaim(computer, ticket: ticket)
    }

    /// Stops polling and forgets where the flow was.
    ///
    /// The stored claim is left alone: cancelling means "stop waiting", not
    /// "withdraw the request", and the desktop may still approve it.
    public func cancel() {
        let ticket = begin()
        scheduler.cancel()
        publish(.idle, ticket: ticket)
    }

    /// Drops a stored claim that can no longer be used, so the form starts clean.
    public func abandon() throws {
        let ticket = begin()
        scheduler.cancel()
        try store.clearClaim()
        publish(.idle, ticket: ticket)
    }

    // MARK: - Tickets

    /// Starts a run by taking the next ticket, invalidating every older one.
    private func begin() -> Int {
        ticketLock.lock()
        defer { ticketLock.unlock() }
        generation += 1
        return generation
    }

    /// Whether a run is still the one the flow is following.
    ///
    /// Asked twice: once when the run starts, and again when its call comes
    /// back. Both calls block — a dial waits on the tunnel — and the person can
    /// tap 请求配对 a second time, or cancel, while one is open. The run that
    /// was superseded must not go on to write: it would store a claim for a
    /// pairing nobody is waiting for, and — because it lands on the *current*
    /// computer — it could take the credentials off a pairing the desktop had
    /// just approved, leaving the phone paired in the computer list but not on
    /// the remote-control screen. Its failure must not be reported either, for
    /// the same reason: the newer run's status line is the true one.
    private func isCurrent(_ ticket: Int) -> Bool {
        ticketLock.lock()
        defer { ticketLock.unlock() }
        return ticket == generation
    }

    /// A generation check and its store write must be indivisible relative to
    /// `begin()`. Checking only before a blocking save leaves a small window in
    /// which a newer pairing can become current and then be overwritten.
    private func commitIfCurrent(_ ticket: Int, _ commit: () throws -> Void) throws -> Bool {
        ticketLock.lock()
        defer { ticketLock.unlock() }
        guard ticket == generation else { return false }
        try commit()
        return true
    }

    // MARK: - Validation

    /// Checks the form, throwing with the field that has to be corrected.
    @discardableResult
    public static func validate(_ draft: PairingDraft) throws -> Endpoint {
        let address = draft.address.trimmingCharacters(in: .whitespacesAndNewlines)
        let port = draft.port.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            return try Endpoint(host: address, port: port)
        } catch {
            // Two different messages for two different mistakes, decided the
            // way Android decides them: retry with the default port, and blame
            // the address only if that fails too.
            if (try? Endpoint(host: address, port: PairingDraft.defaultPort)) == nil {
                throw PairingFieldError(.address, "请填写电脑的 Tailscale IP，例如 100.80.1.2。")
            }
            throw PairingFieldError(.port, "端口应为 1–65535。")
        }
    }

    /// The name and code checks, which do not need an address.
    public static func validate(name: String, code: String) throws -> (name: String, code: String) {
        let trimmed = ComposerText.androidTrim(name)
        guard !trimmed.isEmpty, ComposerText.utf16Length(trimmed) <= 80 else {
            throw PairingFieldError(.name, "请输入本机名称，最多 80 个字符。")
        }
        let normalized = ComposerText.androidTrim(code)
        guard PairingPayload.isPairingCode(normalized) else {
            throw PairingFieldError(.code, "请填写电脑生成的 24 位配对码，或重新扫码。")
        }
        return (trimmed, normalized.lowercased())
    }

    // MARK: - The two calls

    private func request(endpoint: Endpoint, name: String, code: String, computer: PairedComputer, ticket: Int) {
        guard isCurrent(ticket) else { return }
        do {
            let result = try transport.pairRequest(origin: endpoint.origin, code: code, name: name)
            // The dial blocks, so the flow may have moved on while it was in
            // flight. Writing now would store a claim for a pairing nobody is
            // waiting for, and it would store it as the current computer.
            guard isCurrent(ticket) else { return }
            guard !result.id.isEmpty, !result.claim.isEmpty else {
                publish(.failed(PairingFlowError.unusableCredentials.localizedDescription), ticket: ticket)
                return
            }
            var next = computer
            next.pairingId = result.id
            next.claim = result.claim
            next.expiresAt = result.expiresAt
            // The desktop reports its own display name with the request; keep it
            // unless this phone already renamed the computer.
            if next.computerName.isEmpty, !result.computerName.isEmpty {
                next.computerName = result.computerName
            }
            guard try commitIfCurrent(ticket, { try store.save(next) }) else { return }
            publish(.awaitingApproval(expiry: result.expiresAt), ticket: ticket)
            scheduleClaim(next, ticket: ticket)
        } catch {
            guard isCurrent(ticket) else { return }
            publish(.failed(message(error)), ticket: ticket)
        }
    }

    private func scheduleClaim(_ computer: PairedComputer, ticket: Int) {
        scheduler.schedule(after: pollInterval) { [weak self] in
            self?.claim(computer, ticket: ticket)
        }
    }

    /// Forgets the form, from the queue the form is read on.
    ///
    /// The approval is noticed on the poll queue, and `draft` is read by the
    /// pairing screen on the main queue; a struct of four strings assigned from
    /// one while the other copies it is not an assignment either side can be
    /// sure of. It goes across the same notify bridge `publish` uses.
    private func clearDraft(ticket: Int) {
        notify {
            guard self.isCurrent(ticket) else { return }
            self.draft = PairingDraft()
        }
    }

    private func claim(_ computer: PairedComputer, ticket: Int) {
        guard isCurrent(ticket) else { return }
        guard let id = computer.pairingId, let handle = computer.claim else {
            publish(.failed(PairingFlowError.nothingToResume.localizedDescription), ticket: ticket)
            return
        }
        if computer.isExpired(now: clock()) {
            _ = try? commitIfCurrent(ticket) { _ = try store.clearClaim(ifMatching: computer) }
            publish(.expired, ticket: ticket)
            return
        }
        do {
            let result = try transport.pairClaim(origin: computer.address, id: id, claim: handle)
            // Same as the request: the poll blocks on the tunnel, so a run that
            // was superseded while it waited has nothing left to store or say.
            guard isCurrent(ticket) else { return }
            // Not approved yet is the normal answer, not a failure: keep the
            // claim and ask again.
            guard result.approved else { scheduleClaim(computer, ticket: ticket); return }
            guard result.hasUsableCredentials, let permission = result.permission else {
                publish(.failed(PairingFlowError.unusableCredentials.localizedDescription), ticket: ticket)
                return
            }

            var paired = computer
            paired.token = result.token
            paired.deviceId = result.deviceId
            paired.permission = permission
            paired.claim = nil
            paired.pairingId = nil
            paired.expiresAt = nil
            guard try commitIfCurrent(ticket, { try store.save(paired) }) else { return }
            clearDraft(ticket: ticket)
            publish(.approved(paired), ticket: ticket)
        } catch let error as RemoteHttpError where error.status == 401 {
            guard isCurrent(ticket) else { return }
            // The desktop refused the claim itself, so the handle is dead and
            // has to go; the address stays, so the user can generate a new code.
            _ = try? commitIfCurrent(ticket) { _ = try store.clearClaim(ifMatching: computer) }
            publish(.failed(message(error)), ticket: ticket)
        } catch {
            guard isCurrent(ticket) else { return }
            publish(.failed(message(error)), ticket: ticket)
        }
    }

    // MARK: - Plumbing

    private func draft(for computer: PairedComputer) -> PairingDraft {
        let endpoint = try? Endpoint(computer.address)
        return PairingDraft(
            address: endpoint?.host ?? "",
            port: endpoint.map { String($0.port) } ?? PairingDraft.defaultPort,
            code: "",
            name: computer.name
        )
    }

    private func publish(_ next: Phase, ticket: Int) {
        notify {
            guard self.isCurrent(ticket) else { return }
            // The desktop has accepted the one-time code. Keep only the
            // resumable claim, never prefill that consumed code on reopening.
            if case .awaitingApproval = next { self.draft.code = "" }
            self.phase = next
            self.onChange?(next)
        }
    }

    /// How a failed call is explained.
    ///
    /// The status the desktop answered with is used when there is one, because
    /// it says whether the pairing itself was refused; anything else is a
    /// tunnel failure, which says nothing about the pairing and must not read
    /// as though it does.
    public static func defaultMessage(_ error: Error) -> String {
        if let http = error as? RemoteHttpError {
            return RemoteFailure.httpMessage(status: http.status, detail: http.detail, chinese: true)
        }
        if let code = ConnectionFailureCode.parse(error.localizedDescription) {
            return code.text(chinese: true)
        }
        return error.localizedDescription
    }
}
