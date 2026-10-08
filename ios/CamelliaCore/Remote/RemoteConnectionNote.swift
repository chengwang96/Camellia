import Foundation

/// What the 12sp label beside the computer's name says for each stream state.
///
/// Ported from Android's `headerConnection`, which is the only place the two
/// clients show a stream's state on the chat page itself. It lives here rather
/// than beside the view that draws it because it is a rule about the protocol
/// state — including which of the two states are worth a word at all, and what
/// the reconnecting one has to say — and this is the layer the protocol checks
/// compile without Xcode.
///
/// Two of the five states produce nothing. `idle` is the state before anyone
/// has asked for a stream, and `connected` is the normal case; Android drops
/// both before the label is drawn, and a label that reads the same in every
/// healthy state is noise rather than information.
public enum RemoteConnectionNote {
    /// The label for `state`, or `""` when the state is not worth one.
    ///
    /// Internal like `RemoteStreamState` itself, which is what the parameter
    /// type has to match: these are compiled into the app as one module, and a
    /// `public` method taking an internal type does not build.
    static func text(for state: RemoteStreamState, chinese: Bool = true) -> String {
        switch state {
        case .idle, .connected:
            return ""
        case .reconnecting(let delay, _):
            // Android counts the retry down rather than only saying that a
            // reconnect is under way. The delay is what the stream is about to
            // sleep for (`backoff.next(after:)`), so it is the number of seconds
            // the person actually has to wait, and it is never zero — a
            // reconnect with no delay would not be a backoff.
            return chinese ? "正在重连（\(Int(delay)) 秒）" : "Reconnecting (\(Int(delay)) s)"
        case .unsupported:
            return chinese ? "定时刷新" : "Periodic refresh"
        case .failed:
            return chinese ? "已断开" : "Disconnected"
        }
    }
}
