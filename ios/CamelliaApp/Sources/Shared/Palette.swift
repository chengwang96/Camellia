import SwiftUI
import UIKit

/// Desktop-aligned tokens, resolved per appearance for both native clients.
/// Settings and chat retain semantic names; popup and sheet geometry remains
/// touch-sized instead of borrowing desktop control dimensions.
enum Palette {
    static let background = dynamic(light: 0xFFFFFF, dark: 0x151517)
    static let surface = dynamic(light: 0xF5F6F7, dark: 0x232324)
    /// A neutral page under outlined settings cards.
    static let grouped = background
    static let raised = surface
    static let ink = dynamic(light: 0x0F1115, dark: 0xF9FAFB)
    static let muted = dynamic(light: 0x61666B, dark: 0xCFD3D6)
    /// Tertiary labels and placeholders have distinct contrast.
    static let faint = dynamic(light: 0x81858C, dark: 0xADB2B8)
    static let caption = dynamic(light: 0xADB2B8, dark: 0x81858C)
    static let userBubble = dynamic(light: 0xEDF3FE, dark: 0x283142)
    static let cardBorder = dynamic(light: 0xD6D6D8, dark: 0x424448)
    static let controlFill = dynamic(light: 0xF5F6F7, dark: 0x292A2D)
    static let selectedBorder = dynamic(light: 0xADB2B8, dark: 0x737981)
    static let progressTrack = dynamic(light: 0xEBEEF2, dark: 0x353638)
    static let accent = dynamic(light: 0x4176E6, dark: 0x679EFE)
    /// The outline used only by the two large choices on the home page.
    static let homeCardEdge = dynamic(light: 0xE6E8EB, dark: 0x34363A)
    /// `ChatStyle.floatingBarEdge()`: the hairline around a floating bar.
    static let separator = dynamic(light: 0xECEEF1, dark: 0x3B3B40)
    /// `ChatStyle.backButton()`'s own pair: the disc is white by day and
    /// `#29292D` at night, and its outline is a shade lighter than the disc
    /// rather than the field hairline above — it rings a raised button, not a
    /// field, and the two are not the same value in either appearance.
    static let raisedFace = dynamic(light: 0xFFFFFF, dark: 0x29292D)
    static let raisedEdge = dynamic(light: 0xF3F3F5, dark: 0x3A3A40)

    // MARK: - The settings palette
    //
    /// A card on one of those pages.
    static let card = dynamic(light: 0xFFFFFF, dark: 0x232324)
    /// Secondary text there.
    static let secondary = muted
    /// The line between two rows of one group.
    static let divider = dynamic(light: 0xECECEE, dark: 0x37373C)
    /// A field's own fill.
    static let field = controlFill
    /// A field's outline.
    static let fieldBorder = cardBorder
    /// Destructive actions and error text.
    static let error = dynamic(light: 0xB8323B, dark: 0xFF969A)
    /// The switch's off track: a light grey by day, a darker one at night.
    static let trackOff = dynamic(light: 0xD9DCE0, dark: 0x54575D)

    // MARK: - Type scale
    //
    // The same ladder `android/.../Palette.java` grew during the page-by-page
    // pass, and for the same reason: a bare `.font(.system(size: 17))` in
    // fifteen files cannot be compared with a `.system(size: 16)` in the next
    // one without counting.

    static let textTiny: CGFloat = 11
    static let textSmall: CGFloat = 12
    static let textNote: CGFloat = 13
    static let textBody: CGFloat = 14
    static let textInput: CGFloat = 15
    /// ChatStyle.messageTypography and MarkdownView add 7dp between lines.
    static let chatLineSpacing: CGFloat = 7
    /// A row's title in the settings vocabulary.
    static let textRow: CGFloat = 16
    /// A row's title where it is the heaviest text on the page.
    static let textRowStrong: CGFloat = 17
    /// A confirmation dialog's item.
    static let textDialog: CGFloat = 18
    /// A card's own title. One step below `textTitle` because a card sits *inside*
    /// a page, and at 20 it would read as a second heading.
    static let textCard: CGFloat = 19
    /// A page or sheet heading.
    static let textTitle: CGFloat = 20
    /// An empty state's heading.
    static let textDisplay: CGFloat = 21
    /// A selection tick — larger than `textDisplay` on purpose, because it is a
    /// glyph rather than words and has to stay legible at a glance.
    static let textTick: CGFloat = 22
    /// The home screen's headline.
    static let textHero: CGFloat = 28

    // MARK: - Corner radii
    //
    // Named after what they round, not by size, so a reader can tell two 20s
    // apart. `dialogAction` and `homeCard` happen to be the same number and are
    // still separate things.

    /// A message bubble or a plain block.
    static let radius: CGFloat = 12
    static let userBubbleRadius: CGFloat = 18
    static let settingsCardRadius: CGFloat = 16
    static let settingsControlRadius: CGFloat = 10
    /// A code block inside rendered Markdown.
    static let smallRadius: CGFloat = 8
    /// A settings card, a popup panel, a computer row's card.
    static let groupRadius: CGFloat = 26
    /// A bottom sheet's own panel.
    static let sheetRadius: CGFloat = 30
    /// An input field, a choice row.
    static let fieldRadius: CGFloat = 18
    /// The home screen's cards, and its settings entry.
    static let homeRadius: CGFloat = 20
    /// A dialog's action button: 20 on a 52pt button, so a rounded rectangle
    /// rather than the pill `capsuleRadius` would make.
    static let dialogActionRadius: CGFloat = 20
    /// A switch's track and the grip on a sheet.
    static let trackRadius: CGFloat = 14
    static let gripRadius: CGFloat = 3

    /// How a "capsule" in Android is drawn: `capsule()` is `rounded()` with the
    /// corner radius raised to 28, and 28 is under half the height of the
    /// taller bars, so it is a very round rectangle rather than a true capsule.
    static let capsuleRadius: CGFloat = 28

    /// The width a message bubble may reach on its long side.
    static let bubbleInset: CGFloat = 44

    /// How far the reader's own message is inset from the trailing edge. The
    /// same number on both sides, so a short reply and a long one start and end
    /// in the same place.
    static let userInset: CGFloat = 44

    /// The same two colours, as `UIColor`s, for the views UIKit draws.
    ///
    /// A `UIColor` made from a `Color` would be flattened to whichever
    /// appearance was current at the moment of the conversion; these keep the
    /// trait closure, so a text view handed one still re-resolves when the
    /// appearance changes.
    static let inkUI = dynamicUI(light: 0x0F1115, dark: 0xF9FAFB)
    static let mutedUI = dynamicUI(light: 0x61666B, dark: 0xCFD3D6)

    /// One colour with an appearance-dependent value.
    private static func dynamic(light: Int, dark: Int) -> Color {
        Color(dynamicUI(light: light, dark: dark))
    }

    private static func dynamicUI(light: Int, dark: Int) -> UIColor {
        UIColor { traits in
            uiColor(traits.userInterfaceStyle == .dark ? dark : light)
        }
    }

    private static func uiColor(_ value: Int) -> UIColor {
        UIColor(red: CGFloat((value >> 16) & 0xFF) / 255,
                green: CGFloat((value >> 8) & 0xFF) / 255,
                blue: CGFloat(value & 0xFF) / 255,
                alpha: 1)
    }
}

/// A rounded surface the list rows and cards share.
struct Surface<Content: View>: View {
    private let content: Content
    private let fill: Color

    init(_ fill: Color = Palette.surface, @ViewBuilder content: () -> Content) {
        self.fill = fill
        self.content = content()
    }

    var body: some View {
        content
            .padding(12)
            .background(RoundedRectangle(cornerRadius: Palette.radius, style: .continuous).fill(fill))
    }
}

/// A capsule button that reads as iOS rather than as the Android accent block.
struct CapsuleButton: View {
    let title: String
    var systemImage: String? = nil
    var prominent = true
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let systemImage = systemImage { Image(systemName: systemImage) }
                Text(LocalizedStringKey(title))
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(
                Capsule(style: .continuous)
                    .fill(prominent && enabled ? Palette.accent : Palette.surface)
            )
            .foregroundColor(prominent && enabled ? .white : Palette.ink)
            .opacity(enabled ? 1 : 0.45)
        }
        .disabled(!enabled)
        .buttonStyle(.plain)
    }
}

/// A short line of status under a section heading.
struct StatusLine: View {
    let text: String
    var tone: Tone = .muted

    enum Tone {
        case muted, good, bad

        var color: Color {
            switch self {
            case .muted: return Palette.muted
            case .good: return .green
            case .bad: return .red
            }
        }
    }

    var body: some View {
        Text(LocalizedStringKey(text))
            .font(.footnote)
            .foregroundColor(tone.color)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Three dots that pulse while the desktop is working.
struct WorkingDots: View {
    @State private var phase = 0

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3) { index in
                Circle()
                    .fill(Palette.muted)
                    .frame(width: 5, height: 5)
                    .opacity(phase == index ? 1 : 0.3)
            }
        }
        .onReceive(Timer.publish(every: 0.4, on: .main, in: .common).autoconnect()) { _ in
            phase = (phase + 1) % 3
        }
    }
}
