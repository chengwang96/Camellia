import SwiftUI
import UIKit

/// Android's PageTransitions: 320 ms, a full-width incoming page and a
/// 30-percent parallax retreat. Popup reveals share the model picker's 180 ms timing.
enum PageMotion {
    static let duration: TimeInterval = 0.32
    static let popupAnimation = Animation.easeOut(duration: 0.18)
    static let popup = AnyTransition.opacity.combined(with: .offset(y: 8))
}

extension View {
    func popupMotion<Value: Equatable>(value: Value) -> some View {
        modifier(PopupMotion(value: value))
    }

    func popupReveal() -> some View { modifier(PopupReveal()) }

    /// Page navigation is horizontal on both device families. A child page
    /// can retain its presenting view when its result updates that parent's
    /// state; native Photos / Files / camera pickers keep system presentation.
    func pageCover<Content: View>(isPresented: Binding<Bool>,
                                 keepsPresentingView: Bool = false,
                                 onDismiss: (() -> Void)? = nil,
                                 @ViewBuilder content: @escaping () -> Content) -> some View {
        background(PageCoverPresenter(isPresented: isPresented,
                                      keepsPresentingView: keepsPresentingView, onDismiss: onDismiss,
                                      content: content()).frame(width: 0, height: 0))
    }
}

private struct PageColorSchemeKey: EnvironmentKey {
    static let defaultValue: ColorScheme? = nil
}

extension EnvironmentValues {
    /// Forward the preference, not the presenter's effective trait. A cover's
    /// old trait must not prevent a newly selected appearance from reaching it.
    var pagePreferredColorScheme: ColorScheme? {
        get { self[PageColorSchemeKey.self] }
        set { self[PageColorSchemeKey.self] = newValue }
    }
}

private struct PopupMotion<Value: Equatable>: ViewModifier {
    let value: Value
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content.animation(reduceMotion ? nil : PageMotion.popupAnimation, value: value)
    }
}

private struct PopupReveal: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content.transition(reduceMotion ? .identity : PageMotion.popup)
    }
}

private struct PageCoverPresenter<Content: View>: UIViewControllerRepresentable {
    @Binding var isPresented: Bool
    let keepsPresentingView: Bool
    let onDismiss: (() -> Void)?
    let content: Content
    @Environment(\.locale) private var locale
    @Environment(\.pagePreferredColorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase

    func makeUIViewController(context: Context) -> PageCoverAnchor<AnyView> {
        PageCoverAnchor()
    }

    func updateUIViewController(_ controller: PageCoverAnchor<AnyView>, context: Context) {
        controller.requested = isPresented
        controller.keepsPresentingView = keepsPresentingView
        controller.content = AnyView(content.environment(\.locale, locale)
            .environment(\.scenePhase, scenePhase)
            .environment(\.pagePreferredColorScheme, colorScheme)
            .environment(\.pageBackContainer, PageBackContainerReference(controller)))
        let binding = $isPresented
        controller.requestDismiss = { binding.wrappedValue = false }
        controller.colorScheme = colorScheme
        controller.onDismiss = onDismiss
        controller.reconcile()
    }

    static func dismantleUIViewController(_ controller: PageCoverAnchor<AnyView>, coordinator: ()) {
        controller.onDismiss = nil
        controller.requestDismiss = nil
        controller.requested = false
        controller.presentedPage?.dismiss(animated: false)
    }
}

private final class PageCoverAnchor<Content: View>: UIViewController, UIViewControllerTransitioningDelegate, PageBackContainer {
    var requested = false
    var keepsPresentingView = false
    var content: Content!
    var colorScheme: ColorScheme?
    var onDismiss: (() -> Void)?
    var requestDismiss: (() -> Void)?
    private(set) var presentedPage: UIHostingController<Content>?
    private enum Phase { case idle, presenting, presented, dismissing }
    private var phase = Phase.idle
    private var interaction: UIPercentDrivenInteractiveTransition?
    private var gestureAction: (() -> Void)?
    var backHost: UIViewController? { presentedPage }
    var backAvailable: Bool { phase == .presented && presentedPage?.presentedViewController == nil }
    private var interfaceStyle: UIUserInterfaceStyle {
        colorScheme.map { $0 == .dark ? .dark : .light } ?? .unspecified
    }

    override func loadView() {
        view = UIView()
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        reconcile()
    }

    func reconcile() {
        if let page = presentedPage {
            page.rootView = content
            page.overrideUserInterfaceStyle = interfaceStyle
        }
        switch phase {
        case .idle:
            guard requested, viewIfLoaded?.window != nil else { return }
            var owner: UIViewController = self
            while let parent = owner.parent { owner = parent }
            guard owner.presentedViewController == nil else { return }
            let page = UIHostingController(rootView: content!)
            page.view.backgroundColor = .clear
            page.overrideUserInterfaceStyle = interfaceStyle
            page.modalPresentationStyle = keepsPresentingView ? .overFullScreen : .fullScreen
            page.transitioningDelegate = self
            presentedPage = page
            phase = .presenting
            owner.present(page, animated: !UIAccessibility.isReduceMotionEnabled) { [weak self] in
                guard let self else { return }
                self.phase = .presented
                self.reconcile()
            }
        case .presented:
            guard !requested, let page = presentedPage else { return }
            phase = .dismissing
            page.dismiss(animated: !UIAccessibility.isReduceMotionEnabled) { [weak self] in
                guard let self else { return }
                self.presentedPage = nil
                self.phase = .idle
                self.onDismiss?()
                self.reconcile()
            }
        case .presenting, .dismissing:
            // Rapid open/back requests settle after the current UIKit transition;
            // they never present another copy or dismiss an unrelated controller.
            break
        }
    }

    func animationController(forPresented presented: UIViewController,
                             presenting: UIViewController,
                             source: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        PageSlideAnimator(back: false, keepsPresentingView: keepsPresentingView)
    }

    func animationController(forDismissed dismissed: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        PageSlideAnimator(back: true, keepsPresentingView: keepsPresentingView,
                          onCompletion: { [weak self] completed in self?.completeBack(completed) })
    }

    func interactionControllerForDismissal(using animator: UIViewControllerAnimatedTransitioning) -> UIViewControllerInteractiveTransitioning? {
        interaction
    }

    func performBack(_ action: @escaping () -> Void) {
        action()
        requested = false
        requestDismiss?()
        reconcile()
    }

    func beginBack(_ action: @escaping () -> Void) -> Bool {
        guard backAvailable, let page = presentedPage else { return false }
        page.view.endEditing(true)
        let driver = UIPercentDrivenInteractiveTransition()
        driver.completionCurve = .easeOut
        interaction = driver
        gestureAction = action
        phase = .dismissing
        page.dismiss(animated: true)
        return true
    }

    private func completeBack(_ completed: Bool) {
        // Animator completion also runs on cancellation; UIKit's dismiss
        // completion alone must not leave a cancelled page in .dismissing.
        guard interaction != nil else { return }
        interaction = nil
        let action = gestureAction
        gestureAction = nil
        if completed {
            presentedPage = nil
            phase = .idle
            requested = false
            requestDismiss?()
            action?()
            onDismiss?()
        } else {
            phase = .presented
        }
        reconcile()
    }

    func updateBack(_ progress: CGFloat) { interaction?.update(progress) }
    func endBack(finish: Bool) {
        if finish { interaction?.finish() }
        else { interaction?.cancel() }
    }
}

private final class PageSlideAnimator: NSObject, UIViewControllerAnimatedTransitioning {
    private let back: Bool
    private let keepsPresentingView: Bool
    private let onCompletion: (Bool) -> Void
    private var runningAnimator: UIViewPropertyAnimator?
    init(back: Bool, keepsPresentingView: Bool, onCompletion: @escaping (Bool) -> Void = { _ in }) {
        self.back = back
        self.keepsPresentingView = keepsPresentingView
        self.onCompletion = onCompletion
    }

    func transitionDuration(using transitionContext: UIViewControllerContextTransitioning?) -> TimeInterval {
        UIAccessibility.isReduceMotionEnabled ? 0 : PageMotion.duration
    }

    func animateTransition(using context: UIViewControllerContextTransitioning) {
        interruptibleAnimator(using: context).startAnimation()
    }

    func interruptibleAnimator(using context: UIViewControllerContextTransitioning) -> UIViewImplicitlyAnimating {
        if let runningAnimator { return runningAnimator }
        // Over-full-screen keeps the presenting view in its original hierarchy;
        // UIKit may omit it from the transition's view lookup in that mode.
        guard let incoming = context.view(forKey: .to) ?? context.viewController(forKey: .to)?.view,
              let outgoing = context.view(forKey: .from) ?? context.viewController(forKey: .from)?.view,
              let controller = context.viewController(forKey: .to) else {
            context.completeTransition(false)
            return UIViewPropertyAnimator(duration: 0, curve: .linear)
        }
        let container = context.containerView
        if !back || !keepsPresentingView { incoming.frame = context.finalFrame(for: controller) }
        if back {
            // The retained parent must stay in its original hierarchy. Moving
            // it into a temporary modal container would remove it on dismissal.
            if !keepsPresentingView { container.insertSubview(incoming, belowSubview: outgoing) }
        }
        else { container.addSubview(incoming) }
        incoming.layoutIfNeeded()
        let width = container.bounds.width
        incoming.transform = CGAffineTransform(translationX: back ? -width * 0.3 : width, y: 0)
        let timing = UICubicTimingParameters(controlPoint1: CGPoint(x: 0.22, y: 0),
                                            controlPoint2: CGPoint(x: 0.2, y: 1))
        let animator = UIViewPropertyAnimator(duration: transitionDuration(using: context),
                                              timingParameters: timing)
        animator.addAnimations {
            incoming.transform = .identity
            outgoing.transform = CGAffineTransform(translationX: self.back ? width : -width * 0.3, y: 0)
        }
        animator.addCompletion { _ in
            incoming.transform = .identity
            outgoing.transform = .identity
            if context.transitionWasCancelled && (!self.back || !self.keepsPresentingView) {
                incoming.removeFromSuperview()
            }
            context.completeTransition(!context.transitionWasCancelled)
            self.runningAnimator = nil
            self.onCompletion(!context.transitionWasCancelled)
        }
        runningAnimator = animator
        return animator
    }
}
