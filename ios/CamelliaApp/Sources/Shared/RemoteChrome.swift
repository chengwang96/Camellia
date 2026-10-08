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
                .font(.system(size: Palette.textRowStrong, weight: .medium))
                .lineLimit(1)
                .truncationMode(.tail)
            HStack(spacing: 4) {
                Image(systemName: systemImage).font(.system(size: Palette.textTiny))
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

/// `ChatStyle.backButton()`: a raised white disc with a dark arrow in it.
///
/// Not the system's back chevron, which is why it is drawn here at all. Android
/// puts a 48dp circle with a hairline, a 4dp elevation and a pressed state that
/// sinks 2dp into every chat page's header, and the two apps sitting on one desk
/// makes that the thing a person compares first — the system chevron is the
/// wrong colour, the wrong size and in the wrong place.
struct RoundBackButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.left")
                .font(.system(size: Palette.textRowStrong, weight: .medium))
                .foregroundColor(Palette.ink)
                .frame(width: 48, height: 48)
                .background(
                    Circle()
                        .fill(Palette.raisedFace)
                        .overlay(Circle().stroke(Palette.raisedEdge, lineWidth: 1))
                        .shadow(color: .black.opacity(0.16), radius: 4, y: 1)
                )
                // `button.setPadding(dp(14))` around a 20dp glyph: the tap
                // target is the disc, and the disc is 48 across.
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("返回上一级")
    }
}
