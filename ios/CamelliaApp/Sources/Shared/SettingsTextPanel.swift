import SwiftUI

/// The text-field form of Android's CamelliaDialog: a bottom panel whose
/// validation stays beside the field instead of dismissing a system alert.
struct SettingsTextPanel: View {
    let title: String
    let placeholder: String
    @Binding var text: String
    @Binding var error: String?
    let onSave: () -> Void
    let onCancel: () -> Void

    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Capsule()
                .fill(Palette.divider)
                .frame(width: 36, height: 4)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 16)
                .accessibilityHidden(true)
            Text(LocalizedStringKey(title))
                .font(.system(size: Palette.textDisplay, weight: .medium))
                .foregroundColor(Palette.ink)
                .padding(.horizontal, 8)
                .padding(.top, 4)
                .padding(.bottom, 18)
                .accessibilityAddTraits(.isHeader)
            TextField(LocalizedStringKey(placeholder), text: $text)
                .font(.system(size: Palette.textRow))
                .foregroundColor(Palette.ink)
                .textInputAutocapitalization(.sentences)
                .submitLabel(.done)
                .focused($focused)
                // Android's form commits only through its Save button. The
                // keyboard's Done action should merely end editing.
                .onSubmit { focused = false }
                .padding(.horizontal, 16)
                .frame(minHeight: 54)
                .background(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                    .fill(Palette.field))
                .overlay(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                    .stroke(error == nil ? Palette.fieldBorder : Palette.error, lineWidth: 1))
                .accessibilityLabel(Text(LocalizedStringKey(placeholder)))
                .onChange(of: text) { _ in error = nil }
            if let error {
                Text(LocalizedStringKey(error))
                    .font(.system(size: Palette.textSmall))
                    .foregroundColor(Palette.error)
                    .padding(.top, 6)
                    .accessibilityAddTraits(.updatesFrequently)
            }
            VStack(spacing: 8) {
                SettingsDialogAction(title: "保存", primary: true, action: onSave)
                SettingsDialogAction(title: "取消", primary: false, action: onCancel)
            }
            .padding(.top, 12)
        }
        .padding(.horizontal, 18)
        .padding(.top, 14)
        .padding(.bottom, 18)
        .background(RoundedRectangle(cornerRadius: Palette.sheetRadius, style: .continuous)
            .fill(Palette.grouped))
        .onAppear { focused = true }
    }
}
