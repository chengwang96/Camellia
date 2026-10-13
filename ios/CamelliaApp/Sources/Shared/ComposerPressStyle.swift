import SwiftUI

/// Model controls are clear at rest, with only the APK's brief pressed tint.
struct ComposerPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .overlay(Self.feedback(isPressed: configuration.isPressed))
            .animation(reduceMotion ? nil : .easeOut(duration: configuration.isPressed ? 0.1 : 0.15),
                       value: configuration.isPressed)
    }

    static func feedback(isPressed: Bool) -> some View {
        RoundedRectangle(cornerRadius: Palette.capsuleRadius)
            .fill(Color(red: 65.0/255, green: 118.0/255, blue: 230.0/255)
                .opacity(isPressed ? 34.0/255 : 0))
            .allowsHitTesting(false)
    }
}
