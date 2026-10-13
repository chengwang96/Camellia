import SwiftUI
import UIKit

/// Android's PageTransitions: lay out the new page, then move its entire
/// surface and a snapshot of the old page on one clock. The hosting view stays
/// at its final layout position; only its parent layer's presentation moves.
/// List reloads and safe-area inserts therefore cannot restart part of a slide.
struct PageStack<Route: Equatable, Content: View>: UIViewControllerRepresentable {
    let route: Route
    let depth: Int
    let onBack: (() -> Void)?
    private let content: Content
    @Environment(\.locale) private var locale
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.pagePreferredColorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(route: Route, depth: Int, onBack: (() -> Void)? = nil, @ViewBuilder content: () -> Content) {
        self.route = route
        self.depth = depth
        self.onBack = onBack
        self.content = content()
    }

    func makeUIViewController(context: Context) -> PageStackController<Route> {
        PageStackController()
    }

    func updateUIViewController(_ controller: PageStackController<Route>, context: Context) {
        controller.backAction = onBack
        let page = AnyView(content.environment(\.locale, locale)
            .environment(\.scenePhase, scenePhase)
            .environment(\.pagePreferredColorScheme, colorScheme))
        controller.show(page, route: route, depth: depth,
                        animated: !reduceMotion && scenePhase == .active,
                        colorScheme: colorScheme)
    }

    static func dismantleUIViewController(_ controller: PageStackController<Route>, coordinator: ()) {
        controller.finishTransition()
    }
}

final class PageStackController<Route: Equatable>: UIViewController, PageBackContainer {
    private let surface = UIView()
    private var host: UIHostingController<AnyView>?
    private var route: Route?
    private var depth = 0
    private var outgoing: UIView?
    private var pendingBack: Bool?
    private var transitionSize: CGSize?
    var backAction: (() -> Void)?
    private var backSnapshots: [Int: UIView] = [:]
    private var backPreview: UIView?
    private var backProgress: CGFloat = 0
    private var gestureAction: (() -> Void)?
    private var gestureCommitted = false
    var backHost: UIViewController? { host }
    var backAvailable: Bool {
        depth > 0 && backAction != nil && backSnapshots[depth - 1] != nil
            && outgoing == nil && backPreview == nil
    }
    private static var slideKey: String { "camellia.page.slide" }

    override func loadView() {
        view = UIView()
        view.backgroundColor = .clear
        view.clipsToBounds = true
        surface.backgroundColor = .clear
        surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(surface)
    }

    func show(_ content: AnyView, route: Route, depth: Int,
              animated: Bool, colorScheme: ColorScheme?) {
        loadViewIfNeeded()
        let content = AnyView(content.environment(\.pageBackContainer, PageBackContainerReference(self)))
        let style = colorScheme.map { $0 == .dark ? UIUserInterfaceStyle.dark : .light } ?? .unspecified
        if self.route == route, let host {
            host.rootView = content
            host.overrideUserInterfaceStyle = style
            if !animated { finishTransition() }
            return
        }

        let animated = animated && !gestureCommitted
        gestureCommitted = false
        if host != nil, depth > self.depth, let snapshot = surface.snapshotView(afterScreenUpdates: false) {
            backSnapshots[self.depth] = snapshot
        }
        if depth < self.depth { backSnapshots = backSnapshots.filter { $0.key < depth } }
        // Android settles an interrupted slide before replacing its page.
        finishTransition()
        let back = depth < self.depth
        let snapshot = animated && host != nil && view.window != nil && !view.bounds.isEmpty
            ? surface.snapshotView(afterScreenUpdates: false) : nil
        if let previous = host {
            previous.willMove(toParent: nil)
            previous.view.removeFromSuperview()
            previous.removeFromParent()
        }
        let next = UIHostingController(rootView: content)
        next.overrideUserInterfaceStyle = style
        next.view.backgroundColor = .clear
        addChild(next)
        surface.bounds = CGRect(origin: .zero, size: view.bounds.size)
        surface.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        next.view.frame = surface.bounds
        next.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        surface.addSubview(next.view)
        next.didMove(toParent: self)
        host = next
        self.route = route
        self.depth = depth

        if let snapshot {
            snapshot.frame = view.bounds
            snapshot.isUserInteractionEnabled = false
            snapshot.accessibilityElementsHidden = true
            if back { view.addSubview(snapshot) }
            else { view.insertSubview(snapshot, belowSubview: surface) }
            outgoing = snapshot
            transitionSize = view.bounds.size
            pendingBack = back
            // The rendered incoming layer is initially off-screen, without
            // changing UIKit's safe-area or the child's layout coordinates.
            view.isUserInteractionEnabled = false
        }
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // A drag changes transform, not layout. Setting frame while transformed
        // would counteract the finger whenever a SwiftUI refresh lays out.
        surface.bounds = CGRect(origin: .zero, size: view.bounds.size)
        surface.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        if let transitionSize, transitionSize != view.bounds.size {
            // A rotation/resizing settles on the requested page, never a
            // half-screen snapshot with the old device width.
            finishTransition()
            return
        }
        guard let back = pendingBack, let outgoing else { return }
        pendingBack = nil
        host?.view.layoutIfNeeded()
        let width = view.bounds.width
        let start = CACurrentMediaTime()
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            guard let self, self.outgoing === outgoing else { return }
            self.finishTransition()
        }
        surface.layer.add(slide(from: back ? -width * 0.3 : width, to: 0,
                                start: start, layer: surface.layer), forKey: Self.slideKey)
        outgoing.layer.add(slide(from: 0, to: back ? width : -width * 0.3,
                                 start: start, layer: outgoing.layer), forKey: Self.slideKey)
        CATransaction.commit()
    }

    private func slide(from: CGFloat, to: CGFloat, start: CFTimeInterval, layer: CALayer) -> CABasicAnimation {
        let animation = CABasicAnimation(keyPath: "transform.translation.x")
        animation.fromValue = from
        animation.toValue = to
        animation.beginTime = layer.convertTime(start, from: nil)
        animation.duration = PageMotion.duration
        animation.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 0, 0.2, 1)
        animation.fillMode = .both
        animation.isRemovedOnCompletion = false
        return animation
    }

    func finishTransition() {
        let previous = outgoing
        outgoing = nil
        pendingBack = nil
        transitionSize = nil
        surface.layer.removeAnimation(forKey: Self.slideKey)
        previous?.layer.removeAnimation(forKey: Self.slideKey)
        previous?.removeFromSuperview()
        backPreview?.removeFromSuperview()
        backPreview = nil
        gestureAction = nil
        backProgress = 0
        surface.transform = .identity
        gestureCommitted = false
        viewIfLoaded?.isUserInteractionEnabled = true
    }

    func performBack(_ action: @escaping () -> Void) { action() }

    func beginBack(_ action: @escaping () -> Void) -> Bool {
        guard backAvailable, let preview = backSnapshots[depth - 1] else { return false }
        view.endEditing(true)
        preview.transform = .identity
        preview.frame = view.bounds
        preview.isUserInteractionEnabled = false
        preview.accessibilityElementsHidden = true
        preview.transform = CGAffineTransform(translationX: -view.bounds.width * 0.3, y: 0)
        view.insertSubview(preview, belowSubview: surface)
        backPreview = preview
        gestureAction = action
        transitionSize = view.bounds.size
        backProgress = 0
        return true
    }

    func updateBack(_ progress: CGFloat) {
        guard let preview = backPreview else { return }
        backProgress = progress
        surface.transform = CGAffineTransform(translationX: view.bounds.width * progress, y: 0)
        preview.transform = CGAffineTransform(translationX: -view.bounds.width * 0.3 * (1 - progress), y: 0)
    }

    func endBack(finish: Bool) {
        guard let preview = backPreview else { return }
        let action = gestureAction
        gestureAction = nil
        view.isUserInteractionEnabled = false
        let distance = finish ? 1 - backProgress : backProgress
        UIView.animate(withDuration: UIAccessibility.isReduceMotionEnabled ? 0 : PageMotion.duration * Double(distance),
                       delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
            self.updateBack(finish ? 1 : 0)
        } completion: { _ in
            // A size/scene/route change can settle this container before the
            // release finishes. Its old completion must not navigate again.
            guard self.backPreview === preview else { return }
            if finish {
                // The dragged page has already completed its movement. The
                // route update must not start a second noninteractive slide.
                self.gestureCommitted = true
                action?()
            } else {
                self.finishTransition()
            }
        }
    }
}
