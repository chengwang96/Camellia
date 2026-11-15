import SwiftUI

/// The chat pages' one heading, as Android builds it for both of them.
///
/// `shell()` has a single branch for `list` and `detail`, and it draws the same
/// three things in both: a back button, a title over the computer it is talking
/// to, and the switch-computer button. The two screens were written separately
/// here and drifted — the detail page showed "电脑执行 · 手机查看" where the list
/// showed the computer — so the shape they share now lives in one place. That
/// string is what `detailScreen()` *passes* to `shell()`, not what `shell()`
/// draws: the list/detail branch never reads its `subtitle` argument, so Android
/// really does put the computer's name under the conversation's title too.
struct RemotePageHeading: View {
    let title: String
    let computer: String
    var systemImage: String = "desktopcomputer"
    /// The connection state beside the computer, empty when it is normal.
    var note: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            // Android's `pageTitle` is 19sp medium, and the detail screen reuses
            // the same TextView — so one title style covers both.
            Text(title)
                .font(.system(size: Palette.textCard, weight: .medium))
                .lineLimit(1)
                .truncationMode(.tail)
            HStack(spacing: 4) {
                MobileLineIcon(name: systemImage, size: 14)
                Text(computer)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if !note.isEmpty {
                    // Android hangs a second, width-capped 12sp label off the
                    // same line (`headerConnection`, `setMaxWidth(dp(112))`),
                    // with 6dp of lead on both sides. It is hidden whenever the
                    // stream is holding, so it only ever reads as a problem.
                    Text(note)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.leading, 2)
                }
            }
            .font(.system(size: Palette.textSmall))
            .foregroundColor(Palette.muted)
        }
    }
}

/// The same 24-unit monitor-and-arrow path as Android's `LineIcon("switch-computer")`.
/// `ChatStyle.lineButton()` puts it in a 48dp target with 13dp of inset.
private struct SwitchComputerGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addRoundedRect(in: CGRect(x: 3, y: 3, width: 15, height: 11),
                            cornerSize: CGSize(width: 2, height: 2))
        path.move(to: CGPoint(x: 10.5, y: 14))
        path.addLine(to: CGPoint(x: 10.5, y: 18))
        path.move(to: CGPoint(x: 5, y: 18))
        path.addLine(to: CGPoint(x: 15, y: 18))
        path.move(to: CGPoint(x: 18, y: 17))
        path.addLine(to: CGPoint(x: 21, y: 20))
        path.addLine(to: CGPoint(x: 18, y: 23))
        path.move(to: CGPoint(x: 21, y: 20))
        path.addLine(to: CGPoint(x: 12, y: 20))
        return path.applying(CGAffineTransform(scaleX: rect.width / 24,
                                              y: rect.height / 24))
    }
}

struct SwitchComputerIcon: View {
    var body: some View {
        SwitchComputerGlyph()
            .stroke(Palette.ink, style: StrokeStyle(lineWidth: 1.7 * 22 / 24,
                                                     lineCap: .round, lineJoin: .round))
            .frame(width: 22, height: 22)
            .frame(width: 48, height: 48)
    }
}

/// The shared flat 48-point back control used by settings and conversation headers.
struct RoundBackButton: View {
    var isPageBack = true
    let action: () -> Void
    @Environment(\.isEnabled) private var enabled
    @StateObject private var back = PageBackAction()

    var body: some View {
        Button { if isPageBack { back.perform(action) } else { action() } } label: {
            MobileLineIcon(name: "back", size: 20)
                .foregroundColor(Palette.accent)
                .frame(width: 48, height: 48)
                .contentShape(Circle())
        }
        .buttonStyle(ComposerPressStyle())
        .accessibilityLabel("返回上一级")
        .background {
            if isPageBack {
                PageBackSupport(action: back, enabled: enabled, onBack: action)
                    .frame(width: 0, height: 0)
            }
        }
    }
}
