import Foundation

/// The node states `bridge.go` reports, named once.
///
/// Both apps read the state as a string and both want to say what it means, so
/// the mapping lives here rather than twice in the two view layers. An
/// unrecognised value is kept verbatim: the bridge may learn a state before the
/// app does, and showing it is more useful than hiding it.
public enum NodeState: Sendable, Equatable {
    case running
    case needsLogin
    case needsMachineAuth
    case starting
    case stopped
    case notStarted
    /// A state this build does not have a name for.
    case other(String)

    public init(raw: String) {
        switch raw {
        case "Running": self = .running
        case "NeedsLogin": self = .needsLogin
        case "NeedsMachineAuth": self = .needsMachineAuth
        case "Starting": self = .starting
        case "Stopped": self = .stopped
        case "NoState", "—", "": self = .notStarted
        default: self = .other(raw)
        }
    }

    /// Whether the tunnel is up and able to carry a request.
    public var isRunning: Bool { self == .running }

    /// Whether the person still has to sign this device in.
    public var awaitsSignIn: Bool { self == .needsLogin || self == .needsMachineAuth }

    public func label(chinese: Bool = true) -> String {
        switch self {
        case .running: return chinese ? "已连接" : "Connected"
        case .needsLogin: return chinese ? "等待登录" : "Waiting for sign-in"
        case .needsMachineAuth: return chinese ? "等待管理员批准" : "Waiting for approval"
        case .starting: return chinese ? "启动中" : "Starting"
        case .stopped: return chinese ? "已停止" : "Stopped"
        case .notStarted: return chinese ? "未启动" : "Not started"
        case .other(let raw): return raw
        }
    }
}
