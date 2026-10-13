import SwiftUI

/// Android's compact, anchored long-press menu.
struct ConversationActionsMenu: View {
    let pinned: Bool
    let rename: () -> Void
    let select: () -> Void
    let pin: () -> Void
    let archive: () -> Void
    let delete: () -> Void
    var fork: (() -> Void)? = nil
    var onDismiss: () -> Void = {}

    var body: some View {
        VStack(spacing: 0) {
            row("重命名", icon: "edit", action: rename)
            row("多选", icon: "select", action: select)
            row(pinned ? "取消置顶" : "置顶", icon: "pin", action: pin)
            if let fork { row("分叉会话", icon: "branch", action: fork) }
            row("归档会话", icon: "archive", action: archive)
            row("删除", icon: "delete", destructive: true, action: delete)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 8)
    }

    private func row(_ title: String, icon: String, destructive: Bool = false,
                     action: @escaping () -> Void) -> some View {
        Button { onDismiss(); action() } label: {
            HStack(spacing: 14) {
                MobileLineIcon(name: icon, size: 23)
                Text(LocalizedStringKey(title)).font(.system(size: Palette.textDialog))
                Spacer(minLength: 0)
            }
            .foregroundColor(destructive ? Palette.error : Palette.ink)
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct ConversationRowFrames: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

extension View {
    func conversationMenuAnchor(_ id: String, space: String) -> some View {
        background(GeometryReader { geometry in
            Color.clear.preference(key: ConversationRowFrames.self,
                                   value: [id: geometry.frame(in: .named(space))])
        })
    }
}

struct ConversationMenuOverlay<Content: View>: View {
    let anchor: CGRect?
    let rows: Int
    let onDismiss: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        GeometryReader { geometry in
            let width = min(192, max(1, geometry.size.width - 24))
            let height = min(CGFloat(rows * 56 + 16), max(1, geometry.size.height - 16))
            let left = max(12, min(anchor?.minX ?? 12, geometry.size.width - width - 12))
            let top = max(8, min(anchor?.maxY ?? 8, geometry.size.height - height - 8))
            ZStack(alignment: .topLeading) {
                PopupDismissArea(dismiss: onDismiss)
                ScrollView(showsIndicators: false) { content() }
                    .frame(width: width, height: height)
                    .background(PopupGlassSurface())
                    .clipShape(RoundedRectangle(cornerRadius: Palette.groupRadius, style: .continuous))
                    .shadow(color: .black.opacity(0.20), radius: 12, y: 5)
                    .position(x: left + width / 2, y: top + height / 2)
                    .accessibilityIdentifier("conversation-actions-menu")
            }
        }
    }
}
