import Foundation

/// Decides whether a finished goal is still worth showing.
///
/// Ported from `RemoteGoalVisibility.java`, and the rule is subtler than it
/// looks. The desktop keeps a goal's `complete` phase in the snapshot forever,
/// so a card driven by `phase == "complete"` would sit above the composer of
/// a conversation whose goal finished weeks ago and whose user has long since
/// moved on. This type watches the *transition* instead:
///
/// - a goal that is not complete is always shown, and its completion is
///   remembered as the moment to measure against;
/// - a goal that turns complete is shown until the user says something newer
///   than the completion, at which point it is dismissed for good;
/// - a desktop that does not date completions only gets the notice if this
///   session saw the goal unfinished, so an old saved completion cannot
///   reappear every time the conversation is opened.
///
/// Stateful on purpose: "was it complete last time I looked" is not derivable
/// from one snapshot.
public struct RemoteGoalVisibility: Sendable {
    private var goalKey = ""
    private var previousPhase = ""
    private var completionUserSeq: Int64 = 0
    private var dismissed = false

    public init() {}

    public mutating func reset() {
        goalKey = ""
        previousPhase = ""
        completionUserSeq = 0
        dismissed = false
    }

    /// Whether to draw the goal card, given the snapshot's goal fields and the
    /// newest user turn the phone knows about.
    public mutating func show(key: String, phase: String, completedAt: Int64,
                              latestUserSeq: Int64, latestUserAt: Int64) -> Bool {
        if phase.isEmpty {
            reset()
            return false
        }
        if goalKey != key {
            reset()
            goalKey = key
        }
        if phase != "complete" {
            previousPhase = phase
            dismissed = false
            return true
        }
        if previousPhase != "complete" {
            completionUserSeq = latestUserSeq
            // Older desktops do not date completions. Only show one if we
            // observed that goal unfinished here; an old saved completion must
            // not reappear each time the conversation is opened.
            dismissed = completedAt <= 0 && previousPhase.isEmpty
        }
        previousPhase = phase
        dismissed = dismissed || (completedAt > 0 ? latestUserAt > completedAt
                                                  : latestUserSeq > completionUserSeq)
        return !dismissed
    }
}
