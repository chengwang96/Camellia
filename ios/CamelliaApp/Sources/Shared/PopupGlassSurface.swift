import SwiftUI

/// The translucent, lightly tinted surface shared by Android's model popups.
/// Material samples the page underneath while the wash keeps text legible.
struct PopupGlassSurface: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let dark = colorScheme == .dark
        let shape = RoundedRectangle(cornerRadius: Palette.groupRadius, style: .continuous)
        shape
            .fill(.ultraThinMaterial)
            .overlay(shape.fill(LinearGradient(
                colors: dark
                    ? [Color.black.opacity(0.40), Color.black.opacity(0.50)]
                    : [Color(red: 230.0/255, green: 234.0/255, blue: 239.0/255).opacity(0.40),
                       Color(red: 221.0/255, green: 225.0/255, blue: 231.0/255).opacity(0.50)],
                startPoint: .top, endPoint: .bottom)))
            .overlay(shape.stroke(dark ? Color.white.opacity(0.09) : Color.black.opacity(0.10),
                                  lineWidth: 1))
    }
}
