import SwiftUI
import UIKit

/// The geometry `MainActivity.shell()` gives every chat page.
///
/// `shell()` builds the root with `dp(22)` of side padding and then replaces it
/// from an insets listener with `dp(18) + insets`, and `requestApplyInsets()`
/// runs before the page is drawn — so 18, not 22, is what a phone in portrait
/// actually shows. It matters that this is the *root*: the scrolling content and
/// the dock `bottomBar()` swaps in at the bottom are both children of it, so the
/// gutter applies to the composer and the search field as much as to the rows.
enum PageGutter {
    /// `root.setPadding(dp(18) + insets…)` on a portrait phone.
    static let horizontal: CGFloat = 18
    /// `content.setPadding(0, 0, 0, dp(16))`.
    static let contentBottom: CGFloat = 16
    /// `dockBottomPadding()`: the root's own bottom padding on list and detail.
    static let dockBottom: CGFloat = 8
}

/// One row of a chat-page list, laid out the way Android's column is.
///
/// A `List` brings its own row insets, its own separators and — under the
/// grouped style — a second surface to draw them on. Android's chat pages have
/// none of the three: rows sit directly on the page colour with the padding the
/// row itself carries, and what looks like a card is the row's own rounded
/// background, which is the page colour again. These four modifiers take the
/// `List` back out of the way so the row geometry is the thing that decides.
extension View {
    func plainPageRow(_ insets: EdgeInsets = EdgeInsets()) -> some View {
        listRowInsets(insets)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
    }

    @ViewBuilder
    func plainPageBackground() -> some View {
        if #available(iOS 16.0, *) {
            scrollContentBackground(.hidden)
        } else {
            background(TableBackgroundClearer())
        }
    }
}

/// Makes the table a `List` is drawn on see-through.
///
/// `List` paints `systemBackground` behind its rows. In the light appearance
/// that is the same white the page wants, which is why this was not noticed
/// earlier; in the dark one it is black where Android's page is `#151517`, and
/// there is no modifier for it until iOS 16's `scrollContentBackground`. The
/// appearance proxy is the other obvious way and it is global — the settings
/// pages are `Form`s whose grey *is* their background, and clearing every table
/// would take that away.
///
/// Used only on iOS 15. Cache the table weakly after the first lookup; layout
/// refreshes only its colour. Reparenting/window changes invalidate the cache.
struct TableBackgroundClearer: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView { Probe() }
    func updateUIView(_ view: UIView, context: Context) { (view as? Probe)?.refresh() }

    private final class Probe: UIView {
        private weak var cachedTable: UITableView?

        override func didMoveToSuperview() {
            super.didMoveToSuperview()
            cachedTable = nil
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            cachedTable = nil
            if window != nil { refresh() }
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            refresh()
        }

        func refresh() {
            if let table = cachedTable, table.window === window {
                if table.backgroundColor != .clear { table.backgroundColor = .clear }
                return
            }
            var node: UIView? = self
            var steps = 0
            while let current = node, steps < 12 {
                if let table = Self.table(in: current) {
                    cachedTable = table
                    if table.backgroundColor != .clear { table.backgroundColor = .clear }
                    return
                }
                node = current.superview
                steps += 1
            }
        }

        private static func table(in view: UIView) -> UITableView? {
            if let table = view as? UITableView { return table }
            for child in view.subviews {
                if let found = table(in: child) { return found }
            }
            return nil
        }
    }
}
