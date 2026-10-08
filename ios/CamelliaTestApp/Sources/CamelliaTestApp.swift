import Combine
import SwiftUI
import UIKit

@main
struct CamelliaTestApp: App {
    init() {
        // The node has to be told where to keep its state before anything can
        // start it, and the answer depends on whether this build is signed in a
        // way the Keychain accepts. Assigning the factory here means the probe
        // happens once, at launch, rather than on every node rebuild.
        EmbeddedNetwork.shared.makeStore = { AppStores.nodeStore() }
        // The sign-in presenter is shared with the client, so where its steps
        // are reported is supplied here rather than compiled in.
        LoginPresenter.shared.note = { DiagnosticsLog.shared.note($0, $1 ? .bad : .plain) }
        DiagnosticsLog.shared.note(
            AppStores.nodeStateOnFile
                ? "node state: file fallback, this build has no application-identifier entitlement"
                : "node state: Keychain",
            AppStores.nodeStateOnFile ? .bad : .good)
        DiagnosticsLog.shared.note(
            AppStores.credentialsOnFile
                ? "credentials: file key, this build has no keychain entitlement"
                : "credentials: keychain key",
            AppStores.credentialsOnFile ? .bad : .good)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .onAppear {
                    EmbeddedNetwork.shared.start()
                    DiagnosticsLog.shared.note("diagnostics build launched")
                    // The node is brought up at launch rather than when the
                    // network tab is first opened. The first thing anyone does
                    // with this build is dial the gateway, and that needs a
                    // tunnel; waiting for a screen to be visited would make the
                    // other two tabs look broken on a cold start.
                    Task { _ = await NodeActions.start() }
                }
                // Notifications rather than `scenePhase`, whose `onChange` form
                // is deprecated from iOS 17 and cannot be replaced by the new
                // one while the deployment target is 16.
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
                    EmbeddedNetwork.shared.background()
                }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
                    EmbeddedNetwork.shared.foreground()
                }
        }
    }
}
