import Foundation

/// What the computers list shows for one paired computer.
///
/// Ported from the three strings Android's `computersScreen` puts in
/// `computerStates`, plus the two tests it makes on them. The state is a plain
/// string rather than an enum for the same reason it is one on Android: the row
/// renders whatever the last check produced, and a failure is a whole message
/// rather than a case, so an enum would only wrap the message back into a
/// string at the other end.
public enum ComputerStatus {
    /// No check has run yet, including the moment after a launch.
    public static let unchecked = "待检查"
    /// A check is in flight.
    public static let checking = "正在检查…"
    /// The desktop answered `/v1/status` with the protocol this build speaks.
    public static let connected = "已连接"

    /// Whether the row should show progress rather than an answer.
    ///
    /// Android treats "not checked" and "checking" alike so a fresh list shows
    /// the same grey dot everywhere instead of one green row and a column of
    /// red ones, which is what an unrun check would look like otherwise.
    public static func isChecking(_ state: String) -> Bool {
        state == unchecked || state == checking
    }

    public static func isConnected(_ state: String) -> Bool { state == connected }

    /// Keep the stored state language-neutral for status checks, and translate
    /// only the three fixed labels when drawing a row.
    public static func display(_ state: String, chinese: Bool) -> String {
        guard !chinese else { return state }
        switch state {
        case unchecked: return "Not checked"
        case checking: return "Checking…"
        case connected: return "Connected"
        default: return state
        }
    }

    /// The message for a check that did not come back with the desktop's status.
    ///
    /// Two kinds of failure reach here and they are explained by different
    /// things, exactly as Android splits them: an HTTP status the desktop
    /// returned explains itself, and anything else is whatever the tunnel or the
    /// local node raised, which the bridge names with a `CAMELLIA_` code.
    /// `message` is the error's own text and `online` is the local node's state,
    /// because a failure while the network is down is a network failure first.
    public static func failure(status: Int?, detail: String, message: String?, online: Bool,
                               chinese: Bool = true) -> String {
        if let status {
            return RemoteFailure.httpMessage(status: status, detail: detail, chinese: chinese)
        }
        let code = ConnectionFailureCode.classify(message: message, online: online)
        return code.text(chinese: chinese)
    }
}
