import SwiftUI

/// Matches Android's SettingsChoiceDialog. Provider names remain literal,
/// while preference labels opt into the app's selected interface language.
struct SettingsChoicePanel: View {
    let title: String
    let labels: [String]
    let selected: Int
    var localizeLabels = false
    let onChoose: (Int) -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Palette.divider)
                .frame(width: 36, height: 4)
                .padding(.bottom, 16)
                .accessibilityHidden(true)
            Text(LocalizedStringKey(title))
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
                            SwiftUI.Group {
                                if localizeLabels {
                                    Text(LocalizedStringKey(labels[index]))
                                } else {
                                    Text(labels[index])
                                }
                            }
                            .font(.system(size: Palette.textRow,
                                          weight: index == selected ? .medium : .regular))
                            .foregroundColor(Palette.ink)
                            Spacer(minLength: 0)
                            Text(index == selected ? "✓" : "")
                                .font(.system(size: Palette.textRow, weight: .medium))
                                .foregroundColor(Palette.card)
                                .frame(width: 26, height: 26)
                                .background(Circle().fill(index == selected ? Palette.ink : Color.clear))
                                .overlay(Circle().stroke(index == selected ? Color.clear : Palette.divider,
                                                         lineWidth: 1))
                                .accessibilityHidden(true)
                        }
                        .padding(.horizontal, 16)
                        .frame(minHeight: 64)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(index == selected ? .isSelected : [])
                }
            }
            .background(RoundedRectangle(cornerRadius: Palette.dialogActionRadius, style: .continuous)
                .fill(Palette.card))
            .clipShape(RoundedRectangle(cornerRadius: Palette.dialogActionRadius, style: .continuous))
            SettingsDialogAction(title: "取消", primary: false, action: onCancel)
                .padding(.top, 12)
        }
        .padding(.horizontal, 18)
        .padding(.top, 14)
        .padding(.bottom, 18)
        .background(RoundedRectangle(cornerRadius: Palette.sheetRadius, style: .continuous)
            .fill(Palette.grouped))
    }
}
