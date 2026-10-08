import SwiftUI

struct RootView: View {
    /// Which tab opens first.
    ///
    /// Overridable so a screenshot run can reach all three screens without a
    /// finger: `SIMCTL_CHILD_CAMELLIA_APP_TAB=1 ./ios/run-app.sh`. SwiftUI
    /// builds a tab's content lazily, so a screen that is never selected is
    /// also a screen that never proved it can draw.
    @State private var selection =
        Int(ProcessInfo.processInfo.environment["CAMELLIA_APP_TAB"] ?? "0") ?? 0

    var body: some View {
        TabView(selection: $selection) {
            NetworkSection()
                .tag(0)
                .tabItem { Label("网络", systemImage: "network") }
            GatewaySection()
                .tag(1)
                .tabItem { Label("网关", systemImage: "arrow.left.arrow.right") }
            PairingSection()
                .tag(2)
                .tabItem { Label("配对", systemImage: "qrcode.viewfinder") }
            LogSection()
                .tag(3)
                .tabItem { Label("日志", systemImage: "list.bullet.rectangle") }
        }
    }
}
