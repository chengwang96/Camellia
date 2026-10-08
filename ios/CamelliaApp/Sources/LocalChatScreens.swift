import SwiftUI
import UIKit

// MARK: - List

/// The conversations this phone owns.
///
/// Laid out as workspaces with their conversations under them, which is what
/// Android's local list does and what the store's own ordering already assumes.
/// The list is the only place a conversation can be managed: like Android, the
/// detail page carries no menu, so rename, pin, archive and delete all live in
/// the row's long press rather than in two places that can disagree.
struct LocalChatListView: View {
    @EnvironmentObject private var model: LocalChatModel
    @EnvironmentObject private var app: AppModel
    @Environment(\.locale) private var locale

    /// Workspaces the user has folded away, for this visit only.
    ///
    /// Android persists this per computer. Local chat has no computer to key it
    /// on and the store has no field for it, so it is deliberately session
    /// state rather than a new thing to seal and migrate.
    @State private var collapsed: Set<String> = []

    @State private var alert: ListAlert?
    @State private var queuedNotice: LocalChatModel.Notice?
    @State private var promptText = ""
    @State private var promptError: String?
    @State private var workspaceMenu: LocalChatWorkspace?
    @State private var selecting = false
    @State private var selection: Set<String> = []
    @State private var query = ""
    @State private var pushTarget: LocalChatConversation?
    @State private var pushActive = false

    /// The "no model yet" state has to be able to reach the page that fixes it.
    /// Until this existed the empty state named that page and offered no way to
    /// get there, which is the same dead end Android had.
    @State private var showingProviders = false

    var body: some View {
        list
        .background(Palette.background.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) { dock }
        .background(pushLink)
        .sheet(isPresented: $showingProviders) {
            // Wrapped so it can be closed without a back button of its own: the
            // point of this sheet is one tap to the fix and one tap back.
            NavigationView { ProviderSettingsView(onClose: { showingProviders = false }) }
                .navigationViewStyle(.stack)
        }
        // Storage notices still use one native presenter on iOS 15; edit and
        // delete forms use Android-style panels with field-local validation.
        .alert(noticeTitle, isPresented: noticePresented) {
            Button("好") { finishAlert() }
        } message: {
            Text(LocalizedStringKey(noticeMessage))
        }
        .onAppear { adoptNotice() }
        .onChange(of: model.notice) { _ in adoptNotice() }
        .onChange(of: model.openId) { id in
            if id == nil { adoptNotice() }
        }
        .overlay(alignment: .bottom) { listActionPanel }
    }

    private var list: some View {
        List {
            if model.routes.isEmpty, model.routeError == nil {
                VStack(spacing: 0) {
                    Text("还没有可用的模型")
                        .font(.system(size: Palette.textDisplay, weight: .medium))
                        .foregroundColor(Palette.ink)
                    Text(LocalizedStringKey(UIDevice.current.userInterfaceIdiom == .pad
                        ? "先添加一个供应商和 API Key，聊天才能开始。配置只保存在这台平板上。"
                        : "先添加一个供应商和 API Key，聊天才能开始。配置只保存在这台手机上。"))
                        .font(.system(size: Palette.textBody))
                        .foregroundColor(Palette.muted)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .minimumScaleFactor(0.9)
                        .padding(.top, 8)
                    Button("前往供应商与 Key") { showingProviders = true }
                        .font(.system(size: Palette.textInput))
                        .foregroundColor(Palette.ink)
                        .frame(minHeight: 48)
                        .padding(.top, 20)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 18)
                .padding(.top, 28)
                .padding(.bottom, 12)
                .background(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                    .fill(Palette.field))
                .overlay(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                    .strokeBorder(Palette.divider, lineWidth: 1))
                .accessibilityElement(children: .contain)
                .padding(.top, 20)
                .plainPageRow()
            }

            if selecting { selectionRow }
            workspaceHeading

            if model.routes.isEmpty == false, query.isEmpty,
               model.workspaces.isEmpty, model.conversations.isEmpty {
                EmptyStateView(mark: .new, title: "开始第一段对话",
                               message: "你的问题、想法和图片，都可以从这里开始。") {
                    EmptyStateActionButton(title: "新建会话") { startConversation(in: "") }
                }
                .plainPageRow()
            }

            ForEach(model.workspaces) { workspace in
                let rows = filtered(model.conversations(in: workspace.id))
                if query.isEmpty || !rows.isEmpty {
                    workspaceHeader(workspace)
                        .plainPageRow()
                    if !collapsed.contains(workspace.id) || !query.isEmpty {
                        if rows.isEmpty, query.isEmpty {
                            Text("暂无会话")
                                .font(.system(size: Palette.textNote))
                                .foregroundColor(Palette.muted)
                                .padding(.leading, 32)
                                .padding(.vertical, 8)
                                .plainPageRow()
                        }
                        ForEach(rows) { conversation in row(conversation, grouped: true) }
                    }
                }
            }

            let standaloneRows = filtered(model.unfiled)
            if query.isEmpty || !standaloneRows.isEmpty {
                standaloneHeader
                    .plainPageRow()
                if !collapsed.contains("") || !query.isEmpty {
                    if standaloneRows.isEmpty, query.isEmpty {
                        Text("暂无会话")
                            .font(.system(size: Palette.textNote))
                            .foregroundColor(Palette.muted)
                            .padding(.leading, 2)
                            .padding(.vertical, 8)
                            .plainPageRow()
                    }
                    ForEach(standaloneRows) { conversation in row(conversation, grouped: false) }
                }
            }

            if !query.isEmpty, filtered(model.conversations).isEmpty {
                EmptyStateView(mark: .search, title: "没有找到会话",
                               message: "试试更短的关键词，或清除搜索查看全部会话。") {
                    EmptyStateActionButton(title: "清除搜索") { query = "" }
                }
                .plainPageRow()
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 0)
        .padding(.horizontal, PageGutter.horizontal)
        .padding(.bottom, PageGutter.contentBottom)
        .background(Palette.background)
        .plainPageBackground()
    }

    private var workspaceHeading: some View {
        HStack(spacing: 0) {
            Text("工作区")
                .font(.system(size: Palette.textBody, weight: .medium))
                .foregroundColor(Palette.muted)
            Spacer(minLength: 8)
            Button {
                promptText = ""
                promptError = nil
                alert = .text(.newWorkspace)
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: Palette.textTitle))
                    .foregroundColor(Palette.muted)
                    .frame(width: 48, height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("新建工作区")
        }
        .frame(minHeight: 48)
        .padding(.top, 12)
        .plainPageRow()
    }

    /// A workspace's heading doubles as its controls: fold, add a conversation,
    /// and rename or remove the workspace itself.
    private func workspaceHeader(_ workspace: LocalChatWorkspace) -> some View {
        HStack(spacing: 0) {
            Image(systemName: "folder")
                .font(.system(size: Palette.textRowStrong))
                .foregroundColor(Palette.ink)
                .frame(width: 20, height: 24)
                .padding(.leading, 2)
                .padding(.trailing, 10)
            Button {
                if collapsed.contains(workspace.id) {
                    collapsed.remove(workspace.id)
                } else {
                    collapsed.insert(workspace.id)
                }
            } label: {
                HStack(spacing: 6) {
                    Text(workspace.displayName)
                        .font(.system(size: Palette.textRow, weight: .medium))
                        .foregroundColor(Palette.ink)
                        .lineLimit(1)
                    Image(systemName: collapsed.contains(workspace.id) && query.isEmpty ? "chevron.right" : "chevron.down")
                        .font(.system(size: Palette.textNote, weight: .semibold))
                        .foregroundColor(Palette.muted)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(locale.identifier.lowercased().hasPrefix("zh")
                ? "\(collapsed.contains(workspace.id) ? "展开" : "折叠") \(workspace.displayName)"
                : "\(collapsed.contains(workspace.id) ? "Expand" : "Collapse") \(workspace.displayName)")

            Spacer(minLength: 8)

            Button { workspaceMenu = workspace } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: Palette.textTitle))
                    .foregroundColor(Palette.muted)
                    .frame(width: 48, height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(locale.identifier.lowercased().hasPrefix("zh")
                ? "\(workspace.displayName) 的更多操作"
                : "More actions for \(workspace.displayName)")

            Button { startConversation(in: workspace.id) } label: {
                Image(systemName: "plus.bubble")
                    .font(.system(size: Palette.textTitle))
                    .foregroundColor(Palette.muted)
                    .frame(width: 48, height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(locale.identifier.lowercased().hasPrefix("zh")
                ? "在 \(workspace.displayName) 新建会话"
                : "New chat in \(workspace.displayName)")
        }
        .frame(minHeight: 48)
        .padding(.top, 12)
        .padding(.trailing, 4)
    }

    private var standaloneHeader: some View {
        HStack(spacing: 6) {
            Button {
                if collapsed.contains("") { collapsed.remove("") } else { collapsed.insert("") }
            } label: {
                HStack(spacing: 6) {
                    Text("本机独立会话")
                        .font(.system(size: Palette.textRow, weight: .medium))
                        .foregroundColor(Palette.muted)
                    Image(systemName: collapsed.contains("") && query.isEmpty ? "chevron.right" : "chevron.down")
                        .font(.system(size: Palette.textNote, weight: .semibold))
                        .foregroundColor(Palette.muted)
                }
            }
            .buttonStyle(.plain)
            Spacer(minLength: 8)
            Button { startConversation(in: "") } label: {
                Image(systemName: "plus.bubble")
                    .font(.system(size: Palette.textTitle))
                    .foregroundColor(Palette.muted)
                    .frame(width: 48, height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("本机新建独立会话")
        }
        .frame(minHeight: 48)
        .padding(.top, 12)
        .padding(.leading, 2)
        .padding(.trailing, 4)
    }

    @ViewBuilder
    private func row(_ conversation: LocalChatConversation, grouped: Bool) -> some View {
        SwiftUI.Group {
            if selecting {
                Button { toggle(conversation.id) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: selection.contains(conversation.id) ? "checkmark.circle.fill" : "circle")
                            .foregroundColor(selection.contains(conversation.id) ? Palette.accent : Palette.muted)
                        LocalChatRow(conversation: conversation,
                                     replying: model.runningConversationId == conversation.id)
                    }
                }
                .buttonStyle(.plain)
            } else {
                NavigationLink(destination: LocalChatDetailView(conversation: conversation)
                    .environmentObject(model).environmentObject(app)) {
                    LocalChatRow(conversation: conversation,
                                 replying: model.runningConversationId == conversation.id)
                }
                .buttonStyle(.plain)
                .contextMenu { conversationActions(conversation) }
            }
        }
        .padding(.leading, grouped ? 32 : 2)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: Palette.radius, style: .continuous)
            .fill(Palette.background))
        .contentShape(Rectangle())
        .plainPageRow()
    }

    private func filtered(_ rows: [LocalChatConversation]) -> [LocalChatConversation] {
        guard !query.isEmpty else { return rows }
        return rows.filter { ComposerText.localSearchMatches(title: $0.displayTitle(in: locale),
                                                              query: query) }
    }

    private var pushLink: some View {
        NavigationLink(destination: SwiftUI.Group {
            if let conversation = pushTarget {
                LocalChatDetailView(conversation: conversation)
                    .environmentObject(model)
                    .environmentObject(app)
            }
        }, isActive: $pushActive) { EmptyView() }
            .hidden()
    }

    private func conversationActions(_ conversation: LocalChatConversation) -> some View {
        ConversationActionsMenu(pinned: conversation.pinned,
                                rename: {
                                    promptText = conversation.displayTitle(in: locale)
                                    promptError = nil
                                    alert = .text(.renameConversation(conversation))
                                }, select: {
                                    selection = [conversation.id]
                                    selecting = true
                                }, pin: { model.togglePin(conversation.id, pinned: !conversation.pinned) },
                                archive: { model.archive(conversation.id, archived: true) },
                                delete: { alert = .delete(.conversation(conversation)) })
            .disabled(model.runningConversationId == conversation.id)
    }

    private var selectionRow: some View {
        HStack(spacing: 0) {
            selectionAction("取消多选") {
                selecting = false
                selection = []
            }
            selectionAction(locale.identifier.lowercased().hasPrefix("zh") ? "删除所选（\(selection.count)）"
                            : "Delete selected (\(selection.count))",
                            enabled: !selection.isEmpty) {
                if let running = model.runningConversationId, selection.contains(running) {
                    model.notice = .init(text: "请先停止所选会话的回复。", serious: false)
                    return
                }
                alert = .delete(.selection(Array(selection)))
            }
        }
        .plainPageRow()
    }

    private func selectionAction(_ title: String, enabled: Bool = true,
                                 action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(LocalizedStringKey(title))
                .font(.system(size: Palette.textBody, weight: .medium))
                .foregroundColor(enabled ? Palette.ink : Palette.muted)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(Capsule(style: .continuous).fill(Palette.surface))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    private var dock: some View {
        VStack(spacing: 0) {
            LinearGradient(colors: [Palette.background.opacity(0), Palette.background],
                           startPoint: .top, endPoint: .bottom)
                .frame(height: 36)
                .allowsHitTesting(false)
            HStack(spacing: 0) {
                HStack(spacing: 0) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: Palette.textDialog))
                        .foregroundColor(Palette.ink)
                        .frame(width: 44, height: 44)
                    ZStack(alignment: .leading) {
                        if query.isEmpty {
                            Text("搜索本机会话")
                                .font(.system(size: Palette.textRow))
                                .foregroundColor(Palette.muted)
                                .allowsHitTesting(false)
                        }
                        TextField("", text: $query)
                            .font(.system(size: Palette.textRow))
                            .foregroundColor(Palette.ink)
                            .frame(minHeight: 48)
                            .padding(EdgeInsets(top: 0, leading: 2, bottom: 0, trailing: 8))
                    }
                }
                .frame(height: 48)
                .background(Capsule(style: .continuous).fill(Palette.background))
                .overlay(Capsule(style: .continuous).stroke(Palette.separator, lineWidth: 1))
                .shadow(color: .black.opacity(0.10), radius: 4, y: 1)
                .padding(.trailing, 10)

                Button { startConversation(in: "") } label: {
                    Image(systemName: "plus.bubble")
                        .font(.system(size: Palette.textTitle))
                        .foregroundColor(Palette.ink)
                        .frame(width: 48, height: 48)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("本机新建独立会话")
            }
            .padding(6)
            .padding(.bottom, PageGutter.dockBottom)
        }
        .background(Palette.background)
        .padding(.horizontal, PageGutter.horizontal)
    }

    private func toggle(_ id: String) {
        if selection.contains(id) { selection.remove(id) } else { selection.insert(id) }
    }

    private func startConversation(in workspace: String) {
        if let error = model.routeError {
            model.notice = LocalChatModel.Notice(text: error, serious: true)
            return
        }
        guard !model.routes.isEmpty else {
            showingProviders = true
            return
        }
        Task {
            if let conversation = await model.createConversation(workspace: workspace) {
                pushTarget = conversation
                DispatchQueue.main.async { pushActive = true }
            }
        }
    }

    // MARK: - Prompts

    private enum TextPrompt {
        case newWorkspace
        case renameWorkspace(LocalChatWorkspace)
        case renameConversation(LocalChatConversation)

        var title: String {
            switch self {
            case .newWorkspace, .renameWorkspace: return "本机工作区"
            case .renameConversation: return "重命名"
            }
        }

        var placeholder: String {
            switch self {
            case .newWorkspace, .renameWorkspace: return "工作区名称"
            case .renameConversation: return "会话标题"
            }
        }

        var maximumLength: Int {
            switch self {
            case .newWorkspace, .renameWorkspace: return 80
            case .renameConversation: return 100
            }
        }

        var invalidMessage: String {
            switch self {
            case .newWorkspace, .renameWorkspace: return "请输入 1–80 字名称"
            case .renameConversation: return "请输入 1–100 字标题"
            }
        }
    }

    private enum DeleteTarget {
        case conversation(LocalChatConversation)
        case selection([String])
    }

    private enum ListAlert {
        case text(TextPrompt)
        case delete(DeleteTarget)
        case notice(LocalChatModel.Notice)
    }

    private var noticePresented: Binding<Bool> {
        Binding(get: {
            if case .some(.notice(_)) = alert { return true }
            return false
        }, set: { if !$0 { finishAlert() } })
    }

    private var noticeTitle: String {
        guard case .some(.notice(let notice)) = alert else { return "" }
        return notice.serious ? "出错了" : "提示"
    }

    private var noticeMessage: String {
        guard case .some(.notice(let notice)) = alert else { return "" }
        return notice.text
    }

    @ViewBuilder private var listActionPanel: some View {
        if let workspace = workspaceMenu {
            ZStack(alignment: .bottom) {
                Color.black.opacity(0.28).ignoresSafeArea()
                    .onTapGesture { closeWorkspaceMenu() }
                SettingsActionListPanel(title: workspace.displayName,
                                        labels: ["重命名", "移除工作区（保留会话）"],
                                        onChoose: { index in chooseWorkspaceAction(index, workspace: workspace) })
                    .frame(maxWidth: 560)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
            }
        } else if let alert {
            switch alert {
            case .text(let prompt):
                ZStack(alignment: .bottom) {
                    Color.black.opacity(0.28).ignoresSafeArea()
                        .onTapGesture { finishAlert() }
                    SettingsTextPanel(title: prompt.title, placeholder: prompt.placeholder,
                                      text: $promptText, error: $promptError,
                                      onSave: { commitPrompt(prompt) }, onCancel: finishAlert)
                        .frame(maxWidth: 560)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 12)
                }
            case .delete(let target):
                ZStack(alignment: .bottom) {
                    Color.black.opacity(0.28).ignoresSafeArea()
                        .onTapGesture { finishAlert() }
                    SwiftUI.Group {
                        switch target {
                        case .conversation:
                            LocalConversationDeletePanel(onDelete: { commitDelete(target) },
                                                         onCancel: finishAlert)
                        case .selection:
                            SettingsMessagePanel(title: "删除所选会话？", message: deleteMessage(target),
                                                 confirmTitle: "删除", cancelTitle: "取消",
                                                 onConfirm: { commitDelete(target) },
                                                 onCancel: finishAlert)
                        }
                    }
                    .frame(maxWidth: 560)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
                }
            case .notice:
                EmptyView()
            }
        }
    }

    private func chooseWorkspaceAction(_ index: Int, workspace: LocalChatWorkspace) {
        workspaceMenu = nil
        if index == 0 {
            promptText = workspace.name
            promptError = nil
            alert = .text(.renameWorkspace(workspace))
        } else {
            model.deleteWorkspace(workspace.id)
        }
    }

    private func closeWorkspaceMenu() {
        workspaceMenu = nil
        if queuedNotice != nil { finishAlert() }
    }

    private func finishAlert() {
        alert = nil
        promptText = ""
        promptError = nil
        guard let waiting = queuedNotice else { return }
        queuedNotice = nil
        DispatchQueue.main.async { alert = .notice(waiting) }
    }

    private func adoptNotice() {
        guard !pushActive, model.openId == nil else { return }
        guard let notice = model.notice else { return }
        model.notice = nil
        if alert == nil && workspaceMenu == nil {
            alert = .notice(notice)
        } else {
            queuedNotice = notice
        }
    }

    private func commitPrompt(_ prompt: TextPrompt) {
        let value = ComposerText.androidTrim(promptText)
        guard !value.isEmpty, ComposerText.utf16Length(value) <= prompt.maximumLength else {
            promptError = prompt.invalidMessage
            return
        }
        Task {
        let saved: Bool
        switch prompt {
        case .newWorkspace:
            saved = await model.createWorkspace(name: value)
        case .renameWorkspace(let workspace):
            saved = await model.renameWorkspace(workspace.id, to: value)
        case .renameConversation(let conversation):
            saved = await model.rename(conversation.id, to: value)
        }
        if saved {
            finishAlert()
        } else {
            promptError = model.notice?.text
            model.notice = nil
        }
            }
    }

    private func deleteMessage(_ target: DeleteTarget) -> String {
        switch target {
        case .conversation:
            return "聊天记录将永久删除，此操作无法撤销。"
        case .selection(let ids):
            if ids.count == 1 { return "将永久删除此会话的聊天记录，无法撤销。" }
            return locale.identifier.lowercased().hasPrefix("zh")
                ? "将永久删除所选的 \(ids.count) 个会话，无法撤销。"
                : "Permanently deletes the \(ids.count) selected chats. This cannot be undone."
        }
    }

    private func commitDelete(_ target: DeleteTarget) {
        Task {
        switch target {
        case .conversation(let conversation):
            await model.delete([conversation.id])
        case .selection(let ids):
            if await model.delete(ids) {
                selecting = false
                selection = []
            }
        }
        finishAlert()
        }
    }
}

/// Android's single-local-chat confirmation uses text directly on the sheet,
/// followed by two equal capsule actions. Bulk deletion uses the message card.
private struct LocalConversationDeletePanel: View {
    let onDelete: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Capsule()
                .fill(Palette.divider)
                .frame(width: 36, height: 4)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 16)
                .accessibilityHidden(true)
            Text("删除本机会话？")
                .font(.system(size: Palette.textDisplay, weight: .medium))
                .foregroundColor(Palette.ink)
                .padding(.horizontal, 8)
                .padding(.top, 2)
                .accessibilityAddTraits(.isHeader)
            Text("聊天记录将永久删除，此操作无法撤销。")
                .font(.system(size: Palette.textBody))
                .foregroundColor(Palette.muted)
                .padding(.horizontal, 8)
                .padding(.top, 8)
                .padding(.bottom, 18)
            HStack(spacing: 12) {
                action("取消", primary: false, onCancel)
                action("删除", primary: true, onDelete)
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 14)
        .padding(.bottom, 18)
        .background(RoundedRectangle(cornerRadius: Palette.sheetRadius, style: .continuous)
            .fill(Palette.grouped))
    }

    private func action(_ title: String, primary: Bool, _ perform: @escaping () -> Void) -> some View {
        Button(action: perform) {
            Text(LocalizedStringKey(title))
                .font(.system(size: Palette.textInput, weight: .medium))
                .foregroundColor(primary ? .white : Palette.ink)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(Capsule(style: .continuous)
                    .fill(primary ? Palette.accent : Palette.card))
        }
        .buttonStyle(.plain)
    }
}

struct LocalChatRow: View {
    @Environment(\.locale) private var locale
    let conversation: LocalChatConversation
    let replying: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Text(conversation.displayTitle(in: locale))
                .font(.system(size: Palette.textRow))
                .foregroundColor(Palette.ink)
                .lineLimit(1)
                .frame(minHeight: 36, alignment: .leading)
            Spacer(minLength: 0)
            if replying || conversation.pinned {
                Text(replying ? "正在回复" : "已置顶")
                    .font(.system(size: Palette.textSmall))
                    .foregroundColor(Palette.accent)
                    .lineLimit(1)
            }
        }
    }
}

// MARK: - Detail

struct LocalChatDetailView: View {
    let conversation: LocalChatConversation
    @EnvironmentObject private var model: LocalChatModel
    @EnvironmentObject private var app: AppModel
    @Environment(\.locale) private var locale
    @Environment(\.dismiss) private var dismiss

    /// Whether the reader is close enough to the end to be followed while an
    /// answer streams. Android asks the same question with
    /// `content.bottom - viewport.bottom < dp(120)`.
    @State private var follow = ScrollFollowTracker()
    @State private var showingModelPicker = false
    @State private var showingAttachments = false
    @State private var showingTools = false
    @State private var showingProviders = false
    @State private var attachmentSource: LocalAttachmentSource?
    @State private var composerHeight: CGFloat = 96
    @State private var modelAnchorTop: CGFloat?
    @State private var detailError: String?
    @State private var focusComposerRequest = 0

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollViewReader { proxy in
                GeometryReader { viewport in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            if model.messages.isEmpty {
                                LocalChatEmptyConversationView { focusComposerRequest += 1 }
                                    .frame(minHeight: max(260, viewport.size.height - 24))
                                    .id("local-empty")
                            }
                            ForEach(model.messages) { message in
                                LocalChatMessageRow(
                                    message: message,
                                    editable: isLastUser(message),
                                    onEdit: { model.beginEdit(message.id) })
                                    .id(message.id)
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .measuringContentBottom()
                    }
                    .measuringViewportBottom()
                    // Opening a conversation and sending a message both land at
                    // the end; a reader who scrolls up stays where they are.
                    .onChange(of: model.messages.count) { _ in
                        follow.following()
                        withAnimation { proxy.scrollTo(bottomId, anchor: .bottom) }
                    }
                    .onChange(of: model.liveText) { _ in
                        guard follow.isAtBottom else { return }
                        proxy.scrollTo(bottomId, anchor: .bottom)
                    }
                }
            }
            LocalChatComposer(
                focusRequest: focusComposerRequest,
                onAttach: { showingAttachments = true },
                onTools: { showingTools = true },
                onModelPicker: { showingModelPicker = true })
            if let summary = model.contextSummary {
                StatusLine(text: summary, tone: .muted)
                    .padding(.horizontal, PageGutter.horizontal)
                    .padding(.bottom, 2)
            }
            if let status = detailStatus {
                StatusLine(text: status, tone: detailError == nil ? .muted : .bad)
                    .padding(.horizontal, PageGutter.horizontal)
                    .padding(.bottom, 2)
            }
        }
        .trackingScrollFollow(follow)
        .coordinateSpace(name: "local-chat-detail")
        .onPreferenceChange(LocalComposerHeightKey.self) { composerHeight = $0 }
        .onPreferenceChange(LocalModelAnchorKey.self) { modelAnchorTop = $0 }
        .overlay {
            GeometryReader { geometry in
                if showingModelPicker || showingAttachments || showingTools {
                    ZStack(alignment: .bottomTrailing) {
                        Color.black.opacity(showingModelPicker ? 0 : 0.28)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                showingModelPicker = false
                                showingAttachments = false
                                showingTools = false
                            }
                        if showingModelPicker {
                            LocalChatModelPicker(
                                maxHeight: max(1, (modelAnchorTop ?? geometry.size.height - composerHeight) - 16),
                                onDismiss: { showingModelPicker = false },
                                onSettings: {
                                    showingModelPicker = false
                                    showingProviders = true
                                })
                                .frame(width: min(320, geometry.size.width - 24))
                                .padding(.trailing, 12)
                                .padding(.bottom, max(0, geometry.size.height
                                    - (modelAnchorTop ?? geometry.size.height - composerHeight)) + 10)
                        }
                        if showingAttachments {
                            LocalChatAttachPanel(
                                onClose: { showingAttachments = false },
                                onSource: { source in
                                    showingAttachments = false
                                    attachmentSource = source
                                },
                                onTools: {
                                    showingAttachments = false
                                    showingTools = true
                                })
                                .frame(width: min(560, geometry.size.width - 24))
                                .frame(maxWidth: .infinity, alignment: .center)
                                .padding(.bottom, 12)
                        }
                        if showingTools {
                            LocalChatToolsPanel(enabled: model.webTools, onClose: { showingTools = false })
                                .frame(width: min(560, geometry.size.width - 24))
                                .frame(maxWidth: .infinity, alignment: .center)
                                .padding(.bottom, 12)
                        }
                    }
                }
            }
            .allowsHitTesting(showingModelPicker || showingAttachments || showingTools)
        }
        .background(Palette.background)
        .navigationBarHidden(true)
        .sheet(item: $model.locationConsent, onDismiss: { model.locationDismissed() }) { consent in
            LocationConsentSheet(
                consent: consent,
                onAllow: { model.allowLocation() },
                onSkip: { model.skipLocation() },
                onCancel: { model.cancelLocation() })
        }
        .sheet(isPresented: $showingProviders) {
            NavigationView { ProviderSettingsView(onClose: { showingProviders = false }) }
                .navigationViewStyle(.stack)
        }
        .sheet(item: $attachmentSource) { source in
            switch source {
            case .camera:
                CameraPicker(onPicked: { image in
                    attachmentSource = nil
                    guard model.openId == conversation.id else { return }
                    detailError = nil
                    model.addImages([image])
                }, onCancel: { attachmentSource = nil })
            case .photos:
                PhotoPicker(limit: max(1, AttachmentLimits.maxCount - model.images.count - model.documents.count),
                            onPicked: { images in
                                attachmentSource = nil
                                guard model.openId == conversation.id else { return }
                                if !images.isEmpty { detailError = nil }
                                model.addEncodedImages(images)
                            }, onCancel: { attachmentSource = nil },
                            onFailure: {
                                attachmentSource = nil
                                guard model.openId == conversation.id else { return }
                                model.notice = .init(text: AttachmentError.unreadableImage.localizedDescription,
                                                     serious: false)
                            })
            case .files:
                DocumentPicker(onPicked: { files in
                    attachmentSource = nil
                    guard model.openId == conversation.id else { return }
                    if !files.isEmpty { detailError = nil }
                    model.addFiles(files)
                }, onCancel: { attachmentSource = nil })
            }
        }
        .onAppear {
            model.open(conversation.id)
            adoptNotice()
        }
        .onDisappear { model.close() }
        .onChange(of: model.notice) { _ in adoptNotice() }
        .onChange(of: model.running) { running in if running { detailError = nil } }
    }

    private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    private var header: some View {
        HStack(spacing: 10) {
            RoundBackButton { dismiss() }
            RemotePageHeading(
                title: conversation.displayTitle(in: locale),
                computer: app.usesChinese
                    ? (isPad ? "本机 · 平板直连 API" : "本机 · 手机直连 API")
                    : (isPad ? "On this iPad · Direct API" : "On this phone · Direct API"),
                systemImage: isPad ? "ipad" : "iphone")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, PageGutter.horizontal)
        .padding(.top, 12)
        .padding(.bottom, 18)
    }

    private var detailStatus: String? {
        if let detailError { return detailError }
        if model.loading { return "正在载入本机聊天…" }
        if model.needsSaveRetry { return "回复尚未成功保存，请重试保存。" }
        if model.preparing { return "正在准备请求 · 可随时停止" }
        if model.running { return "正在回复 · 离开应用将停止请求" }
        if model.editingIndex != nil { return "正在编辑上一条消息 · 发送后将重新生成后续回复" }
        if model.selectedRoute() == nil { return "请导入配置或重新选择模型。" }
        return nil
    }

    private func adoptNotice() {
        guard !showingProviders, let notice = model.notice else { return }
        model.notice = nil
        detailError = notice.text
    }

    private var bottomId: Int { model.messages.last?.id ?? 0 }

    /// Only the newest user turn may be edited: everything below it was
    /// generated from it.
    private func isLastUser(_ message: LocalChatMessage) -> Bool {
        guard message.isUser, !model.running else { return false }
        return model.messages.last(where: { $0.isUser })?.id == message.id
    }
}

private struct LocalChatEmptyConversationView: View {
    let onWrite: () -> Void

    var body: some View {
        EmptyStateView(mark: .brand, title: "今天想做些什么？",
                       message: "写下问题或添加内容，开始这次对话。") {
            EmptyStateActionButton(title: "输入消息", action: onWrite)
        }
    }
}

private struct LocalChatMessageRow: View {
    @Environment(\.locale) private var locale
    let message: LocalChatMessage
    let editable: Bool
    let onEdit: () -> Void

    @State private var showProcess = false

    var body: some View {
        VStack(alignment: message.isUser ? .trailing : .leading, spacing: 6) {
            if !message.process.isEmpty { processDisclosure }
            content
            if !message.notice.isEmpty {
                StatusLine(text: message.notice, tone: .bad)
                    .padding(.top, 2)
            }
            footer
        }
        .frame(maxWidth: .infinity, alignment: message.isUser ? .trailing : .leading)
        .padding(.trailing, message.isUser ? 0 : Palette.userInset)
    }

    @ViewBuilder
    private var processDisclosure: some View {
        Button { showProcess.toggle() } label: {
            HStack(spacing: 6) {
                Image(systemName: showProcess ? "chevron.down" : "chevron.right").font(.caption2)
                Text("\(message.process.count) 个步骤").font(.caption)
            }
            .foregroundColor(Palette.muted)
        }
        .buttonStyle(.plain)
        if showProcess {
            LocalChatProcessView(entries: message.process)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private var content: some View {
        if message.isUser {
            VStack(alignment: .trailing, spacing: 6) {
                if !message.text.isEmpty {
                    Text(message.text)
                        .font(.body)
                        .foregroundColor(Palette.ink)
                        .padding(12)
                        .background(RoundedRectangle(cornerRadius: Palette.radius, style: .continuous)
                            .fill(Palette.surface))
                }
                if !message.images.isEmpty { attachments }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        } else if message.text.isEmpty, message.state == "running" {
            WorkingDots()
        } else {
            AsyncMarkdownView(text: message.text, streaming: message.state == "running")
                .textSelection(.enabled)
        }
    }

    /// What the user attached to this turn.
    ///
    /// The history holds sealed references, not bytes, so each thumbnail is
    /// unsealed once by its own view rather than by the list.
    private var attachments: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(message.images, id: \.self) { reference in
                    StoredThumbnail(reference: reference)
                }
                ForEach(Array(message.documents.enumerated()), id: \.offset) { _, entry in
                    VStack(spacing: 3) {
                        Image(systemName: "doc.fill").foregroundColor(Palette.muted)
                        Text((entry["name"] as? String).flatMap { ArtifactReferences.fileExtension(of: $0) } ?? "FILE")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(Palette.muted)
                    }
                    .frame(width: 60, height: 60)
                    .background(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous).fill(Palette.surface))
                    .accessibilityLabel(entry["name"] as? String ?? "文档")
                }
            }
        }
    }

    @ViewBuilder
    private var footer: some View {
        HStack(spacing: 8) {
            if editable {
                Button(action: onEdit) {
                    Image(systemName: "pencil").font(.caption).foregroundColor(Palette.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("编辑这条消息")
            }
            if !message.text.isEmpty {
                Button {
                    UIPasteboard.general.string = message.text
                } label: {
                    Image(systemName: "doc.on.doc").font(.caption).foregroundColor(Palette.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("复制")
            }
            if message.at > 0 {
                Text(time(message.at)).font(.caption2).foregroundColor(Palette.faint)
            }
        }
    }

    private func time(_ at: Int64) -> String {
        let date = Date(timeIntervalSince1970: Double(at) / 1000)
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.dateFormat = locale.identifier.lowercased().hasPrefix("zh")
            ? "M月d日 HH:mm" : "MMM d, HH:mm"
        return formatter.string(from: date)
    }
}

/// One sealed image, unsealed on appearance.
private struct StoredThumbnail: View {
    let reference: String
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Rectangle().fill(Palette.surface)
            }
        }
        .frame(width: 88, height: 88)
        .clipShape(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous))
        .onAppear {
            if image == nil, let data = try? AppStores.attachmentStore.preview(reference) {
                image = UIImage(data: data)
            }
        }
    }
}

/// The tool steps behind a reply.
///
/// Local chat records the thinking text and each tool call in the same shape
/// the remote side does, so the two renderers take the same dictionaries and
/// only the labels differ.
struct LocalChatProcessView: View {
    let entries: [[String: Any]]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: icon(entry))
                        .font(.caption2)
                        .foregroundColor(Palette.muted)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title(entry)).font(.caption).foregroundColor(Palette.ink)
                        if let text = entry["text"] as? String, !text.isEmpty {
                            Text(text).font(.caption2).foregroundColor(Palette.muted).lineLimit(4)
                        }
                    }
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: Palette.smallRadius, style: .continuous)
            .fill(Palette.surface))
    }

    private func icon(_ entry: [String: Any]) -> String {
        (entry["type"] as? String) == "thinking" ? "brain" : "chevron.right.circle"
    }

    private func title(_ entry: [String: Any]) -> String {
        if (entry["type"] as? String) == "thinking" { return "思考" }
        return (entry["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? (entry["name"] as? String)
            ?? "工具"
    }
}

// MARK: - Composer

struct LocalChatComposer: View {
    let focusRequest: Int
    let onAttach: () -> Void
    let onTools: () -> Void
    let onModelPicker: () -> Void
    @EnvironmentObject private var model: LocalChatModel
    @Environment(\.locale) private var locale
    /// The phone's own preferences live with the remote model, which owns the
    /// settings screen that edits them.
    @EnvironmentObject private var app: AppModel
    @State private var writing = false
    @State private var draftHeight: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            if !model.images.isEmpty || !model.documents.isEmpty {
                LocalChatAttachmentTray()
            }
            if model.editingIndex != nil { editingBanner }
            ZStack(alignment: .topLeading) {
                ComposerField(text: draftBinding, height: $draftHeight, focus: $writing,
                              sendOnReturn: app.preferences.enterMode == .send,
                              maxUTF16Length: 100_000,
                              onSubmit: { if canSend { model.send(chinese: app.usesChinese) } })
                    .disabled(model.busy || model.preparing)
                if model.draft.isEmpty {
                    Text("输入消息")
                        .font(.system(size: Palette.textRow))
                        .foregroundColor(Palette.muted)
                        .allowsHitTesting(false)
                }
            }
            .frame(height: min(ComposerField.fourLines,
                               max(ComposerField.floorHeight, draftHeight)),
                   alignment: .topLeading)
            .padding(EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 8))
            toolRow
        }
        .padding(EdgeInsets(top: 6, leading: 8, bottom: 6, trailing: 8))
        .background(RoundedRectangle(cornerRadius: Palette.capsuleRadius, style: .continuous)
            .fill(Palette.background))
        .overlay(RoundedRectangle(cornerRadius: Palette.capsuleRadius, style: .continuous)
            .stroke(writing ? Palette.accent : Palette.separator, lineWidth: 1))
        .padding(.horizontal, PageGutter.horizontal)
        .padding(.bottom, PageGutter.dockBottom)
        .background(Palette.background)
        .background(GeometryReader { geometry in
            Color.clear.preference(key: LocalComposerHeightKey.self, value: geometry.size.height)
        })
        .onChange(of: focusRequest) { _ in writing = true }
    }

    private var editingBanner: some View {
        HStack(spacing: 0) {
            Text("正在编辑上一条消息")
                .font(.system(size: Palette.textSmall))
                .lineLimit(1)
                .padding(.leading, 12)
            Spacer(minLength: 0)
            Button { model.cancelEdit() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: Palette.textDisplay))
                    .frame(width: 48, height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("取消编辑")
        }
        .foregroundColor(Palette.muted)
    }

    private var toolRow: some View {
        HStack(spacing: 0) {
            toolButton("plus", label: "添加附件", enabled: !model.busy && !model.running,
                       action: onAttach)
            toolButton("magnifyingglass", label: "联网工具",
                       enabled: !model.running,
                       tint: model.webTools ? Palette.accent : Palette.ink,
                       action: onTools)
            modelButton
            trailingButton
        }
        .frame(height: 48)
        .background(GeometryReader { geometry in
            Color.clear.preference(key: LocalModelAnchorKey.self,
                                   value: geometry.frame(in: .named("local-chat-detail")).minY)
        })
    }

    private func toolButton(_ symbol: String, label: String, enabled: Bool,
                            tint: Color = Palette.ink, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: Palette.textDisplay))
                .foregroundColor(tint)
                .frame(width: 48, height: 48)
                .opacity(enabled ? 1 : 0.45)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(Text(LocalizedStringKey(label)))
    }

    /// The same measured four-line input as remote chat, with Android's local
    /// 100,000-character ceiling and a draft saved across app restarts.
    private var draftBinding: Binding<String> {
        Binding(
            get: { model.draft },
            set: { value in
                model.draft = ComposerField.limited(value, to: 100_000)
                model.scheduleDraftSave()
            })
    }

    private var modelButton: some View {
        Button(action: onModelPicker) {
            HStack(spacing: 4) {
                Spacer(minLength: 0)
                Text(modelLabel)
                    .font(.system(size: Palette.textBody))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
            }
            .foregroundColor(Palette.ink)
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, minHeight: 48, maxHeight: 48, alignment: .trailing)
            .background(Capsule(style: .continuous).fill(Palette.background))
        }
        .buttonStyle(.plain)
        .disabled(model.running)
        .opacity(model.running ? 0.45 : 1)
        .accessibilityLabel(locale.identifier.lowercased().hasPrefix("zh")
            ? "切换模型和思考等级：\(modelLabel)"
            : "Change model and thinking level: \(modelLabel)")
    }

    @ViewBuilder
    private var trailingButton: some View {
        if model.runningConversationId != nil && model.runningConversationId == model.openId {
            actionButton(model.needsSaveRetry ? "arrow.clockwise" : "stop.fill",
                         label: model.needsSaveRetry ? "重试保存" : "停止", enabled: true) { model.stop() }
        } else {
            actionButton("arrow.up", label: "发送", enabled: canSend) {
                model.send(chinese: app.usesChinese)
            }
        }
    }

    private func actionButton(_ symbol: String, label: String, enabled: Bool,
                              action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: Palette.textDisplay, weight: .semibold))
                .foregroundColor(.white)
                .frame(width: 48, height: 48)
                .background(Capsule(style: .continuous)
                    .fill(enabled ? Palette.accent : Palette.muted))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(Text(LocalizedStringKey(label)))
    }

    private var canSend: Bool {
        !model.busy
            && !model.running
            && model.selectedRoute() != nil
            && (!ComposerText.androidTrim(model.draft).isEmpty
                || !model.images.isEmpty
                || !model.documents.isEmpty)
    }

    private var displayThinking: String {
        model.selectedRoute().map { LocalChatThinking.effective($0, model.thinking) } ?? "auto"
    }

    private var modelLabel: String {
        let name = model.selectedRoute()?.displayName
            ?? (locale.identifier.lowercased().hasPrefix("zh") ? "选择模型" : "Select model")
        return ModelLabel.compact(name) + " · "
            + LocalChatThinking.label(displayThinking,
                                      chinese: locale.identifier.lowercased().hasPrefix("zh"))
    }
}

/// The row of picked files above the input.
struct LocalChatAttachmentTray: View {
    @EnvironmentObject private var model: LocalChatModel

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(model.images, id: \.self) { reference in
                    ZStack(alignment: .topTrailing) {
                        Group {
                            if let image = model.imagePreviews[reference] {
                                Image(uiImage: image).resizable().scaledToFill()
                            } else {
                                Rectangle().fill(Palette.surface)
                            }
                        }
                        .frame(width: 60, height: 60)
                        .clipShape(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous))
                        removeButton { model.removeImage(reference) }
                    }
                }
                ForEach(Array(model.documents.enumerated()), id: \.offset) { index, entry in
                    ZStack(alignment: .topTrailing) {
                        VStack(spacing: 3) {
                            Image(systemName: "doc.fill").foregroundColor(Palette.muted)
                            Text((entry["name"] as? String).flatMap { ArtifactReferences.fileExtension(of: $0) } ?? "FILE")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundColor(Palette.muted)
                        }
                        .frame(width: 60, height: 60)
                        .background(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous).fill(Palette.surface))
                        removeButton { model.removeDocument(entry["name"] as? String ?? "", at: index) }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
        }
        .frame(height: 76)
    }

    private func removeButton(_ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: Palette.textRow))
                .foregroundColor(.white)
                .background(Circle().fill(Color.black.opacity(0.55)))
        }
        .buttonStyle(.plain)
        .offset(x: 5, y: -5)
        .accessibilityLabel("移除附件")
    }
}

// MARK: - Model picker

private enum LocalAttachmentSource: String, Identifiable {
    case camera, photos, files
    var id: String { rawValue }
}

private struct LocalChatAttachPanel: View {
    @EnvironmentObject private var model: LocalChatModel
    @Environment(\.locale) private var locale

    let onClose: () -> Void
    let onSource: (LocalAttachmentSource) -> Void
    let onTools: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 13) {
                Image(systemName: "plus")
                    .foregroundColor(Palette.accent)
                    .frame(width: 40, height: 40)
                    .background(RoundedRectangle(cornerRadius: Palette.fieldRadius).fill(Palette.card))
                Text("添加内容")
                    .font(.system(size: Palette.textTitle, weight: .medium))
                    .foregroundColor(Palette.ink)
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .foregroundColor(Palette.secondary)
                        .frame(width: 40, height: 40)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("关闭")
            }
            .padding(.bottom, 16)

            Text(verbatim: chinese
                 ? "最多 20 个附件 · 图片 4 MiB/张 · 文档 10 MiB/个"
                 : "Up to 20 attachments · 4 MiB/image · 10 MiB/document")
                .font(.system(size: Palette.textNote))
                .foregroundColor(Palette.secondary)
                .padding(.horizontal, 4)
                .padding(.bottom, 14)

            HStack(spacing: 12) {
                tile("拍照", icon: "camera", source: .camera, enabled: canAttach && CameraPicker.isAvailable)
                tile("照片", icon: "photo", source: .photos, enabled: canAttach)
                tile("文件", icon: "doc", source: .files, enabled: canAttach)
            }
            .padding(.bottom, 16)

            Button(action: onTools) {
                HStack(spacing: 13) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: Palette.textRow))
                        .frame(width: 23)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text("联网搜索")
                                .font(.system(size: Palette.textRow))
                                .foregroundColor(Palette.ink)
                            Spacer()
                            Text(model.webTools ? "已开启" : "已关闭")
                                .font(.system(size: Palette.textBody))
                                .foregroundColor(Palette.secondary)
                        }
                        Text("使用 Bing 和百度搜索，并读取公开网页")
                            .font(.system(size: Palette.textNote))
                            .foregroundColor(Palette.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: Palette.textNote, weight: .semibold))
                        .foregroundColor(Palette.secondary)
                }
                .foregroundColor(Palette.ink)
                .padding(16)
                .frame(minHeight: 68)
                .background(RoundedRectangle(cornerRadius: Palette.groupRadius).fill(Palette.card))
            }
            .buttonStyle(.plain)

            if !canAttach {
                Text(model.images.count + model.documents.count >= AttachmentLimits.maxCount
                     ? "最多添加 20 个附件。" : "回复结束后可继续添加图片。")
                    .font(.system(size: Palette.textNote))
                    .foregroundColor(Palette.secondary)
                    .padding(.horizontal, 4)
                    .padding(.top, 14)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
        .padding(.bottom, 18)
        .background(RoundedRectangle(cornerRadius: Palette.sheetRadius, style: .continuous)
            .fill(Palette.grouped))
    }

    private var canAttach: Bool {
        !model.busy && !model.running
            && model.images.count + model.documents.count < AttachmentLimits.maxCount
    }

    private var chinese: Bool { locale.identifier.lowercased().hasPrefix("zh") }

    private func tile(_ label: String, icon: String, source: LocalAttachmentSource, enabled: Bool) -> some View {
        Button { onSource(source) } label: {
            VStack(spacing: 10) {
                Image(systemName: icon).font(.system(size: 24))
                Text(LocalizedStringKey(label))
                    .font(.system(size: Palette.textBody))
                    .lineLimit(1)
            }
            .foregroundColor(Palette.ink)
            .frame(maxWidth: .infinity)
            .frame(height: 96)
            .background(RoundedRectangle(cornerRadius: Palette.fieldRadius).fill(Palette.card))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }
}

private struct LocalChatToolsPanel: View {
    @EnvironmentObject private var model: LocalChatModel
    @State private var enabled: Bool
    @State private var failure: String?
    let onClose: () -> Void

    init(enabled: Bool, onClose: @escaping () -> Void) {
        self.onClose = onClose
        _enabled = State(initialValue: enabled)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("联网功能")
                .font(.system(size: Palette.textTitle, weight: .medium))
                .foregroundColor(Palette.ink)
            Text("使用 Bing 和百度搜索，并读取公开网页")
                .font(.system(size: Palette.textBody))
                .foregroundColor(Palette.muted)
                .padding(.top, 8)
                .padding(.bottom, 14)
            Toggle(isOn: $enabled) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("联网功能")
                        .font(.system(size: Palette.textRow))
                    Text("仅当前会话")
                        .font(.system(size: Palette.textNote))
                        .foregroundColor(Palette.muted)
                }
            }
            .toggleStyle(SwitchToggleStyle(tint: Palette.accent))
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
            .background(RoundedRectangle(cornerRadius: Palette.groupRadius).fill(Palette.surface))
            if let failure {
                StatusLine(text: failure, tone: .bad)
                    .padding(.top, 12)
            }
            Button {
                Task {
                    if let problem = await model.setTools(enabled) { failure = problem }
                    else { onClose() }
                }
            } label: {
                Text("保存")
                    .font(.system(size: Palette.textRow, weight: .medium))
                    .foregroundColor(Palette.card)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(RoundedRectangle(cornerRadius: Palette.dialogActionRadius).fill(Palette.ink))
            }
            .buttonStyle(.plain)
            .padding(.top, 12)
            Button(action: onClose) {
                Text("取消")
                    .font(.system(size: Palette.textRow, weight: .medium))
                    .foregroundColor(Palette.ink)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(RoundedRectangle(cornerRadius: Palette.dialogActionRadius).fill(Palette.card))
            }
            .buttonStyle(.plain)
            .padding(.top, 8)
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
        .padding(.bottom, 10)
        .background(RoundedRectangle(cornerRadius: Palette.sheetRadius, style: .continuous)
            .fill(Palette.grouped))
    }
}

private struct LocalComposerHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 96
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct LocalModelAnchorKey: PreferenceKey {
    static var defaultValue: CGFloat? = nil
    static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() }
}

/// Android's picker rises from the model button. It has a second, receding
/// layer for thinking controls; neither page is a full-screen settings list.
private struct LocalChatModelPicker: View {
    @EnvironmentObject private var model: LocalChatModel
    @Environment(\.locale) private var locale
    @State private var showingThinking = false

    let maxHeight: CGFloat
    let onDismiss: () -> Void
    let onSettings: () -> Void

    var body: some View {
        ZStack(alignment: .top) {
            modelPanel
                .frame(height: modelHeight)
                .opacity(showingThinking ? 0.48 : 1)
                .blur(radius: showingThinking ? 5 : 0)
                .allowsHitTesting(!showingThinking)
                .accessibilityHidden(showingThinking)
            if showingThinking {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture { withAnimation(.easeOut(duration: 0.18)) { showingThinking = false } }
                thinkingPanel
                    .frame(height: thinkingHeight)
                    .frame(maxHeight: .infinity, alignment: .bottom)
            }
        }
        .frame(height: showingThinking ? min(maxHeight, max(modelHeight, thinkingHeight + 96)) : modelHeight)
        .background(PopupGlassSurface())
        .clipShape(RoundedRectangle(cornerRadius: Palette.groupRadius, style: .continuous))
        .shadow(color: .black.opacity(0.2), radius: 12, y: 5)
    }

    private var modelHeight: CGFloat {
        min(maxHeight, 28 + 24 + CGFloat(model.routes.count) * 78
            + (model.routes.isEmpty ? 64 : 0) + 21 + 64 + 21 + 64)
    }

    private var thinkingHeight: CGFloat { min(maxHeight, CGFloat(24 + 64 + 21 + 3 * 78 + 76)) }

    private var modelPanel: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 0) {
                Text("选择模型")
                    .font(.system(size: Palette.textTiny))
                    .foregroundColor(Palette.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 2)
                    .padding(.bottom, 10)
                ForEach(model.routes, id: \.id) { route in
                    PopupChoiceRow(
                        title: route.displayName,
                        subtitle: route.providerName + " · " + (URL(string: route.baseURL)?.host ?? ""),
                        selected: model.selectedRoute()?.id == route.id) {
                            model.selectRoute(route)
                            onDismiss()
                        }
                }
                if model.routes.isEmpty {
                    Text("导入 API 配置后，即可选择模型。")
                        .font(.system(size: Palette.textBody))
                        .foregroundColor(Palette.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 64)
                }
                divider
                PopupChoiceRow(
                    title: "思考等级",
                    subtitle: LocalChatThinking.label(displayThinking, chinese: chinese),
                    icon: "chevron.right") {
                        withAnimation(.easeOut(duration: 0.18)) { showingThinking = true }
                    }
                divider
                PopupChoiceRow(title: "管理 API 配置", subtitle: "", icon: "chevron.right", action: onSettings)
            }
            .padding(.horizontal, 12)
            .padding(.top, 14)
            .padding(.bottom, 10)
        }
    }

    private var thinkingPanel: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 0) {
                PopupChoiceRow(title: "思考等级",
                                   subtitle: model.selectedRoute()?.displayName ?? "未选择模型",
                                   icon: "chevron.down") {
                    withAnimation(.easeOut(duration: 0.18)) { showingThinking = false }
                }
                divider
                ForEach(LocalChatThinking.levels, id: \.self) { level in
                    PopupChoiceRow(
                        title: LocalChatThinking.label(level, chinese: chinese),
                        subtitle: description(for: level),
                        selected: displayThinking == level,
                        enabled: level == "auto" || LocalChatThinking.supported(model.selectedRoute())) {
                            model.selectThinking(level)
                            onDismiss()
                        }
                }
                Text(LocalChatThinking.supported(model.selectedRoute())
                     ? "由所选 API 决定支持程度；若提示参数不支持，请切回默认。"
                     : "此模型暂无已知的思考参数映射，使用默认设置。")
                    .font(.system(size: Palette.textTiny))
                    .foregroundColor(Palette.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .padding(.bottom, 8)
            }
            .padding(.horizontal, 12)
            .padding(.top, 14)
            .padding(.bottom, 10)
        }
    }

    private var divider: some View {
        Palette.muted.opacity(0.14)
            .frame(height: 1)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
    }

    private var chinese: Bool { locale.identifier.lowercased().hasPrefix("zh") }

    private var displayThinking: String {
        model.selectedRoute().map { LocalChatThinking.effective($0, model.thinking) } ?? "auto"
    }

    private func description(for level: String) -> String {
        switch level {
        case "medium": return "平衡思考深度与响应速度"
        case "high": return "投入更多思考，可能增加耗时与费用"
        default: return "遵循模型默认，不额外设置参数"
        }
    }
}
