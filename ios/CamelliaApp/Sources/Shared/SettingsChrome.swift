import SwiftUI

/// The grouped-card vocabulary used by Android's settings, computer and
/// pairing pages. Keeping it in one place prevents those pages from drifting
/// back to unrelated `Form` defaults.
struct SettingsCard<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) { self.content = content() }

    var body: some View {
        VStack(spacing: 0) { content }
            .background(RoundedRectangle(cornerRadius: Palette.groupRadius, style: .continuous)
                .fill(Palette.card))
            .clipShape(RoundedRectangle(cornerRadius: Palette.groupRadius, style: .continuous))
    }
}

struct SettingsGroupLabel: View {
    let title: String

    var body: some View {
        Text(LocalizedStringKey(title))
            .font(.system(size: Palette.textSmall, weight: .medium))
            .foregroundColor(Palette.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 16)
            .padding(.top, 18)
            .padding(.bottom, 8)
    }
}

struct SettingsDivider: View {
    var leading: CGFloat = 58

    var body: some View {
        Rectangle()
            .fill(Palette.divider)
            .frame(height: 1)
            .padding(.leading, leading)
    }
}

struct SettingsRowLabel: View {
    let icon: String
    let title: String
    var value: String = ""
    var detail: String = ""
    var showsChevron = true
    var destructive = false

    var body: some View {
        HStack(spacing: 14) {
            if !icon.isEmpty {
                Image(systemName: icon)
                    .font(.system(size: Palette.textDialog))
                    .foregroundColor(destructive ? Palette.error : Palette.ink)
                    .frame(width: 26, height: 26)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(LocalizedStringKey(title))
                    .font(.system(size: Palette.textRowStrong))
                    .foregroundColor(destructive ? Palette.error : Palette.ink)
                    .lineLimit(1)
                if !detail.isEmpty {
                    Text(LocalizedStringKey(detail))
                        .font(.system(size: Palette.textNote))
                        .foregroundColor(Palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .layoutPriority(1)
            Spacer(minLength: 8)
            if !value.isEmpty {
                Text(LocalizedStringKey(value))
                    .font(.system(size: Palette.textNote))
                    .foregroundColor(Palette.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: Palette.textNote, weight: .semibold))
                    .foregroundColor(Palette.secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
        .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
        .contentShape(Rectangle())
    }
}

struct SettingsNote: View {
    let text: String

    var body: some View {
        Text(LocalizedStringKey(text))
            .font(.system(size: Palette.textNote))
            .foregroundColor(Palette.secondary)
            .lineSpacing(2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 8)
            .padding(.vertical, 10)
    }
}

/// Gives a pushed settings page the same raised back control and centred title
/// as Android, while still using `NavigationView` for the actual stack.
private struct SettingsPageModifier: ViewModifier {
    let title: String
    let onBack: (() -> Void)?
    @Environment(\.presentationMode) private var presentation

    func body(content: Content) -> some View {
        content
            .background(Palette.grouped.ignoresSafeArea())
            .navigationBarBackButtonHidden(true)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    RoundBackButton {
                        if let onBack { onBack() }
                        else { presentation.wrappedValue.dismiss() }
                    }
                }
                ToolbarItem(placement: .principal) {
                    Text(LocalizedStringKey(title))
                        .font(.system(size: Palette.textTitle, weight: .medium))
                        .foregroundColor(Palette.ink)
                }
            }
    }
}

extension View {
    func settingsPage(title: String, onBack: (() -> Void)? = nil) -> some View {
        modifier(SettingsPageModifier(title: title, onBack: onBack))
    }
}
