import SwiftUI

enum ComputerPickerAction {
    case open(PairedComputer)
    case add
    case manage
}

/// Android's header switcher is a compact popup, not the computers page.
/// The page remains available through the popup's final action.
struct ComputerPickerPopupView: View {
    @EnvironmentObject private var model: AppModel
    @State private var contentHeight: CGFloat = 0

    let maxHeight: CGFloat
    let onAction: (ComputerPickerAction) -> Void
    var computers: [PairedComputer]? = nil
    var selectedAddress: String? = nil
    var selectionOnly = false

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 0) {
                ForEach(orderedComputers, id: \.address) { computer in
                    computerRow(computer)
                }
                if !selectionOnly && !orderedComputers.isEmpty {
                    Rectangle()
                        .fill(Palette.divider)
                        .frame(height: 1)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                }
                if !selectionOnly {
                    actionRow("plus", title: "添加电脑") { onAction(.add) }
                    actionRow("gearshape", title: "管理电脑") { onAction(.manage) }
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(8)
            .background(GeometryReader { geometry in
                Color.clear.preference(key: ComputerPopupHeightKey.self, value: geometry.size.height)
            })
            .onPreferenceChange(ComputerPopupHeightKey.self) { contentHeight = $0 }
        }
        .frame(height: min(maxHeight, contentHeight > 0 ? contentHeight : initialHeight))
        .background(PopupGlassSurface())
        .clipShape(RoundedRectangle(cornerRadius: Palette.groupRadius, style: .continuous))
        .shadow(color: .black.opacity(0.2), radius: 8, y: 5)
        .task { if !selectionOnly { await model.refreshComputers() } }
    }

    private var initialHeight: CGFloat {
        16 + CGFloat(orderedComputers.count + (selectionOnly ? 0 : 2)) * 56 + (selectionOnly || orderedComputers.isEmpty ? 0 : 17)
    }

    private var orderedComputers: [PairedComputer] {
        if let computers { return computers }
        let current = model.current?.address
        return model.computers.sorted { left, right in
            if (left.address == current) != (right.address == current) {
                return left.address == current
            }
            return left.displayName.localizedCaseInsensitiveCompare(right.displayName) == .orderedAscending
        }
    }

    private func computerRow(_ computer: PairedComputer) -> some View {
        let selected = computer.address == (selectionOnly ? selectedAddress : model.current?.address)
        let state = computer.isPaired ? model.computerState(computer.address)
            : (model.usesChinese ? "等待电脑确认" : "Waiting for desktop confirmation")
        return Button { onAction(.open(computer)) } label: {
            HStack(spacing: 0) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: Palette.textCard))
                    .foregroundColor(Palette.ink)
                    .frame(width: 24)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: computer.displayName)
                        .font(.system(size: Palette.textRowStrong))
                        .foregroundColor(Palette.ink)
                        .lineLimit(1)
                    if !selectionOnly {
                        Text(verbatim: ComputerStatus.display(state, chinese: model.usesChinese))
                            .font(.system(size: Palette.textSmall))
                            .foregroundColor(ComputerStatus.isConnected(state) ? Palette.accent : Palette.muted)
                            .lineLimit(2)
                    }
                }
                .padding(.leading, 14)
                Spacer(minLength: 8)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: Palette.textRowStrong, weight: .semibold))
                        .foregroundColor(Palette.accent)
                        .frame(width: 22)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .help(Text(verbatim: computer.displayName))
        .accessibilityLabel(computer.displayName + (selected
                            ? (model.usesChinese ? "，当前电脑" : ", current computer") : ""))
    }

    private func actionRow(_ symbol: String, title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: symbol)
                    .font(.system(size: Palette.textCard))
                    .frame(width: 24)
                    .accessibilityHidden(true)
                Text(LocalizedStringKey(title))
                    .font(.system(size: Palette.textRowStrong))
                Spacer(minLength: 0)
            }
            .foregroundColor(Palette.ink)
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct ComputerPopupHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
