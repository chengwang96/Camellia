import SwiftUI

/// A page with nothing on it yet.
///
/// Not a `Surface`. A surface is something with a fill and a border, and on a
/// settings page that shape means "a row you can tap" — so an empty state built
/// from one reads as one more thing to tap, and the reader has to tap it to find
/// out what happens. This has no plate, no chevron, and is centred, because it
/// reports a state rather than offering a destination.
///
enum EmptyStateMark {
    case new
    case search
    case brand
}

struct EmptyStateView<Accessory: View>: View {
    let mark: EmptyStateMark
    let title: String
    var message: String = ""
    private let accessory: () -> Accessory

    init(mark: EmptyStateMark, title: String, message: String = "",
         @ViewBuilder accessory: @escaping () -> Accessory) {
        self.mark = mark
        self.title = title
        self.message = message
        self.accessory = accessory
    }

    var body: some View {
        VStack(spacing: 0) {
            markView
            VStack(spacing: 0) {
                Text(LocalizedStringKey(title))
                    .font(.system(size: Palette.textDisplay).weight(.medium))
                    .foregroundColor(Palette.ink)
                    .multilineTextAlignment(.center)
                    .padding(.top, 20)
                if !message.isEmpty {
                    Text(LocalizedStringKey(message))
                        .font(.system(size: Palette.textBody))
                        .foregroundColor(Palette.muted)
                        .multilineTextAlignment(.center)
                        .lineSpacing(4)
                        .padding(.top, 8)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(spokenLabel)
            accessory().padding(.top, 20)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 20)
        .padding(.top, 44)
        .padding(.bottom, 36)
        .frame(minHeight: 260)
    }

    @ViewBuilder private var markView: some View {
        switch mark {
        case .new, .search:
            EmptyStateLineIcon(mark: mark)
                .stroke(Palette.muted, style: StrokeStyle(lineWidth: 2.55,
                                                          lineCap: .round, lineJoin: .round))
                .frame(width: 36, height: 36)
                .frame(width: 52, height: 52)
                .accessibilityHidden(true)
        case .brand:
            // These apps are built without an asset catalog. SwiftUI's named
            // image lookup does not resolve the loose PNG in that bundle.
            Image(uiImage: UIImage(contentsOfFile: Bundle.main.bundlePath + "/CamelliaBrand.png")!)
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: 52, height: 52)
                .accessibilityHidden(true)
        }
    }

    private var spokenLabel: Text {
        let localizedTitle = Text(LocalizedStringKey(title))
        guard !message.isEmpty else { return localizedTitle }
        return localizedTitle + Text(verbatim: ". ") + Text(LocalizedStringKey(message))
    }
}

/// The two paths used by Android's `ChatEmptyState` through `LineIcon`.
private struct EmptyStateLineIcon: Shape {
    let mark: EmptyStateMark

    func path(in rect: CGRect) -> Path {
        var path = Path()
        switch mark {
        case .new:
            path.move(to: CGPoint(x: 5, y: 17))
            path.addCurve(to: CGPoint(x: 18, y: 5),
                          control1: CGPoint(x: -1, y: 5), control2: CGPoint(x: 11, y: 0))
            path.addCurve(to: CGPoint(x: 10, y: 20),
                          control1: CGPoint(x: 26, y: 12), control2: CGPoint(x: 20, y: 22))
            path.addLine(to: CGPoint(x: 3, y: 21))
            path.closeSubpath()
            path.move(to: CGPoint(x: 9, y: 12))
            path.addLine(to: CGPoint(x: 17, y: 12))
            path.move(to: CGPoint(x: 13, y: 8))
            path.addLine(to: CGPoint(x: 13, y: 16))
        case .search:
            path.addEllipse(in: CGRect(x: 4, y: 4, width: 13, height: 13))
            path.move(to: CGPoint(x: 16, y: 16))
            path.addLine(to: CGPoint(x: 21, y: 21))
        case .brand:
            break
        }
        return path.applying(CGAffineTransform(scaleX: rect.width / 24, y: rect.height / 24))
    }
}

/// `ChatEmptyState` uses the same 48pt capsule action in every empty state.
struct EmptyStateActionButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(LocalizedStringKey(title))
                .font(.system(size: Palette.textInput))
                .foregroundColor(Palette.ink)
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .frame(minHeight: 48)
                .background(RoundedRectangle(cornerRadius: Palette.capsuleRadius, style: .continuous)
                    .fill(Palette.surface))
        }
        .buttonStyle(.plain)
    }
}
