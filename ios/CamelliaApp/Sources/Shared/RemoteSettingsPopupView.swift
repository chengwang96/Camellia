import SwiftUI

/// The remote composer's anchored model and permission menus. The desktop owns
/// the model order; changing it on the phone would make the two clients disagree.
struct RemoteSettingsPopupView: View {
    enum Mode { case models, permissions }

    @EnvironmentObject private var model: AppModel
    @State private var showingThinking = false
    @State private var contentHeight: CGFloat = 64

    let mode: Mode
    let maxHeight: CGFloat
    let onDismiss: () -> Void

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 0) {
                if mode == .permissions {
                    permissionRows
                } else if showingThinking {
                    thinkingRows
                } else {
                    modelRows
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12)
            .padding(.top, 14)
            .padding(.bottom, 10)
            .background(GeometryReader { geometry in
                Color.clear.preference(key: RemotePopupHeightKey.self, value: geometry.size.height)
            })
            .onPreferenceChange(RemotePopupHeightKey.self) { contentHeight = $0 }
        }
        .frame(height: min(maxHeight, contentHeight))
        .background(PopupGlassSurface())
        .clipShape(RoundedRectangle(cornerRadius: Palette.groupRadius, style: .continuous))
        .shadow(color: .black.opacity(0.2), radius: 12, y: 5)
    }

    private var modelRows: some View {
        VStack(spacing: 0) {
            if let settings = model.transcript.settings, !settings.models.isEmpty {
                let hasAccount = settings.models.contains(where: \.isSubscription)
                let hasApi = settings.models.contains(where: { $0.connection == "api" })
                ForEach(Array(settings.models.enumerated()), id: \.offset) { index, choice in
                    if hasAccount && hasApi && !settings.models[..<index].contains(where: {
                        $0.isSubscription == choice.isSubscription
                    }) {
                        heading(choice.isSubscription ? "账号模型" : "共享 API 路由")
                    }
                    PopupChoiceRow(title: choice.name, subtitle: choice.name == choice.id ? "" : choice.id,
                                   selected: settings.model == choice.id) {
                        choose("model", choice.id)
                    }
                }
            } else {
                PopupChoiceRow(title: "暂无可用模型", subtitle: "请在电脑端配置模型或登录账号",
                               action: {})
            }
            divider
            PopupChoiceRow(title: "思考等级",
                           subtitle: LocalChatThinking.display(model.transcript.settings?.thinking,
                                                                 chinese: model.usesChinese),
                           icon: "chevron.right") {
                showingThinking = true
            }
        }
    }

    private var thinkingRows: some View {
        VStack(spacing: 0) {
            PopupChoiceRow(title: "返回模型", subtitle: "", icon: "chevron.down") {
                showingThinking = false
            }
            divider
            let settings = model.transcript.settings
            PopupChoiceRow(title: "默认", subtitle: "遵循引擎默认设置",
                           selected: settings?.thinking.isEmpty ?? true) {
                choose("thinking", "")
            }
            if let choice = settings?.models.first(where: { $0.id == settings?.model }) {
                ForEach(choice.thinking, id: \.self) { level in
                    let label = LocalChatThinking.display(level, chinese: model.usesChinese)
                    PopupChoiceRow(title: label, subtitle: label == level ? "" : level,
                                   selected: settings?.thinking == level) {
                        choose("thinking", level)
                    }
                }
            }
        }
    }

    private var permissionRows: some View {
        VStack(spacing: 0) {
            ForEach(PermissionMode.all, id: \.id) { mode in
                PopupChoiceRow(title: mode.title, subtitle: mode.detail,
                               selected: model.transcript.settings?.permissionMode == mode.id) {
                    choose("permissionMode", mode.id)
                }
            }
        }
    }

    private func heading(_ title: String) -> some View {
        Text(LocalizedStringKey(title))
            .font(.system(size: Palette.textTiny))
            .foregroundColor(Palette.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 4)
    }

    private var divider: some View {
        Palette.muted.opacity(0.14)
            .frame(height: 1)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
    }

    private func choose(_ key: String, _ value: String) {
        onDismiss()
        model.configure(key, value: value)
    }
}

private struct RemotePopupHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
