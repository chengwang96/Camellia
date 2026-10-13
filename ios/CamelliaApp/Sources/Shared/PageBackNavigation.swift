import SwiftUI
import UIKit

/// Custom root pages own their state transition. Pushed pages keep UIKit's
/// interactivePopGestureRecognizer, including its native cancel behaviour.
protocol PageBackContainer: AnyObject {
    var backHost: UIViewController? { get }
    var backAvailable: Bool { get }
    func performBack(_ action: @escaping () -> Void)
    func beginBack(_ action: @escaping () -> Void) -> Bool
    func updateBack(_ progress: CGFloat)
    func endBack(finish: Bool)
}

extension PageBackContainer {
    func owns(_ controller: UIViewController) -> Bool {
        var node: UIViewController? = controller
        while let current = node {
            if current === backHost { return true }
            node = current.parent
        }
        return false
    }
}

final class PageBackContainerReference {
    weak var container: PageBackContainer?
    init(_ container: PageBackContainer) { self.container = container }
}

private struct PageBackContainerKey: EnvironmentKey {
    static let defaultValue: PageBackContainerReference? = nil
}

extension EnvironmentValues {
    var pageBackContainer: PageBackContainerReference? {
        get { self[PageBackContainerKey.self] }
        set { self[PageBackContainerKey.self] = newValue }
    }
}

final class PageBackAction: ObservableObject {
    fileprivate weak var anchor: PageBackAnchor?
    func perform(_ action: @escaping () -> Void) {
        if let anchor { anchor.perform(action) }
        else { action() }
    }
}

struct PageBackSupport: UIViewControllerRepresentable {
    let action: PageBackAction
    let enabled: Bool
    let onBack: () -> Void
    @Environment(\.pageBackContainer) private var container

    func makeUIViewController(context: Context) -> PageBackAnchor { PageBackAnchor() }

    func updateUIViewController(_ controller: PageBackAnchor, context: Context) {
        action.anchor = controller
        controller.container = container?.container
        controller.enabled = enabled
        controller.onBack = onBack
        controller.configure()
    }

    static func dismantleUIViewController(_ controller: PageBackAnchor, coordinator: ()) {
        controller.detach()
    }
}

final class PageBackAnchor: UIViewController, UIGestureRecognizerDelegate {
    weak var container: PageBackContainer?
    var enabled = true
    var onBack: () -> Void = {}
    private weak var edgeHost: UIView?
    private weak var nativePop: UIGestureRecognizer?
    private weak var previousDelegate: UIGestureRecognizerDelegate?
    private lazy var edge: UIScreenEdgePanGestureRecognizer = {
        let gesture = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(pan(_:)))
        gesture.edges = .left
        gesture.delegate = self
        return gesture
    }()

    override func loadView() {
        view = UIView()
        view.isUserInteractionEnabled = false
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        configure()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // SwiftUI can update hidden navigation chrome after appearance. The
        // displayed header must re-enable its native pop at the settled layout.
        configure()
    }

    private var navigation: UINavigationController? {
        var node: UIViewController? = parent
        while let current = node {
            if let navigation = current as? UINavigationController { return navigation }
            if let navigation = current.navigationController { return navigation }
            node = current.parent
        }
        return nil
    }

    private func isCurrent(_ navigation: UINavigationController) -> Bool {
        var node: UIViewController? = self
        while let current = node {
            if current === navigation.topViewController { return true }
            node = current.parent
        }
        return false
    }

    func configure() {
        guard isViewLoaded, view.window != nil else { return }
        let navigation = navigation
        if let pop = navigation?.interactivePopGestureRecognizer,
           pop.state == .began || pop.state == .changed { return }
        if let navigation, isCurrent(navigation), let pop = navigation.interactivePopGestureRecognizer {
            if pop.delegate !== self {
                nativePop = pop
                previousDelegate = pop.delegate
                pop.delegate = self
            }
            let allowed = enabled && navigation.viewControllers.count > 1
            if pop.isEnabled != allowed { pop.isEnabled = allowed }
        }
        let root = container?.owns(self) == true && (navigation?.viewControllers.count ?? 1) == 1
        let host = root ? container?.backHost?.view : nil
        if edgeHost !== host {
            edgeHost?.removeGestureRecognizer(edge)
            host?.addGestureRecognizer(edge)
            edgeHost = host
        }
        // Availability changes when a page slide settles, without necessarily
        // causing another SwiftUI update. Keep the recognizer installed; its
        // shouldBegin delegate checks current availability at gesture time.
        let allowed = enabled && root
        if edge.isEnabled != allowed { edge.isEnabled = allowed }
    }

    func detach() {
        edgeHost?.removeGestureRecognizer(edge)
        if nativePop?.delegate === self { nativePop?.delegate = previousDelegate }
    }

    func perform(_ action: @escaping () -> Void) {
        guard enabled else { return }
        if let navigation, isCurrent(navigation), navigation.viewControllers.count > 1 {
            // UIKit owns the push, and updates NavigationLink's binding when
            // it pops. Do not dismiss a modal parent or depend on a stale
            // presentationMode captured by a nested settings modifier.
            guard navigation.transitionCoordinator == nil else { return }
            navigation.popViewController(animated: true)
        } else if let container, container.owns(self) {
            container.performBack(action)
        } else {
            action()
        }
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard enabled else { return false }
        if gestureRecognizer === nativePop {
            guard let navigation else { return false }
            return isCurrent(navigation) && navigation.viewControllers.count > 1
                && navigation.transitionCoordinator == nil && navigation.presentedViewController == nil
        }
        let velocity = edge.velocity(in: edgeHost)
        return container?.backAvailable == true && container?.owns(self) == true
            && (navigation?.viewControllers.count ?? 1) == 1
            && container?.backHost?.presentedViewController == nil
            // UIKit can ask at the edge before velocity is available. The
            // screen-edge recognizer already restricts the starting location.
            && velocity.x >= abs(velocity.y)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        // SwiftUI also combines page DragGestures into hosting recognizers,
        // including on the wrapper outside the navigation view. Prioritising
        // only UIScrollView.panGestureRecognizer leaves those free to win.
        // Use the current page hierarchy, not private framework class names.
        guard enabled, gestureRecognizer.isEnabled,
              gestureRecognizer === edge || gestureRecognizer === nativePop,
              let host = gestureRecognizer.view, let other = otherGestureRecognizer.view,
              !(other is UIWindow),
              !(otherGestureRecognizer is UITapGestureRecognizer),
              !(otherGestureRecognizer is UILongPressGestureRecognizer),
              !(otherGestureRecognizer is UIHoverGestureRecognizer),
              !(otherGestureRecognizer is UIScreenEdgePanGestureRecognizer) else { return false }
        return other.isDescendant(of: host) || host.isDescendant(of: other)
    }

    @objc private func pan(_ gesture: UIScreenEdgePanGestureRecognizer) {
        guard let container, let host = edgeHost else { return }
        let translation = gesture.translation(in: host).x
        switch gesture.state {
        case .began:
            _ = container.beginBack(onBack)
        case .changed:
            container.updateBack(CGFloat(PageBackGesture.progress(translation: Double(translation), width: Double(host.bounds.width))))
        case .ended:
            container.endBack(finish: PageBackGesture.shouldFinish(translation: Double(translation),
                width: Double(host.bounds.width), velocity: Double(gesture.velocity(in: host).x)))
        case .cancelled, .failed:
            container.endBack(finish: false)
        default: break
        }
    }
}
