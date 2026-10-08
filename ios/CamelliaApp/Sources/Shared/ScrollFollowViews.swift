import SwiftUI

/// The SwiftUI half of `ScrollFollowTracker`, which lives in `CamelliaCore` so
/// the rule itself can be checked without Xcode.
///
/// A `ScrollView` cannot report its scroll offset on iOS 15, so both edges are
/// read with `GeometryReader` probes instead: one on the `ScrollView` (whose
/// frame is the viewport) and one on the content. Each reports its bottom edge
/// in global coordinates, and the tracker's difference between them is exactly
/// the distance the reader has scrolled up from the end — the value Android
/// compares to 120 dp.

/// The viewport's bottom edge, in global coordinates.
struct ScrollViewportBottomKey: PreferenceKey {
    static var defaultValue: CGFloat = .nan
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        let next = nextValue()
        if !next.isNaN { value = next }
    }
}

/// The content's bottom edge, in global coordinates.
struct ScrollContentBottomKey: PreferenceKey {
    static var defaultValue: CGFloat = .nan
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        let next = nextValue()
        if !next.isNaN { value = next }
    }
}

extension View {
    /// Probes this view's bottom edge as the scroll viewport.
    func measuringViewportBottom() -> some View {
        background(GeometryReader { geo in
            Color.clear.preference(key: ScrollViewportBottomKey.self,
                                   value: geo.frame(in: .global).maxY)
        })
    }

    /// Probes this view's bottom edge as the end of the scroll content.
    func measuringContentBottom() -> some View {
        background(GeometryReader { geo in
            Color.clear.preference(key: ScrollContentBottomKey.self,
                                   value: geo.frame(in: .global).maxY)
        })
    }

    /// Feeds both probes into `tracker`.
    ///
    /// The two `PreferenceKey`s are emitted by probes inside this subtree, so
    /// the observation has to sit on a common ancestor of the scroll view and
    /// its content. Preferences are read only to update the tracker's own box:
    /// nothing here is `@State`, so a scroll frame does not re-render the list.
    func trackingScrollFollow(_ tracker: ScrollFollowTracker) -> some View {
        self
            .onPreferenceChange(ScrollViewportBottomKey.self) { tracker.updateViewport($0) }
            .onPreferenceChange(ScrollContentBottomKey.self) { tracker.updateContent($0) }
    }
}
