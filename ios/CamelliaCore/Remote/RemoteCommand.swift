import Foundation

// MARK: - Entry gate

/// What stands between the user and the remote-control entry on the home page.
///
/// Android probes every 1.5 s and gives up after 30 s of `connecting`. The
/// states are the same here so the two clients explain a stalled connection the
/// same way.
public enum RemoteEntryGate: String, Sendable, Equatable {
    case connecting
    case ready
    case offline
    case signIn
    case timedOut
    case failed

    public var settled: Bool {
        switch self {
        case .connecting: return false
        default: return true
        }
    }
}

/// Drives `RemoteEntryGate` from node probes. The clock is supplied by the
/// caller so the thirty-second rule is testable without waiting for a tunnel.
public struct EntryGateTracker {
    public static let probeInterval: TimeInterval = 1.5
    public static let timeout: TimeInterval = 30

    private var startedAt: TimeInterval

    public init(now: TimeInterval) { startedAt = now }

    /// A manual retry gives the connection a fresh window.
    public mutating func restart(now: TimeInterval) { startedAt = now }

    public func remaining(now: TimeInterval) -> TimeInterval {
        max(0, Self.timeout - (now - startedAt))
    }

    public mutating func observe(now: TimeInterval, online: Bool, embedded: Bool,
                                 node: NodeState, hasLoginURL: Bool,
                                 failed: Bool) -> RemoteEntryGate {
        if !online {
            startedAt = now
            return .offline
        }
        if !embedded {
            startedAt = now
            return .ready
        }
        if failed { return .failed }
        if node.isRunning {
            startedAt = now
            return .ready
        }
        // iOS presents sign-in inside this app. Closing that sheet does not
        // produce Android's Activity.onStart, so the first probe after sign-in
        // must still have a full connection window instead of inheriting time
        // spent in the browser.
        if node.awaitsSignIn || hasLoginURL {
            startedAt = now
            return .signIn
        }
        return now - startedAt >= Self.timeout ? .timedOut : .connecting
    }
}

/// Decides what a command response means, following Android's rules.
public enum CommandAck: Sendable, Equatable {
    /// The desktop has not decided yet: ask again with the same request id.
    case pending
    /// The desktop forgot the idempotency record; the user must decide.
    case unknown
    /// Queued on the desktop; the local bubble can go.
    case queued
    /// Accepted, with the seq the user message will appear under.
    case accepted(userSeq: Int64?)
    /// Refused; the draft goes back to the composer.
    case rejected

    public init(result: CommandResult) {
        // Android checks the two nonterminal states before `ok`. Both retain
        // the journal even when an older desktop omits or clears that flag.
        switch result.state {
        case "pending": self = .pending
        case "unknown": self = .unknown
        default:
            guard result.ok else { self = .rejected; return }
            self = result.state == "queued" ? .queued : .accepted(userSeq: result.userSeq)
        }
    }
}

// MARK: - Backoff

/// Retry delays for streams and commands.
///
/// Two different shapes, both from Android: a fixed 60 s after a 429 and an
/// exponential delay otherwise. A stream that delivered a snapshot resets the
/// failure count, but still waits one second before reopening.
public struct RemoteBackoff {
    public static let rateLimitDelay: TimeInterval = 60
    public static let maximumDelay: TimeInterval = 30
    public static let maximumAttempts = 5

    private var attempt = 0

    public init() {}

    public mutating func next(after status: Int? = nil, received: Bool = false) -> TimeInterval {
        attempt = received ? 0 : min(attempt + 1, Self.maximumAttempts)
        if status == 429 { return Self.rateLimitDelay }
        return min(Self.maximumDelay, pow(2, Double(attempt)))
    }

    public var attempts: Int { attempt }
}


// MARK: - Unread

/// Whether a conversation has a reply the phone has not shown.
///
/// Keyed by a digest of address, token and conversation id rather than by the
/// conversation id alone, so two computers with the same session id do not
/// share a read state.
public struct RemoteReadState: Sendable {
    private var seen: [String: Int64] = [:]

    public init() {}

    public static func key(address: String, token: String, conversationId: String) -> String {
        // A digest keeps the token out of any persisted dictionary.
        let material = "\(address)\n\(token)\n\(conversationId)"
        return material.sha256
    }

    public func unread(address: String, token: String, conversation: RemoteConversation) -> Bool {
        let key = Self.key(address: address, token: token, conversationId: conversation.id)
        let local = seen[key] ?? 0
        return conversation.lastReplyAt > max(conversation.replyReadAt, local)
    }

    public mutating func markRead(address: String, token: String, conversation: RemoteConversation) {
        let key = Self.key(address: address, token: token, conversationId: conversation.id)
        seen[key] = max(seen[key] ?? 0, conversation.lastReplyAt)
    }
}
