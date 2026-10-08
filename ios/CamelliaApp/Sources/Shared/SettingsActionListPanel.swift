import SwiftUI

/// The action-list form of Android's CamelliaDialog, without radio indicators.
/// Its title is caller data (for example a workspace name), not a localization key.
struct SettingsActionListPanel: View {
    let title: String
    let labels: [String]
    let onChoose: (Int) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Palette.divider)
                .frame(width: 36, height: 4)
                .padding(.bottom, 16)
                .accessibilityHidden(true)
            Text(verbatim: title)
                .font(.system(size: Palette.textDisplay, weight: .medium))
                .foregroundColor(Palette.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8)
                .padding(.top, 4)
                .padding(.bottom, 18)
                .accessibilityAddTraits(.isHeader)
            VStack(spacing: 0) {
                ForEach(labels.indices, id: \.self) { index in
                    if index > 0 { SettingsDivider(leading: 16) }
                    Button { onChoose(index) } label: {
                        HStack(spacing: 12) {
                            Text(LocalizedStringKey(labels[index]))
                                .font(.system(size: Palette.textRowStrong))
                                .foregroundColor(Palette.ink)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right")
                                .font(.system(size: Palette.textRow))
                                .foregroundColor(Palette.secondary)
                                .accessibilityHidden(true)
                        }
                        .padding(.horizontal, 16)
                        .frame(minHeight: 64)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .background(RoundedRectangle(cornerRadius: Palette.dialogActionRadius, style: .continuous)
                .fill(Palette.card))
            .clipShape(RoundedRectangle(cornerRadius: Palette.dialogActionRadius, style: .continuous))
            .padding(.bottom, 14)
        }
        .padding(.horizontal, 18)
        .padding(.top, 14)
        .padding(.bottom, 18)
        .background(RoundedRectangle(cornerRadius: Palette.sheetRadius, style: .continuous)
            .fill(Palette.grouped))
    }
}
