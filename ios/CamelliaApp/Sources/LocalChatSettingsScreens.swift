import SwiftUI
import UIKit

// MARK: - Providers and keys

/// Where the local half gets its models.
///
/// Local chat calls providers directly, so the keys have to exist on this
/// device rather than on a desktop. Android reads them two ways — a pasted JSON
/// bundle, or the desktop's own bundle over the tunnel — and this is the same
/// pair of doors, plus the reverse direction (export) so a configuration built
/// here can move to another device. Both directions accept the exact
/// `camellia-api-routes` v2 document, which is what makes an Android export
/// importable here and vice versa.
struct ProviderSettingsView: View {
    var onClose: (() -> Void)? = nil
    @EnvironmentObject private var local: LocalChatModel
    @EnvironmentObject private var model: AppModel
    @Environment(\.locale) private var locale

    @State private var importing = false
    @State private var editing: ProviderEditorTarget?
    @State private var choosingComputer = false
    @State private var prompt: ProviderPrompt?

    var body: some View {
        ZStack(alignment: .bottom) {
            presentedPage
            if importing {
                Color.black.opacity(0.28).ignoresSafeArea()
                    .onTapGesture { importing = false }
                ConfigImportView(onClose: { importing = false })
                    .environmentObject(local)
                    .frame(maxWidth: 560)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
            } else if let prompt {
                Color.black.opacity(0.28).ignoresSafeArea()
                    .onTapGesture { self.prompt = nil }
                SettingsMessagePanel(title: promptTitle(prompt), message: promptMessage(prompt),
                                     confirmTitle: promptConfirmTitle(prompt),
                                     cancelTitle: promptCancelTitle(prompt),
                                     onConfirm: { acceptPrompt(prompt) },
                                     onCancel: { self.prompt = nil })
                    .frame(maxWidth: 560)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
            } else if choosingComputer {
                Color.black.opacity(0.28).ignoresSafeArea()
                    .onTapGesture { choosingComputer = false }
                SettingsChoicePanel(title: "选择电脑", labels: pairedComputers.map(\.displayName),
                                    selected: -1,
                                    onChoose: { index in
                                        let computers = pairedComputers
                                        choosingComputer = false
                                        if computers.indices.contains(index) {
                                            prompt = .importFrom(computers[index])
                                        }
                                    },
                                    onCancel: { choosingComputer = false })
                    .frame(maxWidth: 560)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
            }
        }
        .onAppear(perform: adoptNotice)
        .onChange(of: local.notice) { _ in adoptNotice() }
    }

    private var presentedPage: some View {
        page
            .sheet(item: $editing) { target in
                ProviderEditorView(provider: target.provider)
                    .environmentObject(local)
            }
    }

    private var page: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 0) {
                addProviderSection
                providerSection
                transferSection
            }
            .padding(.horizontal, 20)
            .padding(.top, 27)
            .padding(.bottom, 24)
        }
        .settingsPage(title: "供应商与 Key", onBack: onClose)
    }

    private var addProviderSection: some View {
        Group {
            SettingsCard {
                Button { editing = .new } label: {
                    SettingsRowLabel(icon: "", title: "添加供应商",
                                     detail: "设置 Endpoint、API Key 和模型")
                }
                .buttonStyle(.plain)
            }
            SettingsNote(text: UIDevice.current.userInterfaceIdiom == .pad
                ? "供本地聊天使用，配置加密保存在这台平板上。导入或从电脑读取会替换现有 API 配置，聊天记录不受影响。"
                : "供本地聊天使用，配置加密保存在这台手机上。导入或从电脑读取会替换现有 API 配置，聊天记录不受影响。")
        }
    }

    @ViewBuilder private var providerSection: some View {
        if local.providers.isEmpty {
            VStack(spacing: 0) {
                Text("暂无供应商")
                    .font(.system(size: Palette.textDisplay, weight: .medium))
                    .foregroundColor(Palette.ink)
                Text("手动添加、粘贴导入，或从已连接的电脑读取。")
                    .font(.system(size: Palette.textBody))
                    .foregroundColor(Palette.muted)
                    .multilineTextAlignment(.center)
                    .padding(.top, 8)
                Button("添加供应商") { editing = .new }
                    .font(.system(size: Palette.textInput, weight: .medium))
                    .foregroundColor(Palette.ink)
                    .padding(.horizontal, 20)
                    .frame(minHeight: 48)
                    .background(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                        .fill(Palette.field))
                    .padding(.top, 20)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 20)
            .padding(.top, 50)
            .padding(.bottom, 20)
            .accessibilityElement(children: .contain)
        } else {
            SettingsGroupLabel(title: "我的供应商")
            ForEach(local.providers) { provider in
                ProviderCard(provider: provider,
                             edit: { editing = .edit(provider) },
                             remove: { prompt = .delete(provider) })
                    .environmentObject(local)
                    .padding(.bottom, 12)
            }
        }
    }

    private var transferSection: some View {
        Group {
            SettingsGroupLabel(title: "配置迁移")
            SettingsCard {
                Button(action: importFromComputer) {
                    SettingsRowLabel(icon: "", title: "从电脑导入",
                                     detail: computerImportDetail)
                }
                .buttonStyle(.plain)
                SettingsDivider(leading: 16)
                Button { importing = true } label: {
                    SettingsRowLabel(icon: "", title: "粘贴导入",
                                     detail: "兼容电脑端配置，不影响聊天记录")
                }
                .buttonStyle(.plain)
                SettingsDivider(leading: 16)
                Button { prompt = .export } label: {
                    SettingsRowLabel(icon: "", title: "复制导出",
                                     detail: "包含 API Key，仅粘贴到可信设备")
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var pairedComputers: [PairedComputer] {
        model.computers.filter(\.isPaired)
    }

    private func importFromComputer() {
        if pairedComputers.count == 1, let computer = pairedComputers.first {
            prompt = .importFrom(computer)
        } else if !pairedComputers.isEmpty {
            choosingComputer = true
        } else {
            prompt = .notice(LocalChatModel.Notice(
                text: "请先在主界面连接并配对此电脑。", serious: false))
        }
    }

    private var computerImportDetail: String {
        if pairedComputers.isEmpty { return "连接电脑后可读取其 API Key 配置" }
        if pairedComputers.count > 1 { return "从已配对的电脑中选择要读取的一台" }
        guard let computer = pairedComputers.first else { return "读取已连接电脑端的 API Key 与模型配置" }
        return locale.identifier.lowercased().hasPrefix("zh")
            ? "使用「\(computer.displayName)」的 API Key 与模型配置"
            : "Uses API keys and models from “\(computer.displayName)”"
    }

    private func promptTitle(_ value: ProviderPrompt) -> String {
        switch value {
        case .delete: return "移除供应商？"
        case .importFrom: return "导入 API 配置？"
        case .export: return "复制包含密钥的配置？"
        case .notice(let notice): return notice.serious ? "出错了" : "提示"
        }
    }

    private func promptMessage(_ value: ProviderPrompt) -> String {
        switch value {
        case .delete: return "仅删除 API 配置，保留聊天记录。"
        case .importFrom(let computer):
            let count = local.providers.count
            let isPad = UIDevice.current.userInterfaceIdiom == .pad
            if locale.identifier.lowercased().hasPrefix("zh") {
                let device = isPad ? "这台平板" : "这台手机"
                return count == 0
                    ? "将读取「\(computer.displayName)」的 API Key 与模型配置，写入\(device)。聊天记录保留。"
                    : "将用「\(computer.displayName)」的 API Key 与模型配置替换\(device)上现有的 \(count) 个供应商配置。聊天记录保留。"
            }
            let device = isPad ? "this iPad" : "this phone"
            return count == 0
                ? "API keys and models are read from “\(computer.displayName)” onto \(device). Chats are kept."
                : "API keys and models from “\(computer.displayName)” replace the \(count) provider configurations stored on \(device). Chats are kept."
        case .export: return "导出包含明文 API Key。仅粘贴到可信设备，不要发送给他人；剪贴板可能被其他应用读取。"
        case .notice(let notice): return notice.text
        }
    }

    private func promptConfirmTitle(_ value: ProviderPrompt) -> String {
        switch value {
        case .delete: return "移除"
        case .importFrom: return "导入"
        case .export: return "复制"
        case .notice: return "好"
        }
    }

    private func promptCancelTitle(_ value: ProviderPrompt) -> String? {
        if case .notice = value { return nil }
        return "取消"
    }

    private func acceptPrompt(_ value: ProviderPrompt) {
        prompt = nil
        switch value {
        case .delete(let provider): local.removeProvider(provider.id)
        case .importFrom(let computer): model.importApiKeys(from: computer, into: local)
        case .export: copyExport()
        case .notice: break
        }
    }

    private func copyExport() {
        Task {
        guard let text = await local.exportConfig() else { return }
        guard text.lengthOfBytes(using: .utf8) <= 400 * 1024 else {
            DispatchQueue.main.async {
                prompt = .notice(LocalChatModel.Notice(
                    text: "配置过大，无法安全复制到系统剪贴板。请减少配置后重试。", serious: true))
            }
            return
        }
        UIPasteboard.general.string = text
        DispatchQueue.main.async {
            prompt = .notice(LocalChatModel.Notice(
                text: "已复制配置（含密钥），请妥善保管。", serious: false))
        }
            }
    }

    private func adoptNotice() {
        guard let notice = local.notice else { return }
        local.notice = nil
        prompt = .notice(notice)
    }

}

private enum ProviderPrompt {
    case delete(LocalProviderDefinition)
    case importFrom(PairedComputer)
    case export
    case notice(LocalChatModel.Notice)
}

private struct ProviderCard: View {
    @EnvironmentObject private var local: LocalChatModel
    @Environment(\.locale) private var locale

    let provider: LocalProviderDefinition
    let edit: () -> Void
    let remove: () -> Void

    var body: some View {
        SettingsCard {
            Toggle(isOn: enabled) {
                HStack(spacing: 14) {
                    Image(systemName: "key")
                        .font(.system(size: Palette.textDialog))
                        .foregroundColor(Palette.ink)
                        .frame(width: 26, height: 26)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(provider.name)
                            .font(.system(size: Palette.textRowStrong))
                            .foregroundColor(Palette.ink)
                        Text(provider.baseURL)
                            .font(.system(size: Palette.textNote))
                            .foregroundColor(Palette.secondary)
                            .lineLimit(1)
                    }
                }
            }
            .toggleStyle(SwitchToggleStyle(tint: Palette.accent))
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            SettingsDivider()
            Button(action: edit) {
                SettingsRowLabel(icon: "slider.horizontal.3", title: "模型与密钥",
                                 detail: providerDetail)
            }
            .buttonStyle(.plain)
            SettingsDivider()
            Button(action: remove) {
                SettingsRowLabel(icon: "trash", title: "移除供应商",
                                 showsChevron: false, destructive: true)
            }
            .buttonStyle(.plain)
        }
    }

    private var enabled: Binding<Bool> {
        Binding(get: {
            local.providers.first(where: { $0.id == provider.id })?.enabled ?? provider.enabled
        }, set: {
            local.setProvider(provider.id, enabled: $0)
        })
    }

    private var protocolLabel: String {
        switch provider.protocolName {
        case "anthropic": return "Anthropic"
        case "dual": return "Dual"
        default: return "OpenAI"
        }
    }

    private var providerDetail: String {
        if locale.identifier.lowercased().hasPrefix("zh") {
            return "\(protocolLabel) · \(provider.models.count) 个模型 · \(provider.keys.count) 个密钥"
        }
        return "\(protocolLabel) · \(provider.models.count) models · \(provider.keys.count) keys"
    }
}

private enum ProviderEditorTarget: Identifiable {
    case new
    case edit(LocalProviderDefinition)

    var id: String {
        switch self {
        case .new: return "new"
        case .edit(let provider): return provider.id
        }
    }

    var provider: LocalProviderDefinition? {
        if case .edit(let provider) = self { return provider }
        return nil
    }
}

private struct ProviderEditorView: View {
    @EnvironmentObject private var local: LocalChatModel
    @Environment(\.presentationMode) private var presentation

    private let originalID: String
    private let originalModels: [LocalProviderDefinition.Model]
    @State private var name: String
    @State private var baseURL: String
    @State private var anthropicBaseURL: String
    @State private var protocolName: String
    @State private var enabled: Bool
    @State private var existingKeys: [LocalProviderDefinition.Key]
    @State private var replacementKeys: [ProviderKeyDraft]
    @State private var modelLines: String
    @State private var choosingProtocol = false
    @State private var failure = ""
    @State private var editingKeys = false

    init(provider: LocalProviderDefinition?) {
        originalID = provider?.id ?? ""
        originalModels = provider?.models ?? []
        _name = State(initialValue: provider?.name ?? "")
        _baseURL = State(initialValue: provider?.baseURL ?? "https://")
        _anthropicBaseURL = State(initialValue: provider?.anthropicBaseURL ?? "")
        _protocolName = State(initialValue: provider?.protocolName ?? "openai")
        _enabled = State(initialValue: provider?.enabled ?? true)
        _existingKeys = State(initialValue: provider?.keys ?? [])
        _replacementKeys = State(initialValue: [ProviderKeyDraft()])
        _modelLines = State(initialValue: (provider?.models ?? []).map {
            $0.id == $0.upstream ? $0.id : "\($0.id)=\($0.upstream)"
        }.joined(separator: "\n"))
    }

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Palette.divider)
                .frame(width: 36, height: 4)
                .padding(.bottom, 16)
                .accessibilityHidden(true)

            ScrollViewReader { proxy in
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(LocalizedStringKey(originalID.isEmpty ? "添加供应商" : "编辑供应商"))
                            .font(.system(size: Palette.textDisplay, weight: .medium))
                            .foregroundColor(Palette.ink)
                            .padding(.horizontal, 8)
                            .padding(.top, 4)
                            .padding(.bottom, 6)
                        fieldLabel("供应商名称")
                        textField("名称", text: $name)
                        fieldLabel("Endpoint")
                        textField("https://", text: $baseURL)

                        fieldLabel("API 协议")
                        Button(action: openProtocolChoice) {
                            HStack {
                                Text(protocolDisplay)
                                Spacer()
                                Image(systemName: "chevron.right")
                            }
                            .foregroundColor(Palette.ink)
                            .padding(.horizontal, 16)
                            .frame(minHeight: 52)
                            .background(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                                .fill(Palette.field))
                            .overlay(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                                .stroke(Palette.fieldBorder, lineWidth: 1))
                        }
                        .buttonStyle(.plain)

                        fieldLabel("Anthropic Endpoint（可选）")
                        textField("https://", text: $anthropicBaseURL)

                        if !existingKeys.isEmpty {
                            fieldLabel("已有密钥")
                            SettingsCard {
                                ForEach(existingKeys.indices, id: \.self) { index in
                                    if index > 0 { SettingsDivider() }
                                    Toggle(isOn: $existingKeys[index].enabled) {
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text("Key \(index + 1)").foregroundColor(Palette.ink)
                                            Text(existingKeys[index].masked)
                                                .font(.system(size: Palette.textNote))
                                                .foregroundColor(Palette.secondary)
                                        }
                                    }
                                    .toggleStyle(SwitchToggleStyle(tint: Palette.accent))
                                    .padding(.horizontal, 16)
                                    .frame(minHeight: 58)
                                }
                            }
                            Text("关闭后保留密钥，但不参与请求或重试；点击保存后生效。按列表顺序使用已启用密钥，全部关闭时此供应商的模型不可用。")
                                .font(.system(size: Palette.textNote))
                                .foregroundColor(Palette.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        fieldLabel("API Key（每行一个）")
                        SecureKeyLines(keys: $replacementKeys,
                                       placeholder: existingKeys.isEmpty
                                            ? "输入 API Key" : "留空保留已有密钥；填写则替换") { focused in
                            editingKeys = focused
                            if focused { withAnimation { proxy.scrollTo("provider-keys", anchor: .bottom) } }
                        }
                        .id("provider-keys")

                        fieldLabel("模型（每行一个 ID，或 别名=上游模型）")
                        PlainCodeTextEditor(text: $modelLines)
                            .accessibilityLabel(Text("模型（每行一个 ID，或 别名=上游模型）"))
                            .frame(minHeight: 120, maxHeight: 180)
                            .padding(10)
                            .background(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                                .fill(Palette.field))
                            .overlay(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                                .stroke(Palette.fieldBorder, lineWidth: 1))

                        if !failure.isEmpty {
                            Text(LocalizedStringKey(failure))
                                .font(.system(size: Palette.textNote))
                                .foregroundColor(Palette.error)
                                .accessibilityAddTraits(.updatesFrequently)
                                .id("provider-error")
                        }
                    }
                    .padding(.top, 4)
                    .padding(.bottom, 8)
                }
                .onChange(of: failure) { next in
                    guard !next.isEmpty else { return }
                    withAnimation { proxy.scrollTo("provider-error", anchor: .bottom) }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                    if editingKeys { withAnimation { proxy.scrollTo("provider-keys", anchor: .bottom) } }
                }
            }
            VStack(spacing: 8) {
                SettingsDialogAction(title: "保存", primary: true, action: save)
                SettingsDialogAction(title: "取消", primary: false) { presentation.wrappedValue.dismiss() }
            }
            .padding(.top, 12)
        }
        .padding(.horizontal, 18)
        .padding(.top, 14)
        .padding(.bottom, 18)
        .background(Palette.grouped.ignoresSafeArea())
        .overlay(alignment: .bottom) {
            if choosingProtocol {
                ZStack(alignment: .bottom) {
                    Color.black.opacity(0.28).ignoresSafeArea()
                        .onTapGesture { choosingProtocol = false }
                    SettingsChoicePanel(title: "API 协议", labels: ["OpenAI", "Anthropic", "Dual"],
                                        selected: ["openai", "anthropic", "dual"].firstIndex(of: protocolName) ?? 0,
                                        onChoose: { index in
                                            protocolName = ["openai", "anthropic", "dual"][index]
                                            choosingProtocol = false
                                        },
                                        onCancel: { choosingProtocol = false })
                        .frame(maxWidth: 560)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 12)
                }
            }
        }
        .onDisappear { replacementKeys = [] }
    }

    private func openProtocolChoice() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        choosingProtocol = true
    }

    private var protocolDisplay: String {
        switch protocolName {
        case "anthropic": return "Anthropic"
        case "dual": return "Dual"
        default: return "OpenAI"
        }
    }

    private func fieldLabel(_ value: String) -> some View {
        Text(LocalizedStringKey(value))
            .font(.system(size: Palette.textNote))
            .foregroundColor(Palette.secondary)
            .padding(.leading, 2)
    }

    private func textField(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(LocalizedStringKey(placeholder), text: text)
            .autocapitalization(.none)
            .disableAutocorrection(true)
            .padding(.horizontal, 16)
            .frame(minHeight: 52)
            .background(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                .fill(Palette.field))
            .overlay(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                .stroke(Palette.fieldBorder, lineWidth: 1))
    }

    private func save() {
        let replacements = replacementKeys.map { ComposerText.androidTrim($0.value) }
            .filter { !$0.isEmpty }
        var keys = existingKeys
        if !replacements.isEmpty {
            keys = replacements.map {
                LocalProviderDefinition.Key(id: UUID().uuidString.lowercased(), secret: $0, enabled: true)
            }
        }
        let models = modelLines.components(separatedBy: "\n").compactMap { line -> LocalProviderDefinition.Model? in
            let trimmedLine = ComposerText.androidTrim(line)
            guard !trimmedLine.isEmpty else { return nil }
            let parts = trimmedLine.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let id = ComposerText.androidTrim(String(parts[0]))
            guard !id.isEmpty else { return nil }
            let upstream = parts.count == 2
                ? ComposerText.androidTrim(String(parts[1])) : id
            let wireProtocol = originalModels.first(where: { $0.id == id })?.wireProtocol ?? "auto"
            return LocalProviderDefinition.Model(id: id, upstream: upstream, wireProtocol: wireProtocol)
        }
        let value = LocalProviderDefinition(id: originalID, name: name, baseURL: baseURL,
                                            anthropicBaseURL: anthropicBaseURL,
                                            protocolName: protocolName, enabled: enabled,
                                            keys: keys, models: models)
        Task {
            if let problem = await local.saveProvider(value) { failure = problem }
            else { presentation.wrappedValue.dismiss() }
        }
    }
}

private struct ProviderKeyDraft: Identifiable {
    let id = UUID()
    var value = ""
}

struct SettingsDialogAction: View {
    let title: String
    let primary: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(LocalizedStringKey(title))
                .font(.system(size: Palette.textRow, weight: .medium))
                .foregroundColor(primary ? Palette.card : Palette.ink)
                .frame(maxWidth: .infinity)
                .frame(minHeight: 52)
                .background(RoundedRectangle(cornerRadius: Palette.dialogActionRadius, style: .continuous)
                    .fill(primary ? Palette.ink : Palette.card))
        }
        .buttonStyle(.plain)
    }
}

struct SettingsMessagePanel: View {
    let title: String
    let message: String
    let confirmTitle: String
    let cancelTitle: String?
    let onConfirm: () -> Void
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
            Text(LocalizedStringKey(message))
                .font(.system(size: Palette.textInput))
                .foregroundColor(Palette.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(RoundedRectangle(cornerRadius: Palette.groupRadius, style: .continuous)
                    .fill(Palette.card))
            VStack(spacing: 8) {
                SettingsDialogAction(title: confirmTitle, primary: true, action: onConfirm)
                if let cancelTitle {
                    SettingsDialogAction(title: cancelTitle, primary: false, action: onCancel)
                }
            }
            .padding(.top, 12)
        }
        .padding(.horizontal, 18)
        .padding(.top, 14)
        .padding(.bottom, 18)
        .background(RoundedRectangle(cornerRadius: Palette.sheetRadius, style: .continuous)
            .fill(Palette.grouped))
    }
}

/// UITextView advertises secure entry but can expose a preceding line after
/// Return. Keep each line in a real single-line secure input inside one
/// outlined block; Return advances to a new line as on Android.
private struct SecureKeyLines: View {
    @Binding var keys: [ProviderKeyDraft]
    let placeholder: String
    let focusChanged: (Bool) -> Void
    @State private var focusedLine: UUID?

    private let minimumHeight: CGFloat = 78
    private let maximumHeight: CGFloat = 132

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 0) {
                ForEach($keys) { $entry in
                    HStack(spacing: 8) {
                        SecureKeyLine(text: $entry.value,
                                      placeholder: keys.first?.id == entry.id ? placeholder : "",
                                      focused: focusedLine == entry.id,
                                      onFocus: { focusedLine = entry.id },
                                      onBlur: {
                                          if focusedLine == entry.id { focusedLine = nil }
                                      },
                                      onReturn: { addLine(after: entry.id) },
                                      onPastedLines: { splitPastedLines(id: entry.id, text: $0) })
                            .frame(height: 24)
                            .overlay(alignment: .leading) {
                                if focusedLine != entry.id && !entry.value.isEmpty {
                                    Text(String(repeating: "•", count: entry.value.count))
                                        .font(.system(size: Palette.textInput))
                                        .foregroundColor(Palette.ink)
                                        .lineLimit(1)
                                        .truncationMode(.head)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .frame(height: 24)
                                        .background(Palette.field)
                                        .allowsHitTesting(false)
                                        .accessibilityHidden(true)
                                }
                            }
                        if keys.count > 1 {
                            Button { removeLine(entry.id) } label: {
                                Image(systemName: "minus.circle")
                                    .font(.system(size: 18))
                                    .foregroundColor(Palette.secondary)
                            }
                            .accessibilityLabel(Text("移除 Key"))
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(height: min(maximumHeight, max(minimumHeight, CGFloat(keys.count) * 24 + 24)))
        .background(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
            .fill(Palette.field))
        .overlay(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
            .stroke(Palette.fieldBorder, lineWidth: 1))
        .onChange(of: focusedLine) { focusChanged($0 != nil) }
    }

    private func addLine(after id: UUID) {
        guard let index = keys.firstIndex(where: { $0.id == id }) else { return }
        if index + 1 < keys.count {
            focusedLine = keys[index + 1].id
        } else {
            let next = ProviderKeyDraft()
            keys.append(next)
            DispatchQueue.main.async { focusedLine = next.id }
        }
    }

    private func removeLine(_ id: UUID) {
        keys.removeAll { $0.id == id }
        if focusedLine == id { focusedLine = keys.last?.id }
    }

    private func splitPastedLines(id: UUID, text: String) {
        guard text.contains("\n"),
              let index = keys.firstIndex(where: { $0.id == id }) else { return }
        let lines = text.components(separatedBy: "\n")
        keys[index].value = lines[0]
        keys.insert(contentsOf: lines.dropFirst().map { ProviderKeyDraft(value: $0) }, at: index + 1)
        focusedLine = keys[index + lines.count - 1].id
    }
}

/// UIKit's single-line secure field keeps selection and masking native; unlike
/// a secure UITextView, it cannot reveal an earlier line after Return.
private struct SecureKeyLine: UIViewRepresentable {
    @Environment(\.locale) private var locale
    @Binding var text: String
    let placeholder: String
    let focused: Bool
    let onFocus: () -> Void
    let onBlur: () -> Void
    let onReturn: () -> Void
    let onPastedLines: (String) -> Void

    func makeUIView(context: Context) -> UITextField {
        let view = UITextField()
        view.delegate = context.coordinator
        view.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        view.isSecureTextEntry = true
        view.textContentType = nil
        view.autocorrectionType = .no
        view.spellCheckingType = .no
        view.smartDashesType = .no
        view.smartQuotesType = .no
        view.keyboardType = .asciiCapable
        view.returnKeyType = .next
        view.font = .systemFont(ofSize: Palette.textInput)
        view.textColor = Palette.inkUI
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: UITextField, context: Context) {
        context.coordinator.parent = self
        let hint: String
        if locale.identifier.lowercased().hasPrefix("zh") {
            hint = placeholder
        } else {
            switch placeholder {
            case "输入 API Key": hint = "Enter API key"
            case "留空保留已有密钥；填写则替换": hint = "Leave blank to keep keys; enter to replace"
            default: hint = placeholder
            }
        }
        if view.placeholder != hint { view.placeholder = hint }
        if view.text != text { view.text = text }
        view.textColor = focused ? Palette.inkUI : .clear
        if focused && !view.isFirstResponder {
            DispatchQueue.main.async {
                if context.coordinator.parent.focused { view.becomeFirstResponder() }
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: SecureKeyLine

        init(_ parent: SecureKeyLine) { self.parent = parent }

        @objc func changed(_ view: UITextField) { parent.text = view.text ?? "" }

        func textFieldDidBeginEditing(_ textField: UITextField) { parent.onFocus() }
        func textFieldDidEndEditing(_ textField: UITextField) { parent.onBlur() }

        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            parent.onReturn()
            return false
        }

        func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange,
                       replacementString string: String) -> Bool {
            guard string.contains("\n") else { return true }
            let next = ((textField.text ?? "") as NSString).replacingCharacters(in: range, with: string)
            parent.onPastedLines(next)
            return false
        }
    }
}

// MARK: - Import

/// The paste door into the provider configuration.
///
/// A full JSON document does not fit a `TextField`; keep validation errors in
/// this bottom panel so the user can correct the paste without reopening it.
struct ConfigImportView: View {
    @EnvironmentObject private var local: LocalChatModel
    let onClose: () -> Void

    @State private var text = ""
    @State private var failure: String?

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Palette.divider)
                .frame(width: 36, height: 4)
                .padding(.bottom, 16)
                .accessibilityHidden(true)
            ScrollViewReader { proxy in
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("粘贴导入")
                            .font(.system(size: Palette.textDisplay, weight: .medium))
                            .foregroundColor(Palette.ink)
                            .padding(.horizontal, 8)
                            .padding(.top, 4)
                            .padding(.bottom, 6)
                        Text("粘贴完整的 Camellia v2 配置。导入会替换供应商与密钥，不删除会话。")
                            .font(.system(size: Palette.textBody))
                            .foregroundColor(Palette.secondary)
                            .fixedSize(horizontal: false, vertical: true)

                        Text("JSON")
                            .font(.system(size: Palette.textNote))
                            .foregroundColor(Palette.secondary)
                        PlainCodeTextEditor(text: $text)
                            .accessibilityLabel(Text("JSON"))
                            .frame(height: 180)
                            .padding(10)
                            .background(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                                .fill(Palette.field))
                            .overlay(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                                .stroke(Palette.fieldBorder, lineWidth: 1))

                        if let failure {
                            Text(LocalizedStringKey(failure))
                                .font(.system(size: Palette.textNote))
                                .foregroundColor(Palette.error)
                                .accessibilityAddTraits(.updatesFrequently)
                                .id("import-error")
                        }
                    }
                    .padding(.top, 4)
                    .padding(.bottom, 8)
                }
                .frame(maxHeight: 350)
                .onChange(of: failure) { value in
                    guard value != nil else { return }
                    withAnimation { proxy.scrollTo("import-error", anchor: .bottom) }
                }
            }
            VStack(spacing: 8) {
                SettingsDialogAction(title: "替换配置", primary: true, action: commit)
                SettingsDialogAction(title: "取消", primary: false, action: onClose)
            }
            .padding(.top, 12)
        }
        .padding(.horizontal, 18)
        .padding(.top, 14)
        .padding(.bottom, 18)
        .background(RoundedRectangle(cornerRadius: Palette.sheetRadius, style: .continuous)
            .fill(Palette.grouped))
    }

    /// Imports and, on success, closes.
    ///
    /// The model returns validation failures directly, while successful
    /// imports publish the normal status notice after this panel closes.
    private func commit() {
        Task {
            if let problem = await local.importConfig(text) { failure = problem }
            else { onClose() }
        }
    }
}

/// Android disables suggestions for model IDs and JSON. SwiftUI's TextEditor
/// still converted typed ASCII quotes to smart quotes in the simulator, making
/// valid JSON fail to import. These two code-like fields keep their existing
/// SwiftUI frame and surface while UIKit supplies the exact input traits.
private struct PlainCodeTextEditor: UIViewRepresentable {
    @Binding var text: String

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.font = .monospacedSystemFont(ofSize: Palette.textInput, weight: .regular)
        view.textColor = Palette.inkUI
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.autocorrectionType = .no
        view.spellCheckingType = .no
        view.autocapitalizationType = .none
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.smartInsertDeleteType = .no
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text { view.text = text }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: PlainCodeTextEditor

        init(_ parent: PlainCodeTextEditor) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
        }
    }
}

// MARK: - Archive

/// The conversations the list is told to hide.
///
/// Archiving is reversible on purpose — the store keeps the conversation and
/// only flips a flag — so this screen is the undo, and permanent deletion is a
/// second, deliberate step rather than what the swipe does.
struct LocalChatArchiveView: View {
    @EnvironmentObject private var local: LocalChatModel

    @State private var deleting: LocalChatConversation?

    var body: some View {
        ZStack(alignment: .bottom) {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 0) {
                    SettingsNote(text: "归档会保留聊天记录，恢复后可继续对话。远程归档由电脑端管理。")

                    if local.archived.isEmpty {
                        VStack(spacing: 0) {
                            Text("暂无已归档会话")
                                .font(.system(size: Palette.textDisplay, weight: .medium))
                                .foregroundColor(Palette.ink)
                            Text("在本地聊天列表长按会话，即可将它归档到这里。")
                                .font(.system(size: Palette.textNote))
                                .foregroundColor(Palette.muted)
                                .multilineTextAlignment(.center)
                                .lineLimit(1)
                                .minimumScaleFactor(0.9)
                                .padding(.top, 8)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 20)
                        .padding(.top, 40)
                        .padding(.bottom, 36)
                        .accessibilityElement(children: .combine)
                    } else {
                        ForEach(local.archived) { conversation in
                            SettingsCard {
                                ArchiveRow(conversation: conversation)
                                SettingsDivider()
                                Button { local.restore(conversation.id) } label: {
                                    SettingsRowLabel(icon: "arrow.uturn.backward", title: "恢复会话",
                                                     showsChevron: false)
                                }
                                .buttonStyle(.plain)
                                SettingsDivider()
                                Button(role: .destructive) { deleting = conversation } label: {
                                    SettingsRowLabel(icon: "trash", title: "永久删除",
                                                     showsChevron: false, destructive: true)
                                }
                                .buttonStyle(.plain)
                            }
                            .padding(.bottom, 14)
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 17)
                .padding(.bottom, 24)
            }
            .settingsPage(title: "已归档")
            if let target = deleting {
                Color.black.opacity(0.28).ignoresSafeArea()
                    .onTapGesture { deleting = nil }
                SettingsMessagePanel(title: "永久删除此会话？",
                                     message: "聊天记录将被删除，无法恢复。",
                                     confirmTitle: "删除", cancelTitle: "取消",
                                     onConfirm: {
                                         deleting = nil
                                         Task { await local.delete([target.id]) }
                                     }, onCancel: { deleting = nil })
                    .frame(maxWidth: 560)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
            }
        }
    }
}

private struct ArchiveRow: View {
    @Environment(\.locale) private var locale
    let conversation: LocalChatConversation

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(conversation.displayTitle(in: locale, archived: true))
                .font(.system(size: Palette.textRowStrong))
                .foregroundColor(Palette.ink)
            Text("本地会话 · 已归档")
                .font(.system(size: Palette.textBody))
                .foregroundColor(Palette.secondary)
                .padding(.top, 5)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
    }
}
