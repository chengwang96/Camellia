import SwiftUI

struct SettingsProgressStyle: ProgressViewStyle {
    func makeBody(configuration: Configuration) -> some View {
        let fraction = min(1, max(0, configuration.fractionCompleted ?? 0))
        return GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Palette.progressTrack)
                Capsule().fill(Palette.accent).frame(width: geometry.size.width * CGFloat(fraction))
            }
        }
        .frame(height: 6)
        .accessibilityValue(Text(fraction, format: .percent.precision(.fractionLength(0))))
    }
}

struct SettingsToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            HStack {
                configuration.label
                Spacer(minLength: 12)
                RoundedRectangle(cornerRadius: 14)
                    .fill(configuration.isOn ? Palette.ink : Palette.trackOff)
                    .frame(width: 48, height: 28)
                    .overlay(Circle().fill(configuration.isOn ? Palette.grouped : Color.white)
                        .frame(width: 24, height: 24)
                        .offset(x: configuration.isOn ? 10 : -10))
                    .frame(minHeight: 48)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityValue(configuration.isOn ? Text("已开启") : Text("已关闭"))
    }
}

/// The same three icon-over-label choices as desktop, with phone-sized targets.
struct SettingsAppearanceChoices: View {
    @Binding var selection: AppTheme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("外观")
                .font(.system(size: Palette.textRowStrong))
            HStack(alignment: .top, spacing: 6) {
                ForEach(AppTheme.allCases, id: \.self) { theme in
                    Button { selection = theme } label: {
                        VStack(spacing: 6) {
                            MobileLineIcon(name: icon(theme), size: 20)
                            Text(LocalizedStringKey(theme.label))
                                .font(.system(size: Palette.textNote))
                                .multilineTextAlignment(.center)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity, minHeight: 56)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 12)
                        .background(RoundedRectangle(cornerRadius: Palette.settingsCardRadius)
                            .fill(selection == theme ? Palette.controlFill : Palette.card))
                        .overlay(RoundedRectangle(cornerRadius: Palette.settingsCardRadius)
                            .strokeBorder(selection == theme ? Palette.selectedBorder : Palette.cardBorder, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selection == theme ? [.isSelected] : [])
                    .accessibilityIdentifier("appearance:" + theme.rawValue)
                }
            }
        }
        .foregroundColor(Palette.ink)
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    private func icon(_ theme: AppTheme) -> String {
        switch theme {
        case .system: return "computer"
        case .light: return "appearance"
        case .dark: return "moon"
        }
    }
}

/// The grouped-card vocabulary used by Android's settings, computer and
/// pairing pages. Keeping it in one place prevents those pages from drifting
/// back to unrelated `Form` defaults.
struct SettingsCard<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) { self.content = content() }

    var body: some View {
        VStack(spacing: 0) { content }
            .background(RoundedRectangle(cornerRadius: Palette.settingsCardRadius, style: .continuous)
                .fill(Palette.card))
            .clipShape(RoundedRectangle(cornerRadius: Palette.settingsCardRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Palette.settingsCardRadius, style: .continuous)
                .strokeBorder(Palette.cardBorder, lineWidth: 1))
            .padding(.bottom, 14)
    }
}

struct SettingsGroupLabel: View {
    let title: String

    var body: some View {
        Text(LocalizedStringKey(title))
            .font(.system(size: Palette.textNote))
            .foregroundColor(Palette.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 16)
            .padding(.top, 12)
            .padding(.bottom, 10)
    }
}

struct SettingsDivider: View {
    var leading: CGFloat = 52

    var body: some View {
        Rectangle()
            .fill(Palette.divider)
            .frame(height: 0.5)
            .padding(.leading, leading)
            .padding(.trailing, 16)
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
        HStack(spacing: 13) {
            if !icon.isEmpty {
                MobileLineIcon(name: icon)
                    .foregroundColor(destructive ? Palette.error : Palette.ink)
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
                    .font(.system(size: Palette.textBody))
                    .foregroundColor(Palette.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: 100, alignment: .trailing)
            }
            if showsChevron {
                MobileLineIcon(name: "right", size: 18)
                    .foregroundColor(Palette.secondary)
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 14)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
        .contentShape(Rectangle())
    }
}

struct SettingsNote: View {
    let text: String

    var body: some View {
        Text(LocalizedStringKey(text))
            .font(.system(size: Palette.textNote))
            .foregroundColor(Palette.faint)
            .lineSpacing(2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 8)
            .padding(.vertical, 10)
    }
}

/// A fixed header keeps Android's geometry on every supported iOS release.
private struct SettingsPageModifier: ViewModifier {
    let title: String
    let onBack: (() -> Void)?
    let background: Color
    @Environment(\.presentationMode) private var presentation

    func body(content: Content) -> some View {
        content
            .background(background.ignoresSafeArea())
            .navigationBarBackButtonHidden(true)
            .navigationBarHidden(true)
            .safeAreaInset(edge: .top, spacing: 0) {
                HStack(spacing: 0) {
                    RoundBackButton {
                        if let onBack { onBack() }
                        else { presentation.wrappedValue.dismiss() }
                    }
                    Text(LocalizedStringKey(title))
                        .font(.system(size: Palette.textTitle, weight: .medium))
                        .foregroundColor(Palette.ink)
                        .frame(maxWidth: .infinity)
                        .accessibilityAddTraits(.isHeader)
                    Color.clear.frame(width: 48, height: 1)
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 16)
                .background(background)
            }
    }
}

extension View {
    func settingsPage(title: String, background: Color = Palette.grouped, onBack: (() -> Void)? = nil) -> some View {
        modifier(SettingsPageModifier(title: title, onBack: onBack, background: background))
    }
}
