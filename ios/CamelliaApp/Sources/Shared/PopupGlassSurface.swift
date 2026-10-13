import SwiftUI

/// Native glass on iOS 26, with the Android-matched frost on older systems.
/// Power saving and reduced transparency always use an opaque card instead.
struct PopupGlassSurface: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var powerSaving = ProcessInfo.processInfo.isLowPowerModeEnabled

    var body: some View {
        Group {
            if powerSaving || reduceTransparency {
                shape.fill(Palette.card)
                    .overlay(outline)
            } else {
                translucentSurface
            }
        }
            .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)) { _ in
                powerSaving = ProcessInfo.processInfo.isLowPowerModeEnabled
            }
    }

    @ViewBuilder private var translucentSurface: some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            Color.clear.glassEffect(.regular, in: shape)
        } else {
            frostedSurface
        }
        #else
        frostedSurface
        #endif
    }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: Palette.groupRadius, style: .continuous)
    }

    private var outline: some View {
        shape.stroke(colorScheme == .dark ? Color.white.opacity(0.09) : Color.black.opacity(0.10),
                     lineWidth: 1)
    }

    private var frostedSurface: some View {
        shape.fill(.ultraThinMaterial)
            .overlay(shape.fill(LinearGradient(
                colors: colorScheme == .dark
                    ? [Color.black.opacity(0.40), Color.black.opacity(0.50)]
                    : [Color(red: 230.0/255, green: 234.0/255, blue: 239.0/255).opacity(0.16),
                       Color(red: 221.0/255, green: 225.0/255, blue: 231.0/255).opacity(0.32)],
                startPoint: .top, endPoint: .bottom)))
            .overlay(outline)
    }
}
