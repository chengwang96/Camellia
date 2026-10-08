import SwiftUI

/// Fill the available area so an outside tap has a target on every iOS version.
struct PopupDismissArea: View {
    @Environment(\.locale) private var locale
    let dismiss: () -> Void

    var body: some View {
        Color.clear
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
            .ignoresSafeArea()
            .onTapGesture(perform: dismiss)
            .accessibilityLabel(locale.identifier.hasPrefix("zh") ? "关闭菜单" : "Close menu")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction(.escape, dismiss)
    }
}
