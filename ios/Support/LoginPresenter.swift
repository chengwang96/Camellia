import SafariServices
import UIKit

/// Opens the embedded network's sign-in page in a browser the app can watch.
///
/// Plain `UIApplication.open` would send Camellia to the background, and the
/// node only outlives backgrounding for a few minutes — a sign-in that takes
/// longer than that would come back to a torn-down tunnel. An in-app browser
/// keeps the app in the foreground, so the node keeps polling for the result of
/// the sign-in while the page is open.
///
/// `SFSafariViewController` rather than `ASWebAuthenticationSession`, which
/// this used to be. The two are equally in-app and equally out-of-process, so
/// neither lets the app be backgrounded; the difference is the chrome. The
/// authentication session is modelled as something you can only abandon, so its
/// one button reads "取消" even after a successful sign-in — which is exactly
/// how it was reported: "登录成功之后我只能点左上角的取消". A Safari view
/// controller's dismiss button is `dismissButtonStyle`, which is `.done` by
/// default and comes up as "完成" in Chinese, and that is what the end of a
/// sign-in should read as.
///
/// Shared by both apps because both need it for the same reason; the only
/// difference is where progress is reported, which the `note` hook carries.
final class LoginPresenter: NSObject, SFSafariViewControllerDelegate {
    static let shared = LoginPresenter()

    /// Where progress goes. The client leaves it unset and the sign-in stays
    /// silent; the diagnostics build points it at its log tab.
    var note: (String, Bool) -> Void = { _, _ in }

    private weak var presented: SFSafariViewController?

    func present(_ url: URL) {
        // Tapping the button again while the page is up is a no-op: a second
        // presentation would be dropped anyway, and it would leave `presented`
        // pointing at a controller that never appeared.
        if let open = presented, open.presentingViewController != nil { return }
        note("opening the sign-in page", false)

        let controller = SFSafariViewController(url: url)
        controller.delegate = self
        // "完成" / "Done", and deliberately not `cancel` or `close`.
        controller.dismissButtonStyle = .done

        guard let anchor = topmost else {
            note("the sign-in page could not be opened", true)
            return
        }
        presented = controller
        anchor.present(controller, animated: true)
    }

    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        note("sign-in page closed", false)
    }

    /// The view controller to present from, which has to be the topmost one.
    ///
    /// The sign-in sheet is itself presented, so presenting from the window's
    /// root would fail while it is up — and the node raises this while that
    /// sheet is on screen.
    private var topmost: UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        var top = scene?.keyWindow?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }
}
