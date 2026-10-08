import SwiftUI

/// One choice in the model, thinking, or permission popups. Android uses its
/// `ChatChoiceRow` for all three so their tap target, type and tick never drift.
struct PopupChoiceRow: View {
    let title: String
    let subtitle: String
    var icon: String? = nil
    var selected = false
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(LocalizedStringKey(title))
                        .font(.system(size: Palette.textRowStrong, weight: .medium))
                        .foregroundColor(Palette.ink)
                        .lineLimit(2)
                    if !subtitle.isEmpty {
                        Text(LocalizedStringKey(subtitle))
                            .font(.system(size: Palette.textSmall))
                            .foregroundColor(Palette.muted)
                            .lineLimit(3)
                    }
                }
                Spacer(minLength: 4)
                if selected {
                    Text("✓")
                        .font(.system(size: Palette.textTick))
                        .foregroundColor(Palette.accent)
                        .frame(width: 32)
                        .accessibilityHidden(true)
                } else if let icon {
                    Image(systemName: icon)
                        .font(.system(size: Palette.textNote, weight: .semibold))
                        .foregroundColor(Palette.muted)
                        .frame(width: 26)
                        .accessibilityHidden(true)
                }
            }
            .padding(.leading, 16)
            .padding(.trailing, 14)
            .padding(.vertical, 14)
            .frame(minHeight: 64)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
