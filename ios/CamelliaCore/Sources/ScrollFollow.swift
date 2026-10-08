import CoreGraphics

/// Whether a streaming reply should be followed to the bottom of a scroll view.
///
/// Ported from the Android client, which decides this per update with
/// `content.getHeight() - scroll.getScrollY() - scroll.getHeight() < dp(120)`:
/// output is followed only while the reader is already at the end, so scrolling
/// up to read is not undone chunk by chunk. iOS 15 has no scroll-offset API to
/// ask the same question (`scrollPosition` is iOS 17, `onScrollGeometryChange`
/// is iOS 18), so the view layer feeds this the two edges measured with
/// `GeometryReader` probes and the comparison happens here, where it can be
/// tested without Xcode.
public enum ScrollFollow {
    /// How close to the bottom still counts as following. Matches Android's
    /// `dp(120)`.
    public static let threshold: CGFloat = 120
}

/// Tracks whether a scroll view is within `ScrollFollow.threshold` of its end.
///
/// A plain box rather than `@State`: the two edges change on every scroll
/// frame, and publishing them would re-render the whole list just as often. The
/// derived boolean is what a caller reads, and it is only recomputed, never
/// published, so a scroll frame costs a comparison and nothing else.
///
/// Only ever touched from the main thread — the geometry probes and the
/// `.onChange` handlers that drive it all run there.
public final class ScrollFollowTracker: @unchecked Sendable {
    private var viewportBottom: CGFloat = .nan
    private var contentBottom: CGFloat = .nan

    /// Whether the last measurement put the content within the threshold of the
    /// end. Starts true so the first render — and the first load — follows.
    public private(set) var isAtBottom = true

    public init() {}

    /// Records the viewport's bottom edge (global coordinates).
    public func updateViewport(_ bottom: CGFloat) {
        viewportBottom = bottom
        recompute()
    }

    /// Records the content's bottom edge (global coordinates).
    public func updateContent(_ bottom: CGFloat) {
        contentBottom = bottom
        recompute()
    }

    /// Records a deliberate move to the end, so the next growth keeps following
    /// even before the next measurement lands.
    public func following() {
        isAtBottom = true
    }

    private func recompute() {
        // One edge on its own says nothing; the first measurement that is
        // missing keeps the previous answer rather than guessing.
        guard !viewportBottom.isNaN, !contentBottom.isNaN else { return }
        // Positive means the content's end sits below the viewport's end — i.e.
        // the reader has scrolled that far up from the bottom. At the very end
        // the two edges coincide and the value is zero.
        let scrolledUp = contentBottom - viewportBottom
        isAtBottom = scrolledUp < ScrollFollow.threshold
    }
}
