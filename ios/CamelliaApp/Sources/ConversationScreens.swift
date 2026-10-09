import SwiftUI

// MARK: - List

struct ConversationListView: View {
    @EnvironmentObject private var model: AppModel
    @Binding var showSearch: Bool
    let onComputerPickerAction: (ComputerPickerAction) -> Void
    @State private var prompt: ListPrompt?
    @State private var renameTitle = ""
    @State private var renameError: String?
    @State private var creatingWorkspace = false
    @State private var selecting = false
    @State private var selection: Set<String> = []
    @FocusState private var searchFocused: Bool
    @State private var pushActive = false
    /// Pushes the launch fixture through the real navigation container.
    @State private var launchPush = LaunchScreen.conversation != nil

    /// A newly created conversation to open after its destination is ready.
    @State private var pushTarget: RemoteConversation?

    /// The conversation the launch environment named, if the cache holds it.
    private var launchedConversation: RemoteConversation? {
        guard let id = LaunchScreen.conversation else { return nil }
        return model.conversations.first { $0.id == id }
    }

    var body: some View {
        VStack(spacing: 0) {
            if showSearch {
                searchField
                    .padding(.horizontal, PageGutter.horizontal)
                    .padding(.bottom, 12)
            }
            if showsPlaceholder {
                placeholder
            } else {
                list
            }
        }
        // Android's `shell()` puts a chat page on the plain page colour — the
        // grey is the settings, computers and pairing screens — and the page
        // draws it rather than the list: the strip under the last row is the
        // same colour as the rows, which is what makes Android's rows read as
        // one column instead of a stack of cards.
        .background(Palette.background.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            StreamBar().environmentObject(model)
                .padding(.horizontal, PageGutter.horizontal)
        }
        .background(pushLinks)
        .overlay {
            GeometryReader { geometry in
                if let choice = model.engineChoice {
                    let height = min(max(160, geometry.size.height - 32),
                                     172 + CGFloat(model.availableEngines.count) * 64)
                    ZStack(alignment: .bottom) {
                        Color.black.opacity(0.28).ignoresSafeArea().contentShape(Rectangle())
                            .onTapGesture { model.engineChoice = nil }
                        ScrollView(.vertical, showsIndicators: false) {
                            EnginePickerSheet(engines: model.availableEngines,
                                              onClose: { model.engineChoice = nil }) { engine in
                                model.engineChoice = nil
                                model.createConversation(workspaceId: choice.workspaceId,
                                                         engine: engine.rawValue)
                            }
                            .frame(minHeight: height, alignment: .bottom)
                        }
                        .frame(width: min(560, geometry.size.width - 24),
                               height: height)
                        .clipShape(RoundedRectangle(cornerRadius: Palette.sheetRadius, style: .continuous))
                        .padding(.bottom, 12)
                    }
                } else if creatingWorkspace {
                    let height = min(max(160, geometry.size.height - 32), 480)
                    ZStack(alignment: .bottom) {
                        Color.black.opacity(0.28).ignoresSafeArea().contentShape(Rectangle())
                            .onTapGesture { creatingWorkspace = false }
                        ScrollView(.vertical, showsIndicators: false) {
                            NewWorkspaceSheet(onClose: { creatingWorkspace = false }) { name, path in
                                creatingWorkspace = false
                                model.createWorkspace(name: name, path: path)
                            }
                            .frame(minHeight: height, alignment: .bottom)
                        }
                        .frame(width: min(560, geometry.size.width - 24),
                               height: height)
                        .clipShape(RoundedRectangle(cornerRadius: Palette.sheetRadius, style: .continuous))
                        .padding(.bottom, 12)
                    }
                }
            }
            .allowsHitTesting(model.engineChoice != nil || creatingWorkspace)
        }
        .onChange(of: model.createdConversationId) { id in
            guard let id,
                  let conversation = model.conversations.first(where: { $0.id == id }) else { return }
            model.createdConversationId = nil
            pushTarget = conversation
            DispatchQueue.main.async { pushActive = true }
        }
        .onChange(of: model.search) { _ in
            model.userInteracted()
            model.searchChanged()
        }
        .onChange(of: showSearch) { shown in
            searchFocused = shown
            if !shown { model.search = "" }
        }
        .overlay(alignment: .bottom) { actionPromptPanel }
    }

    /// Android's "工作区" heading, which opens the whole column and carries the
    /// only way to make a new workspace.
    ///
    /// It is a row of the content rather than a button in the navigation bar.
    /// Android hangs it on `chatStyle.workspaceHeader`, which is also where the
    /// 14sp muted label and the muted "add" glyph come from — the bar's own
    /// "add" is a different icon from the "new" bubble the group headings use,
    /// and drawing one for the other is the sort of thing that reads as a
    /// mistake without anyone being able to say why.
    private var workspaceHeading: some View {
        HStack(spacing: 0) {
            Text("工作区")
                .font(.system(size: Palette.textBody, weight: .medium))
                .foregroundColor(Palette.muted)
            Spacer(minLength: 8)
            Button {
                if !model.access.canCreateWorkspace {
                    model.notice = AppModel.Notice(text: "请更新电脑端，并授权控制所有工作区后再新建。", serious: false)
                } else if !model.commandBusy {
                    if model.hasPendingListOperation {
                        model.retryPendingListOperation()
                    } else {
                        creatingWorkspace = true
                    }
                }
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

    // MARK: - Layout

    /// One workspace heading and the conversations under it.
    private struct Group: Identifiable {
        /// The workspace id, or `""` for the conversations that have none —
        /// which is also what `AppModel.collapsedWorkspaces` keys them by.
        let id: String
        let name: String
        let rows: [RemoteConversation]

        var isIndependent: Bool { id.isEmpty }
    }

    /// The column Android's `renderConversations()` builds: one workspace
    /// heading and its conversations, one after another down the page.
    ///
    /// This is a flat sequence of rows rather than `Section`s, and the reason is
    /// the headings. A `Section` header in a plain `List` pins itself to the top
    /// of the viewport while its rows scroll under it, and it uppercases its own
    /// text; Android's headings do neither — they are a disclosure row that
    /// scrolls away like anything else. A heading drawn as an ordinary row is
    /// the same thing Android has, and it is also what lets the row carry its
    /// own 12dp of space above it.
    private var list: some View {
        List {
            if selecting { selectionRow }
            if model.hasPendingListOperation { pendingOperationRow }
            workspaceHeading
            ForEach(groups) { group in
                header(group)
                if !folded(group) {
                    ForEach(group.rows) { conversation in
                        row(conversation, grouped: !group.isIndependent)
                    }
                }
            }
            if model.nextListOffset >= 0 { loadMoreRow }
        }
        .listStyle(.plain)
        // Zero, or the heading rows would be lifted to the default 44-point
        // minimum and a folded group would leave a gap the size of a row.
        .environment(\.defaultMinListRowHeight, 0)
        .padding(.horizontal, PageGutter.horizontal)
        // `reserveDockSpace` adds the dock's height to the content's own 16dp,
        // and the `safeAreaInset` above is the dock's half of that.
        .padding(.bottom, PageGutter.contentBottom)
        .background(Palette.background)
        .plainPageBackground()
        .refreshable {
            model.userInteracted()
            model.refreshList()
        }
        .simultaneousGesture(DragGesture(minimumDistance: 8)
            .onChanged { _ in model.userInteracted() })
    }

    private var loadMoreRow: some View {
        Button { model.loadMoreConversations() } label: {
            HStack(spacing: 8) {
                if model.listLoadingMore { ProgressView().progressViewStyle(.circular) }
                Text(model.listLoadingMore ? "正在加载…" : "加载更多会话")
                    .font(.system(size: Palette.textBody))
                    .foregroundColor(Palette.accent)
            }
            .frame(maxWidth: .infinity, minHeight: 48)
        }
        .buttonStyle(.plain)
        .disabled(model.listLoadingMore)
        .plainPageRow()
    }

    /// The conversations split by workspace, in the order the desktop offered
    /// them, with the independent ones last.
    ///
    /// A workspace with nothing in it still gets a heading when the user is not
    /// searching, because that heading is where the "+" button for starting a
    /// conversation in it lives. While a search is on, only the groups that
    /// actually matched are shown, which is the distinction Android draws
    /// between its two passes.
    private var groups: [Group] {
        var order: [String] = []
        var buckets: [String: [RemoteConversation]] = [:]
        if !model.isSearching {
            for workspace in model.workspaces where buckets[workspace.id] == nil {
                buckets[workspace.id] = []
                order.append(workspace.id)
            }
        }
        for conversation in model.visibleConversations {
            let key = conversation.workspaceId ?? ""
            if buckets[key] == nil { order.append(key) }
            buckets[key, default: []].append(conversation)
        }
        var result: [Group] = []
        for key in order where !key.isEmpty {
            let rows = buckets[key] ?? []
            result.append(Group(id: key, name: name(of: key, rows: rows), rows: sorted(rows)))
        }
        let independent = buckets[""] ?? []
        if !independent.isEmpty || model.includeUnassigned {
            result.append(Group(id: "", name: model.usesChinese ? "独立会话" : "Independent conversations",
                                rows: sorted(independent)))
        }
        return result
    }

    /// What to call a workspace: the name its first row reported, if present,
    /// then the desktop's workspace-list name, then the raw id.
    ///
    /// That order is Android's, and it is the reverse of the obvious one. A
    /// Android uses the first row's `optString("workspaceName", name)` before
    /// sorting pins. An explicit empty string is still a reported name; only
    /// a missing field falls back to the workspace list.
    private func name(of workspace: String, rows: [RemoteConversation]) -> String {
        if let first = rows.first, let reported = first.workspaceName { return reported }
        if let known = model.workspaces.first(where: { $0.id == workspace }), !known.name.isEmpty {
            return known.name
        }
        return workspace
    }

    /// Pinned first, and otherwise in the order the desktop offered them.
    ///
    /// Android sorts each group with `Comparator.comparing(c -> !c.pinned)` and
    /// nothing else, and Java's sort is stable, so the rows keep the desktop's
    /// own order within each half. That order is the recency signal the desktop
    /// is maintaining; sorting by `updatedAt` as well would put the list in an
    /// order this phone chose instead, and the two apps would disagree about
    /// where a row goes. `enumerated` is what makes the tie-break explicit —
    /// Swift's `sorted` is not stable.
    private func sorted(_ rows: [RemoteConversation]) -> [RemoteConversation] {
        rows.enumerated()
            .sorted { lhs, rhs in
                if lhs.element.pinned != rhs.element.pinned { return lhs.element.pinned }
                return lhs.offset < rhs.offset
            }
            .map(\.element)
    }

    /// Whether a group is showing folded.
    ///
    /// A search always unfolds: hiding a match behind a fold the user set days
    /// ago would read as the search having failed.
    private func folded(_ group: Group) -> Bool {
        !model.isSearching && model.collapsedWorkspaces.contains(group.id)
    }

    /// Programmatic pushes for a newly created conversation and launch QA.
    /// Row taps use a direct link with a stable destination on iOS 15/16.
    @ViewBuilder
    private var pushLinks: some View {
        // Spelled out: `Group` in this scope is the workspace grouping above,
        // not the view builder.
        SwiftUI.Group {
            NavigationLink(destination: SwiftUI.Group {
                if let conversation = pushTarget {
                    ConversationDetailView(conversation: conversation,
                                           onComputerPickerAction: onComputerPickerAction)
                        .environmentObject(model)
                }
            }, isActive: $pushActive) { EmptyView() }
                .hidden()
            launchLink
        }
    }

    @ViewBuilder
    private var launchLink: some View {
        if let conversation = launchedConversation {
            NavigationLink(destination: ConversationDetailView(conversation: conversation,
                                                              onComputerPickerAction: onComputerPickerAction)
                .environmentObject(model),
                           isActive: $launchPush) { EmptyView() }
                .hidden()
        }
    }

    // Android opens remote search above the list, from the header.
    private var searchField: some View {
        HStack(spacing: 0) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: Palette.textDialog))
                .foregroundColor(Palette.ink)
                .frame(width: 44, height: 44)
            ZStack(alignment: .leading) {
                if model.search.isEmpty {
                    Text("搜索会话")
                        .font(.system(size: Palette.textRow))
                        .foregroundColor(Palette.muted)
                        .allowsHitTesting(false)
                }
                TextField("", text: $model.search)
                    .focused($searchFocused)
                    .submitLabel(.search)
                    .onSubmit { searchFocused = false }
                    .accessibilityLabel(model.usesChinese ? "搜索会话" : "Search conversations")
                    .font(.system(size: Palette.textRow))
                    .foregroundColor(Palette.ink)
                    .frame(minHeight: 48)
                    .padding(EdgeInsets(top: 0, leading: 2, bottom: 0, trailing: 8))
            }
            Button {
                searchFocused = false
                model.search = ""
                showSearch = false
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: Palette.textDialog))
                    .foregroundColor(Palette.ink)
                    .frame(width: 48, height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.usesChinese ? "关闭搜索" : "Close search")
        }
        .frame(height: 48)
        .background(Capsule(style: .continuous).fill(Palette.background))
        .overlay(Capsule(style: .continuous).stroke(Palette.separator, lineWidth: 1))
        .shadow(color: .black.opacity(0.10), radius: 4, y: 1)
    }

    /// A workspace's heading: the folder, the name, the fold arrow and the way
    /// to start a conversation inside it.
    ///
    /// The order is Android's, and it is not the obvious one — the arrow comes
    /// *after* the name, because `DisclosureHeader` lays the title down first
    /// and hangs a chevron off its right edge, and the heading is the weighted
    /// child of a row whose other half is the create button. A chevron in front
    /// of the folder would put the tap target for the fold on the wrong side of
    /// the thing it unfolds.
    ///
    /// The 32 points of room before the name are the folder's: `dp(2)` before it
    /// and `dp(10)` after, which puts a grouped row's title (indented `dp(32)`)
    /// in the same column as the heading above it. That alignment is the whole
    /// reason the row indent is 32 rather than something rounder.
    private func header(_ group: Group) -> some View {
        HStack(spacing: 0) {
            if !group.isIndependent {
                Image(systemName: "folder")
                    .font(.system(size: Palette.textRowStrong))
                    .foregroundColor(Palette.ink)
                    .frame(width: 20, height: 24)
                    .padding(.leading, 2)
                    .padding(.trailing, 10)
            }
            Button { model.toggleCollapsed(group.id) } label: {
                HStack(spacing: 6) {
                    Text(group.name)
                        .font(.system(size: Palette.textRow, weight: .medium))
                        .foregroundColor(group.isIndependent ? Palette.muted : Palette.ink)
                        .lineLimit(1)
                    Image(systemName: folded(group) ? "chevron.right" : "chevron.down")
                        .font(.system(size: Palette.textNote, weight: .semibold))
                        .foregroundColor(Palette.muted)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.usesChinese
                ? "\(group.name)，\(group.rows.count) 个会话，\(folded(group) ? "展开" : "折叠")"
                : "\(group.name), \(group.rows.count) conversations, \(folded(group) ? "expand" : "collapse")")

            Spacer(minLength: 8)

            // Offered whether or not this desktop may take the command, and it
            // says why when it may not: Android draws the button either way, and
            // a control that silently does nothing reads as a bug.
            Button {
                model.beginCreateConversation(workspaceId: group.isIndependent ? nil : group.id)
            } label: {
                Image(systemName: "plus.bubble")
                    .font(.system(size: Palette.textTitle))
                    .foregroundColor(Palette.muted)
                    .frame(width: 48, height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(group.isIndependent
                ? (model.usesChinese ? "新建独立会话" : "New independent conversation")
                : (model.usesChinese ? "新建会话：\(group.name)" : "New conversation: \(group.name)"))
        }
        .frame(minHeight: 48)
        .padding(.top, 12)
        .padding(.trailing, 4)
        .plainPageRow()
    }

    private func row(_ conversation: RemoteConversation, grouped: Bool) -> some View {
        SwiftUI.Group {
            if selecting {
                Button { toggle(conversation.id) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: selection.contains(conversation.id) ? "checkmark.circle.fill" : "circle")
                            .foregroundColor(selection.contains(conversation.id) ? Palette.accent : Palette.muted)
                        ConversationRowView(conversation: conversation, unread: model.isUnread(conversation))
                    }
                }
            } else {
                NavigationLink(destination: ConversationDetailView(conversation: conversation,
                                                                  onComputerPickerAction: onComputerPickerAction)
                    .environmentObject(model)) {
                    ConversationRowView(conversation: conversation, unread: model.isUnread(conversation))
                }
                .contextMenu { conversationActions(conversation) }
            }
        }
        .buttonStyle(.plain)
        .padding(.leading, grouped ? 32 : 2)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .plainPageRow()
    }

    private func toggle(_ id: String) {
        if selection.contains(id) { selection.remove(id) } else { selection.insert(id) }
    }

    /// The multi-select actions, as a row at the top of the column.
    ///
    /// That is where Android puts them — `renderConversations` adds them to the
    /// content ahead of the workspace heading — and the two buttons are
    /// half-width capsules with no gap between them, because that is how
    /// `LayoutParams(0, -2, 1)` and a bare `addView` come out.
    private var selectionRow: some View {
        HStack(spacing: 0) {
            selectionAction("取消多选") {
                selecting = false
                selection = []
            }
            selectionAction(model.usesChinese ? "删除所选（\(selection.count)）"
                            : "Delete selected (\(selection.count))",
                            enabled: !selection.isEmpty && model.access.canManageConversations
                                && !model.hasPendingListOperation && !model.commandBusy) {
                prompt = .delete(Array(selection))
            }
        }
        .plainPageRow()
    }

    private var pendingOperationRow: some View {
        Button { model.retryPendingListOperation() } label: {
            HStack(spacing: 10) {
                if model.commandBusy { ProgressView().progressViewStyle(.circular) }
                Text(LocalizedStringKey(model.commandBusy ? "正在查询操作结果…" : "查询操作结果 / 重试"))
                    .font(.system(size: Palette.textBody, weight: .medium))
                    .foregroundColor(Palette.accent)
                Spacer(minLength: 8)
                if !model.commandBusy {
                    Image(systemName: "arrow.clockwise")
                        .foregroundColor(Palette.accent)
                }
            }
            .frame(minHeight: 48)
            .padding(.horizontal, 12)
            .background(RoundedRectangle(cornerRadius: Palette.radius, style: .continuous)
                .fill(Palette.surface))
        }
        .buttonStyle(.plain)
        .disabled(model.commandBusy)
        .plainPageRow()
    }

    /// One half of the selection row: a 14sp capsule of `surface`, dimmed rather
    /// than disabled-looking, which is Android's `enabledColors(ink, muted)`.
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

    private func conversationActions(_ conversation: RemoteConversation) -> some View {
        ConversationActionsMenu(pinned: conversation.pinned,
                                rename: {
                                    renameTitle = conversation.title
                                    renameError = nil
                                    prompt = .rename(conversation)
                                }, select: {
                                    selection = [conversation.id]
                                    selecting = true
                                }, pin: { model.togglePin(conversation) },
                                archive: {
                                    if model.access.canArchive {
                                        model.archiveConversation(conversation)
                                    } else {
                                        model.notice = .init(text: "这台电脑未开放归档，请更新电脑端并授予控制权限。",
                                                             serious: false)
                                    }
                                }, delete: { prompt = .delete([conversation.id]) },
                                fork: model.access.canCreate && model.access.capabilities.contains(.fork)
                                    ? { model.forkConversation(conversation) } : nil)
            .disabled(!model.access.canManageConversations || model.commandBusy || model.hasPendingListOperation)
    }

    private enum ListPrompt {
        case rename(RemoteConversation)
        case delete([String])
    }

    @ViewBuilder private var actionPromptPanel: some View {
        if let prompt {
            ZStack(alignment: .bottom) {
                Color.black.opacity(0.28).ignoresSafeArea()
                    .onTapGesture { self.prompt = nil }
                SwiftUI.Group {
                    switch prompt {
                    case .rename(let conversation):
                        SettingsTextPanel(title: "重命名", placeholder: "会话标题",
                                          text: $renameTitle, error: $renameError,
                                          onSave: { commitRename(conversation) },
                                          onCancel: { self.prompt = nil })
                    case .delete(let ids):
                        SettingsMessagePanel(title: ids.count == 1 || model.usesChinese ? "删除会话？" : "Delete chats?",
                                             message: deleteMessage(ids), confirmTitle: "删除",
                                             cancelTitle: "取消", onConfirm: {
                                                 self.prompt = nil
                                                 model.deleteConversations(ids) {
                                                     selecting = false
                                                     selection = []
                                                 }
                                             }, onCancel: { self.prompt = nil })
                    }
                }
                .frame(maxWidth: 560)
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
            }
        }
    }

    private func commitRename(_ conversation: RemoteConversation) {
        let value = ComposerText.androidTrim(renameTitle)
        guard !value.isEmpty, ComposerText.utf16Length(value) <= 100 else {
            renameError = "请输入 1–100 字标题"
            return
        }
        prompt = nil
        model.renameConversation(conversation, to: value)
    }

    private func deleteMessage(_ ids: [String]) -> String {
        if ids.count == 1 {
            return "将永久删除此会话在电脑端的聊天记录，无法撤销；不会删除工作区文件。"
        }
        return model.usesChinese
            ? "将永久删除电脑端所选的 \(ids.count) 个会话，无法撤销；不会删除工作区文件。"
            : "Permanently deletes the \(ids.count) selected chats on your computer, not workspace files. This cannot be undone."
    }

    /// Whether the list is replaced wholesale by a message.
    ///
    /// Only when there is genuinely nothing to draw. A first load shows its own
    /// message: the earlier version kept the (empty) list instead, so that the
    /// placeholder would not flash over a list that was about to arrive — but
    /// with nothing cached there is no list to protect, and the result was a
    /// blank screen for the length of the fetch and *forever* if the fetch never
    /// answered. A failed fetch is the same picture and gets its own wording
    /// plus a way to try again. Android shows its empty-state block even when
    /// empty workspace headings or the independent heading precede it.
    private var showsPlaceholder: Bool {
        if model.conversations.isEmpty, model.listLoading || model.listError != nil { return true }
        if model.isSearching { return !model.hasMatches }
        return model.conversations.isEmpty
    }

    /// What the list draws when it has nothing to draw.
    ///
    /// On a `ScrollView`, not a `List`, and that is not a shortcut: the state is
    /// a *block* at the top of the column, under the workspace heading, and a
    /// `List` would centre it or stretch its rows to fill. `ChatEmptyState` is
    /// added to `content` after the workspace headings in `renderConversations`,
    /// including when those groups contain no conversations. Keep the column
    /// scrollable when the desktop advertises more workspaces than fit here.
    private var placeholder: some View {
        ScrollView {
            VStack(spacing: 0) {
                if model.hasPendingListOperation { pendingOperationRow }
                workspaceHeading
                ForEach(groups) { group in header(group) }
                emptyState
                if model.nextListOffset >= 0 { loadMoreRow }
            }
            .padding(.horizontal, PageGutter.horizontal)
            .padding(.bottom, PageGutter.contentBottom)
        }
        .background(Palette.background.ignoresSafeArea())
    }

    /// Android's `ChatEmptyState`, in its geometry: a 52-point line icon, a 21sp
    /// medium heading, a 14sp muted line under it, and a capsule of `surface`
    /// for the one action — all inside 20/44/20/36 of padding over a 260-point
    /// minimum, which is what keeps the block from riding up under the heading.
    private var emptyState: some View {
        VStack(spacing: 0) {
            Image(systemName: symbol)
                .font(.system(size: 34))
                .foregroundColor(Palette.muted)
                .frame(width: 52, height: 52)
            Text(LocalizedStringKey(title))
                .font(.system(size: Palette.textDisplay, weight: .medium))
                .foregroundColor(Palette.ink)
                .multilineTextAlignment(.center)
                .padding(.top, 20)
                .padding(.bottom, 8)
            Text(LocalizedStringKey(emptyDetail))
                .font(.system(size: Palette.textBody))
                .foregroundColor(Palette.muted)
                .multilineTextAlignment(.center)
                .lineSpacing(4)
            emptyAction
                .padding(.top, 20)
        }
        .frame(maxWidth: .infinity)
        .padding(EdgeInsets(top: 44, leading: 20, bottom: 36, trailing: 20))
        .frame(minHeight: 260)
    }

    /// The line under the heading. Android has one for each state: an error, a
    /// search that found nothing, a wait, or a list that is empty because its
    /// conversations are organised into workspaces — and that last one is worth
    /// the line, because a column that is empty for a reason looks unbuilt
    /// otherwise.
    private var emptyDetail: String {
        if let error = model.listError { return error }
        if model.isSearching { return "试试更短的关键词，或清除搜索查看全部会话。" }
        if let detail = loadingDetail { return detail }
        return "会话会按工作区整理，方便下次继续。"
    }

    @ViewBuilder
    private var emptyAction: some View {
        if model.hasPendingListOperation {
            emptyButton("查询操作结果 / 重试") { model.retryPendingListOperation() }
        } else if model.listError != nil {
            emptyButton("重试") { model.refreshList() }
        } else if model.isSearching {
            emptyButton("清除搜索") { model.search = "" }
        } else if model.listLoadingMore {
            EmptyView()
        } else if model.listLoading {
            EmptyView()
        } else {
            emptyButton(canCreateFromEmpty ? "新建会话" : "刷新列表") {
                if canCreateFromEmpty {
                    model.beginCreateConversation(workspaceId: model.workspaces.first?.id)
                } else {
                    model.refreshList()
                }
            }
        }
    }

    /// The APK uses its first advertised workspace for the empty-state action;
    /// only a computer with no workspaces may create an independent conversation.
    private var canCreateFromEmpty: Bool {
        model.access.canCreate && (!model.workspaces.isEmpty || model.includeUnassigned)
    }

    private func emptyButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(LocalizedStringKey(label))
                .font(.system(size: Palette.textInput))
                .foregroundColor(Palette.ink)
                .frame(minHeight: 48)
                .padding(.horizontal, 20)
                .background(Capsule(style: .continuous).fill(Palette.surface))
        }
        .buttonStyle(.plain)
    }

    private var symbol: String {
        if model.listError != nil { return "exclamationmark.triangle" }
        if model.isSearching { return "magnifyingglass" }
        // Android swaps the icon between the two empty cases: its "new" mark —
        // a speech bubble with a plus in it — when there is somewhere to start,
        // a magnifier when there was a query.
        return model.listLoading ? "bubble.left.and.bubble.right" : "plus.bubble"
    }

    private var title: String {
        if model.isSearching, model.listError == nil {
            return model.listLoadingMore ? "正在搜索会话…" : "没有找到会话"
        }
        if model.listError != nil { return "没能取到会话列表" }
        if model.listLoading {
            // Three different waits, and saying which one it is stops the
            // screen from looking stuck: the tunnel signing in, the tunnel
            // coming up, or the desktop answering.
            if model.needsLogin { return "需要先登录 Tailscale" }
            if !model.nodeRunning { return "正在连接电脑…" }
            return "正在载入会话…"
        }
        return "在这里开始新的工作"
    }

    /// The node's own state, shown while a first load is still waiting.
    ///
    /// A screen that waits silently is indistinguishable from one that has
    /// failed, and the tunnel is the part most likely to be the reason.
    private var loadingDetail: String? {
        guard model.listLoading, model.listError == nil, !model.nodeRunning else { return nil }
        return model.usesChinese ? "节点状态：\(model.nodeLabel)" : "Node status: \(model.nodeStatus.label(chinese: false))"
    }
}

struct ConversationRowView: View {
    @EnvironmentObject private var model: AppModel
    let conversation: RemoteConversation
    /// Whether the desktop has a reply this phone has not shown yet.
    var unread = false

    var body: some View {
        // Title and state on one line, as Android's row draws them. The state is
        // the whole second column there — activity, an unread reply and a pin
        // run together into one badge — so a row with nothing to report is one
        // line rather than two, which is what makes a long list scannable.
        //
        // The title's 36-point minimum is `ConversationRow`'s `setMinHeight`, and
        // it is what makes every row the same height whether or not it carries a
        // badge: the badge is 12sp on its own baseline and would otherwise pull
        // the row in.
        HStack(spacing: 0) {
            // The title is the weighted child, exactly as `LayoutParams(0, -2,
            // 1)` makes it: it takes whatever the badge does not, and it is the
            // badge that yields when the row is narrow. A `Spacer` between the
            // two would look the same and measure differently — it is the most
            // flexible child in the row, so it grows first and the title
            // truncates at a width nobody asked for.
            //
            // The two frames are in this order on purpose, and swapping them
            // costs two characters of every title. `.frame(minHeight:)` put
            // *inside* the width frame still ends up deciding the width — it
            // reports the text's own ideal width, and the flexible frame around
            // it then stretches that already-decided view instead of proposing
            // the column to the text, so the row drew about 24 points of title
            // short of the space the badge had left for it. Widening first and
            // setting the 36-point minimum last is what makes the text lay out
            // against the real column: measured on a 402-point screen the title
            // column comes out at 236 points, which is Android's arithmetic to
            // the point (`366 - 32 - 8 - 90`, the badge and its 8dp of lead).
            Text(conversation.title.isEmpty ? "未命名会话" : conversation.title)
                .font(.system(size: Palette.textRow))
                .foregroundColor(Palette.ink)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(minHeight: 36)
            if !badge.isEmpty {
                // Sized to its own text, not to a limit: Android's badge is
                // WRAP_CONTENT with `setMaxWidth(dp(152))`, and the longest
                // badge it can build — "等待电脑处理 · 新消息 · 已置顶" — is
                // under 152 anyway, so the cap never binds. What does bind is
                // that the badge must not *grow*: a `frame(maxWidth:)` reports
                // the width it is offered rather than the width it needs, and
                // with the title also flexible the two came out splitting the
                // row in half.
                Text(badge)
                    .font(.system(size: Palette.textSmall))
                    .foregroundColor(Palette.accent)
                    .lineLimit(1)
                    // `setEllipsize(END)`: the badge is one string joined by
                    // separators, and which part survives has to be the front of
                    // it — the activity is the reason the row is worth a look.
                    .truncationMode(.tail)
                    .padding(.leading, 8)
            }
        }
    }

    /// The right-hand badge: how the conversation is running, whether a reply is
    /// waiting, and whether it is pinned — in the order Android joins them, and
    /// with the idle case omitted rather than spelled out, because "空闲" on
    /// every row is a column of noise.
    private var badge: String {
        var parts: [String] = []
        switch conversation.activity {
        case .running: parts.append(model.usesChinese ? "正在运行" : "Running")
        case .permission, .question: parts.append(model.usesChinese ? "等待电脑处理" : "Waiting for desktop input")
        case nil: break
        }
        if unread { parts.append(model.usesChinese ? "新消息" : "New messages") }
        if conversation.pinned { parts.append(model.usesChinese ? "已置顶" : "Pinned") }
        return parts.joined(separator: " · ")
    }
}

/// The line under the list that says whether the live stream is holding.
///
/// Android's single status `TextView`, which `dockStatus` trims to `dp(2)` of
/// padding and which every chat page shares: 11sp, the muted tone, centred, and
/// — the part that matters — on the page colour rather than on a surface, so a
/// disconnect reads as a line of the page rather than as a banner.
struct StreamBar: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            if let note {
                Button { model.statusDetails = note } label: {
                    Text(verbatim: note)
                        .font(.system(size: Palette.textTiny))
                        .foregroundColor(Palette.muted)
                        .multilineTextAlignment(.center)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 2)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(note)
                .accessibilityHint(model.usesChinese ? "打开完整状态与错误详情"
                    : "Open full status and error details")
            }
        }
    }

    /// What the list is doing, in one line.
    ///
    /// "Showing cached conversations" comes first because it is the one state
    /// where the screen is right and the list is stale — Android shows exactly
    /// this while a fetch is in flight over rows it already has, and keeps it
    /// up when the fetch cannot start at all, which is the case that would
    /// otherwise leave the screen silently claiming the list is current.
    private var note: String? {
        if model.listLoading, !model.conversations.isEmpty {
            return model.usesChinese ? "显示上次缓存，正在同步…"
                : "Showing cached conversations; syncing…"
        }
        if let failure = model.detailAccessFailure, model.openId != nil {
            return detailFailureText(failure)
        }
        switch model.streamState {
        case .idle, .connected:
            if model.openId == nil, !model.conversations.isEmpty,
               let error = model.listError {
                return error
            }
            return nil
        case .reconnecting(let delay, _):
            return model.usesChinese
                ? "正在重连（\(Int(delay)) 秒后），当前显示上次同步内容。"
                : "Reconnecting in \(Int(delay)) s; displayed content may be stale."
        case .unsupported:
            return model.usesChinese ? "电脑端版本较旧，已改为定时刷新列表。"
                : "Older desktop; refreshing the list periodically."
        case .failed(let error):
            guard let http = error as? RemoteHttpError else {
                return model.usesChinese ? "已断开连接。" : "Disconnected."
            }
            let reason = RemoteFailure.httpMessage(status: http.status,
                                                   detail: http.detail,
                                                   chinese: model.usesChinese)
            if http.status == 404, model.openId != nil {
                let unavailable = model.usesChinese ? "会话不可用，可能已归档或不再授权。"
                    : "Conversation unavailable, archived or no longer authorized."
                return unavailable + "\n" + reason
            }
            return reason
        }
    }

    private func detailFailureText(_ failure: AppModel.DetailAccessFailure) -> String {
        let reason = RemoteFailure.httpMessage(status: failure.status,
                                               detail: failure.detail,
                                               chinese: model.usesChinese)
        guard failure.status == 404 else { return reason }
        let unavailable = model.usesChinese ? "会话不可用，可能已归档或不再授权。"
            : "Conversation unavailable, archived or no longer authorized."
        let restored = failure.restoredDraft
            ? (model.usesChinese ? " 未确认的消息已恢复到输入框且未发送。"
                : " The unconfirmed message was returned to the box and was not sent.")
            : ""
        return unavailable + restored + "\n" + reason
    }
}

/// The same status-detail sheet Android opens by tapping its one-line dock:
/// the untruncated text remains selectable and can be copied in one action.
struct StatusDetailsPanel: View {
    let message: String
    let maximumHeight: CGFloat
    let onCopy: () -> Void
    let onClose: () -> Void
    @State private var messageHeight: CGFloat = 48

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Palette.divider)
                .frame(width: 36, height: 4)
                .padding(.bottom, 16)
                .accessibilityHidden(true)
            Text("状态与错误详情")
                .font(.system(size: Palette.textDisplay, weight: .medium))
                .foregroundColor(Palette.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8)
                .padding(.top, 4)
                .padding(.bottom, 18)
                .accessibilityAddTraits(.isHeader)
            ScrollView {
                Text(verbatim: message)
                    .font(.system(size: Palette.textInput))
                    .foregroundColor(Palette.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(GeometryReader { geometry in
                        Color.clear.preference(key: StatusDetailsHeightKey.self,
                                               value: geometry.size.height)
                    })
            }
            // Grip, title, two 52pt actions and padding use about 220pt;
            // only the error body scrolls when the available height shrinks.
            .frame(height: min(max(48, messageHeight),
                               min(420, max(48, maximumHeight - 220))))
            .onPreferenceChange(StatusDetailsHeightKey.self) { messageHeight = $0 }
            .background(RoundedRectangle(cornerRadius: Palette.groupRadius, style: .continuous)
                .fill(Palette.card))
            VStack(spacing: 8) {
                SettingsDialogAction(title: "关闭", primary: false, action: onClose)
                SettingsDialogAction(title: "复制", primary: false, action: onCopy)
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

private struct StatusDetailsHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 48
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

/// The screen an empty conversation opens on.
///
/// Android draws this rather than an empty transcript (`ChatEmptyState` reached
/// from `MainActivity`'s detail build): a new conversation on the phone is a
/// blank column otherwise, which reads as a screen that failed to load rather
/// than as one waiting for a first message.
struct EmptyConversationView: View {
    @EnvironmentObject private var model: AppModel
    let onWrite: () -> Void

    var body: some View {
        EmptyStateView(mark: .brand, title: "从这里开始",
                       message: "描述任务，继续电脑上的工作。") {
            EmptyStateActionButton(title: "输入消息", action: onWrite)
        }
    }
}

// MARK: - Detail

struct ConversationDetailView: View {
    let conversation: RemoteConversation
    let onComputerPickerAction: (ComputerPickerAction) -> Void
    @EnvironmentObject private var model: AppModel
    /// The way back, now that the system's own button is hidden in favour of
    /// Android's disc.
    @Environment(\.dismiss) private var dismiss
    @State private var showArtifacts = false
    @State private var showAttachPanel = false
    @State private var showCamera = false
    @State private var showImages = false
    @State private var showDocuments = false
    @State private var attachPanelHeight: CGFloat = 460
    /// The picker for moving to another paired computer, which Android keeps in
    /// the same header as the title.
    @State private var showComputerPicker = false
    @State private var remotePopup: RemoteSettingsPopupView.Mode?
    @State private var modelAnchor: CGRect?
    @State private var permissionAnchor: CGRect?
    /// The row to keep at the top once an earlier page is inserted above it, so
    /// loading history does not throw the person out of what they were reading.
    @State private var olderAnchor: AnyHashable?
    /// Whether the reader is close enough to the end to be followed while a
    /// reply streams. Android asks the same question with
    /// `content.bottom - viewport.bottom < dp(120)`.
    @State private var follow = ScrollFollowTracker()
    /// Set on open and on send, where Android scrolls to the end outright
    /// rather than only from the bottom. Cleared by the first follow.
    @State private var pendingFollow = true
    @State private var showsSubtaskPage = false
    @State private var subtaskTurn: Int64 = 0
    @State private var selectedSubtask: String?

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        olderControl()
                        ForEach(model.transcript.earlierSubtaskTurns, id: \.self) { turn in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(model.usesChinese ? "更早轮次的子任务" : "Subtasks from an earlier turn")
                                    .font(.caption).foregroundColor(Palette.muted)
                                SubtaskTurnCard(tasks: model.transcript.subagents.filter { $0.userSeq == turn }) { id in
                                    selectedSubtask = id; subtaskTurn = turn; showsSubtaskPage = true
                                }.environmentObject(model)
                            }.id("earlier-subtasks:\(turn)")
                        }
                        if showsEmptyState {
                            EmptyConversationView(onWrite: { model.focusComposer() })
                                .id("empty")
                        }
                        ForEach(model.transcript.messages, id: \.id) { row in
                            MessageView(row: row,
                                        editable: canEdit(row),
                                        onEdit: { model.beginEdit(row.id) },
                                        onOpenArtifacts: { showArtifacts = true })
                                .id(row.id)
                            if row.message.role == .user {
                                let tasks = model.transcript.subagents.filter { $0.userSeq == row.id }
                                if !tasks.isEmpty {
                                    SubtaskTurnCard(tasks: tasks) { id in
                                        selectedSubtask = id; subtaskTurn = row.id; showsSubtaskPage = true
                                    }.environmentObject(model)
                                }
                            }
                        }
                        if let live = model.transcript.live {
                            LiveView(live: live, process: model.transcript.liveProcess).id("live")
                            if live.showsDesktopApprovalNotice(
                                canControl: model.transcript.permission == .control) {
                                Text("有待处理授权，请回到电脑处理。")
                                    .font(.system(size: Palette.textNote))
                                    .foregroundColor(Palette.accent)
                                    .id("desktop-approval-notice")
                            }
                            ForEach(live.visibleApprovals(
                                canControl: model.transcript.permission == .control)) { approval in
                                ApprovalCard(approval: approval).id("approval-\(approval.id)")
                            }
                        } else if !model.transcript.pendingProcess.isEmpty {
                            ProcessView(entries: model.transcript.pendingProcess)
                                .id("pendingProcess")
                        }
                        if let outgoing = model.outgoing, model.detailAccessFailure == nil {
                            PendingView(state: outgoing,
                                        at: model.outgoingAt,
                                        legacyImage: model.outgoingLegacyImage,
                                        chinese: model.usesChinese,
                                        showBubble: !model.outgoingBubbleIsSynced,
                                        retryEnabled: model.canDrive && !model.commandBusy
                                            && model.hasPendingDetailOperation,
                                        onRetry: { model.retryPendingDetailOperation() })
                                .id("outgoing")
                        }
                    }
                    .padding(.horizontal, PageGutter.horizontal)
                    .padding(.vertical, 12)
                    .measuringContentBottom()
                }
                .measuringViewportBottom()
                // Only a *newest* row moving scrolls to the bottom. Keying off
                // the last id rather than the count is what keeps loading an
                // earlier page from yanking the view down: a prepend changes the
                // count but leaves the newest row where it was.
                .onChange(of: model.transcript.messages.last?.id) { _ in
                    followIfNeeded(proxy, animated: true)
                }
                // The streamed answer follows only from the bottom, so scrolling
                // up to read survives the chunks arriving behind it. Both the
                // text and the tool steps count as growth; the scroll is left
                // unanimated because it fires on every chunk.
                .onChange(of: model.transcript.live?.text) { _ in
                    followIfNeeded(proxy, animated: false)
                }
                .onChange(of: model.transcript.liveProcess) { _ in
                    followIfNeeded(proxy, animated: false)
                }
                .onChange(of: model.transcript.pendingProcess) { _ in
                    followIfNeeded(proxy, animated: false)
                }
                // Sending is the one move that is followed from anywhere — it
                // is about to become the newest row.
                .onChange(of: sendingNow) { sending in
                    guard sending else { return }
                    pendingFollow = true
                    followIfNeeded(proxy, animated: true)
                }
                .onChange(of: model.olderTick) { _ in
                    if let anchor = olderAnchor {
                        withAnimation { proxy.scrollTo(anchor, anchor: .top) }
                    }
                    olderAnchor = nil
                }
            }
            .trackingScrollFollow(follow)
            // Goal and scheduled-task state sits directly above the composer,
            // where it is visible while typing but never covers the transcript —
            // Android's `automationBar` and `queueBar`, in that order.
            RemoteStatusBars()
                .environmentObject(model)
            Composer(onAttach: { showAttachPanel = true },
                     onModelPicker: { remotePopup = .models },
                     onPermission: { remotePopup = .permissions })
                .environmentObject(model)
            // The status line is *under* the composer, not over it: Android's
            // `composerBar` dock is a fade, the bar and then the status, and a
            // status that pushed the composer up off the bottom would move the
            // one thing the thumb is aiming at. The list screen already says
            // whether the stream is holding; the conversation needs the same
            // line, because a reply that stops arriving is the thing a person is
            // most likely to be staring at.
            StreamBar()
                .environmentObject(model)
        }
        .background(Palette.background)
        .coordinateSpace(name: "remote-chat-detail")
        .onPreferenceChange(RemoteModelAnchorKey.self) { modelAnchor = $0 }
        .onPreferenceChange(RemotePermissionAnchorKey.self) { permissionAnchor = $0 }
        .overlay {
            GeometryReader { geometry in
                if showComputerPicker {
                    ZStack(alignment: .topTrailing) {
                        PopupDismissArea { showComputerPicker = false }
                        ComputerPickerPopupView(
                            maxHeight: max(96, min(520, geometry.size.height - 32)),
                            onAction: pickComputer)
                            .environmentObject(model)
                            .frame(width: min(312, geometry.size.width - 24))
                            .padding(.top, 8)
                            .padding(.trailing, 12)
                    }
                } else if showArtifacts {
                    ZStack(alignment: .bottom) {
                        Color.black.opacity(0.28).contentShape(Rectangle())
                            .onTapGesture { showArtifacts = false }
                        ArtifactSheetView(onClose: { showArtifacts = false })
                            .environmentObject(model)
                            .frame(width: min(560, geometry.size.width - 24),
                                   height: min(660, geometry.size.height * 0.83))
                            .padding(.bottom, 12)
                    }
                } else if showAttachPanel {
                    ZStack(alignment: .bottom) {
                        Color.black.opacity(0.28).contentShape(Rectangle())
                            .onTapGesture { showAttachPanel = false }
                        ScrollView(.vertical, showsIndicators: false) {
                            AttachSheetView(onClose: { showAttachPanel = false },
                                            onPick: pickAttachment)
                                .environmentObject(model)
                                .background(GeometryReader { panel in
                                    Color.clear.preference(key: RemoteAttachHeightKey.self,
                                                           value: panel.size.height)
                                })
                        }
                        .frame(width: min(560, geometry.size.width - 24),
                               height: min(max(160, geometry.size.height - 32), attachPanelHeight))
                        .clipShape(RoundedRectangle(cornerRadius: Palette.sheetRadius, style: .continuous))
                        .padding(.bottom, 12)
                    }
                } else if let popup = remotePopup,
                   let anchor = popup == .models ? modelAnchor : permissionAnchor {
                    let width = min(320, geometry.size.width - 24)
                    ZStack(alignment: .bottomLeading) {
                        PopupDismissArea { remotePopup = nil }
                        RemoteSettingsPopupView(
                            mode: popup,
                            maxHeight: max(48, anchor.minY - 18),
                            onDismiss: { remotePopup = nil })
                            .environmentObject(model)
                            .frame(width: width)
                            .padding(.leading, min(max(12, anchor.minX),
                                                   max(12, geometry.size.width - width - 12)))
                            .padding(.bottom, max(0, geometry.size.height - anchor.minY + 6))
                    }
                }
            }
            .allowsHitTesting(showComputerPicker || showArtifacts || showAttachPanel || remotePopup != nil)
        }
        .onPreferenceChange(RemoteAttachHeightKey.self) { attachPanelHeight = $0 }
        .onChange(of: remoteSettingsAvailable) { available in
            if !available { remotePopup = nil }
        }
        .simultaneousGesture(TapGesture().onEnded { model.userInteracted() })
        .simultaneousGesture(DragGesture(minimumDistance: 8)
            .onChanged { _ in model.userInteracted() })
        .navigationBarTitleDisplayMode(.inline)
        // The system's own back chevron is replaced by Android's raised disc —
        .background(NavigationLink(destination: SubtaskDetailPage(userSeq: subtaskTurn, selectedID: selectedSubtask)
            .id("\(model.transcript.instanceId):\(subtaskTurn):\(selectedSubtask ?? "list")").environmentObject(model),
            isActive: $showsSubtaskPage) { EmptyView() }.hidden())
        // one `shell()` branch builds the list's header and this one's alike, and
        // the system's blue arrow is a different colour, size and shape from the
        // button every other chat page in the pair carries.
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                RoundBackButton {
                    if showComputerPicker { showComputerPicker = false }
                    else if remotePopup != nil { remotePopup = nil }
                    else { dismiss() }
                }
                    .disabled(showArtifacts || showAttachPanel)
            }
            ToolbarItem(placement: .principal) {
                // Android's detail header is the conversation's title over the
                // *computer's* name, exactly as the list's is. The
                // "电脑执行 · 手机查看" line that `detailScreen()` passes into
                // `shell()` is never read: `shell()`'s list/detail branch draws
                // the computer row and ignores its `subtitle` argument.
                RemotePageHeading(
                    title: conversation.title.isEmpty ? "会话" : conversation.title,
                    computer: model.current?.displayName ?? "",
                    note: RemoteConnectionNote.text(for: model.streamState,
                                                    chinese: model.usesChinese))
            }
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                // Android's detail header carries the switch-computer control
                // and nothing else; the model and the safety level moved down
                // into the composer's tool row, where the hand already is.
                Button { showComputerPicker.toggle() } label: {
                    SwitchComputerIcon()
                }
                    .accessibilityLabel(model.usesChinese ? "切换电脑" : "Switch computer")
                    .disabled(showArtifacts || showAttachPanel)
            }
        }
        .sheet(isPresented: $showCamera) {
            let computer = model.current?.address
            CameraPicker(onPicked: { image in
                showCamera = false
                guard model.openId == conversation.id, model.current?.address == computer else { return }
                model.addImages([image])
            }, onCancel: { showCamera = false })
        }
        .sheet(isPresented: $showImages) {
            let computer = model.current?.address
            PhotoPicker(limit: max(1, model.access.attachmentCount - model.attachments.count),
                        onPicked: { images in
                            showImages = false
                            guard model.openId == conversation.id, model.current?.address == computer else { return }
                            model.addEncodedImages(images)
                        }, onCancel: { showImages = false },
                        onFailure: {
                            showImages = false
                            guard model.openId == conversation.id,
                                  model.current?.address == computer else { return }
                            model.notice = .init(text: AttachmentError.unreadableImage.localizedDescription,
                                                 serious: false)
                        })
        }
        .sheet(isPresented: $showDocuments) {
            let computer = model.current?.address
            DocumentPicker(onPicked: { files in
                showDocuments = false
                guard model.openId == conversation.id, model.current?.address == computer else { return }
                model.addFiles(files)
            }, onCancel: { showDocuments = false })
        }
        .sheet(item: $model.locationConsent, onDismiss: { model.locationDismissed() }) { consent in
            LocationConsentSheet(
                consent: consent,
                onAllow: { model.allowLocation() },
                onSkip: { model.skipLocation() },
                onCancel: { model.cancelLocation() })
        }
        .onAppear {
            if model.openId != conversation.id {
                pendingFollow = true
                model.open(conversation.id)
            }
        }
        .onDisappear {
            showAttachPanel = false
            showComputerPicker = false
            remotePopup = nil
            if !showsSubtaskPage { model.close() }
        }
    }

    private func pickComputer(_ action: ComputerPickerAction) {
        showComputerPicker = false
        if case .open(let computer) = action,
           computer.address == model.current?.address { return }
        dismiss()
        onComputerPickerAction(action)
    }

    private func pickAttachment(_ action: AttachSheetView.Action) {
        showAttachPanel = false
        switch action {
        case .camera: showCamera = true
        case .photos: showImages = true
        case .files: showDocuments = true
        case .artifacts: showArtifacts = true
        case .permission: remotePopup = .permissions
        }
    }

    private var remoteSettingsAvailable: Bool {
        model.canDrive && model.transcript.settings?.editable == true
            && !model.commandBusy && !model.hasPendingDetailOperation
            && model.outgoing?.showsBubble != true
    }

    /// The newest thing the transcript can scroll to: the message box while a
    /// send is in flight, then the live reply, then the newest finished row.
    private var bottomId: AnyHashable? {
        if model.outgoing != nil, model.detailAccessFailure == nil {
            return AnyHashable("outgoing")
        }
        if model.transcript.live != nil { return AnyHashable("live") }
        if !model.transcript.pendingProcess.isEmpty { return AnyHashable("pendingProcess") }
        return model.transcript.messages.last.map { AnyHashable($0.id) }
    }

    /// Whether a message the phone sent is still waiting for the desktop.
    private var sendingNow: Bool {
        if case .sending = model.outgoing { return true }
        return false
    }

    /// Whether to draw the invitation in place of a transcript.
    ///
    /// A conversation that has not been opened before arrives empty, and so does
    /// one whose history has not come back yet — but only the first should be
    /// invited to write. A message already going out counts as content, or the
    /// invitation would sit above the bubble it is waiting for.
    private var showsEmptyState: Bool {
        model.transcript.messages.isEmpty && model.transcript.live == nil
            && model.transcript.pendingProcess.isEmpty && model.outgoing == nil
            && model.detailAccessFailure == nil
    }

    /// Scrolls to the newest row when the reader is at the end — or when the
    /// move was asked for outright, which is opening the conversation and
    /// sending a message, the two places Android scrolls unconditionally.
    private func followIfNeeded(_ proxy: ScrollViewProxy, animated: Bool) {
        guard !showsSubtaskPage else { return }
        guard let target = bottomId else { return }
        guard pendingFollow || follow.isAtBottom else { return }
        pendingFollow = false
        follow.following()
        if animated {
            withAnimation { proxy.scrollTo(target, anchor: .bottom) }
        } else {
            proxy.scrollTo(target, anchor: .bottom)
        }
    }

    /// The "load earlier messages" control Android keeps at the top of the
    /// transcript, alongside its pull-down.
    ///
    /// iOS 15 has no pull-to-load on a plain `ScrollView` — `refreshable` only
    /// reaches a `List` at this deployment target — so the button Android also
    /// keeps carries the whole feature here. It disappears once the desktop has
    /// no cursor left, and while a page is in flight it becomes a spinner and
    /// stops accepting taps, which is the same pair of states Android shows.
    @ViewBuilder
    private func olderControl() -> some View {
        if model.loadingOlder {
            HStack(spacing: 8) {
                ProgressView().scaleEffect(0.7)
                Text("正在加载更早消息…").font(.system(size: Palette.textSmall)).foregroundColor(Palette.muted)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        } else if model.hasOlder {
            Button {
                olderAnchor = model.transcript.messages.first?.id
                model.loadOlder()
            } label: {
                Text("加载更早消息")
                    .font(.system(size: Palette.textSmall))
                    .foregroundColor(Palette.muted)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.plain)
        }
    }

    /// Whether a row offers a rewrite.
    ///
    /// Only the newest user turn, and only while the desktop is idle: a reply
    /// in flight would be discarded by the edit, and the desktop refuses a
    /// rewrite of anything but the last user message anyway. The offer is
    /// withdrawn once edit mode is already on, so the pencil cannot be tapped
    /// twice into a state the user cannot see.
    private func canEdit(_ row: RenderedMessage) -> Bool {
        row.isEditCandidate(lastUserSeq: model.transcript.lastUserSeq)
            && !model.transcript.busy
            && model.editingSeq == nil
            && model.canDrive
    }
}

private struct MessageView: View {
    let row: RenderedMessage
    let editable: Bool
    let onEdit: () -> Void
    let onOpenArtifacts: () -> Void

    var body: some View {
        VStack(alignment: row.message.role == .user ? .trailing : .leading, spacing: 6) {
            if row.message.role != .user && row.message.textTruncated {
                Text("内容过长，仅显示末尾片段。")
                    .font(.system(size: Palette.textSmall))
                    .foregroundColor(Palette.accent)
            }
            if row.message.role != .user && !row.process.isEmpty {
                ProcessView(entries: row.process)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Group {
                if row.message.role == .user {
                    if editable {
                        Button(action: onEdit) { userBubble }
                            .buttonStyle(.plain)
                            .accessibilityLabel("点击编辑上一条消息")
                            .frame(maxWidth: .infinity, alignment: .trailing)
                            .padding(.leading, Palette.userInset)
                    } else {
                        userBubble
                            .frame(maxWidth: .infinity, alignment: .trailing)
                            .padding(.leading, Palette.userInset)
                    }
                } else if row.message.text.isEmpty {
                    if row.process.isEmpty {
                        Text("等待输出…")
                            .font(.system(size: Palette.textInput))
                            .foregroundColor(Palette.ink)
                    }
                } else {
                    AsyncMarkdownView(text: row.message.text)
                        .textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, alignment: row.message.role == .user ? .trailing : .leading)
            // Only a finished answer gets a file list: a live reply is still
            // naming files it has not written yet, so listing them would offer
            // a download of something that does not exist.
            if row.message.role != .user, !row.message.text.isEmpty {
                let files = ArtifactReferences.names(from: row.message.text)
                if !files.isEmpty {
                    ArtifactCard(names: files, onOpen: onOpenArtifacts)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 8)
                }
            }
            if !row.message.text.isEmpty {
                RemoteMessageFooter(text: row.message.text, at: row.message.at,
                                    user: row.message.role == .user)
            }
        }
        .frame(maxWidth: .infinity, alignment: row.message.role == .user ? .trailing : .leading)
        // An answer takes the whole column. Android's assistant block is
        // `MATCH_PARENT` with no side margins — the 44 points are the *user*
        // bubble's leading margin and have nothing to do with the reply, and
        // applying them here would narrow every paragraph by an inch.
    }

    // `messageBlock(true)`: padding 14/8/14/12 inside the bubble and a
    // 44-point leading inset. Android edits the newest complete user message
    // by tapping this bubble, not by showing a pencil in the footer.
    private var userBubble: some View {
        VStack(alignment: .leading, spacing: 0) {
            if row.message.textTruncated {
                Text("内容过长，仅显示末尾片段。")
                    .font(.system(size: Palette.textSmall))
                    .foregroundColor(Palette.accent)
            }
            if !row.process.isEmpty { ProcessView(entries: row.process) }
            Text(row.message.text.isEmpty ? "等待输出…" : row.message.text)
                .font(.body)
                .foregroundColor(Palette.ink)
        }
        .padding(EdgeInsets(top: 8, leading: 14, bottom: 12, trailing: 14))
        .background(RoundedRectangle(cornerRadius: Palette.radius, style: .continuous)
            .fill(Palette.surface))
    }
}

/// The answer being written right now.
private struct LiveView: View {
    let live: RemoteLive
    let process: [RemoteProcessEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if live.textTruncated {
                Text("内容过长，仅显示末尾片段。")
                    .font(.system(size: Palette.textSmall))
                    .foregroundColor(Palette.accent)
            }
            if !process.isEmpty { ProcessView(entries: process, live: true) }
            if live.text.isEmpty {
                if process.isEmpty {
                    Text("等待输出…")
                        .font(.system(size: Palette.textInput))
                        .foregroundColor(Palette.ink)
                }
            } else {
                AsyncMarkdownView(text: live.text, streaming: true)
                RemoteMessageFooter(text: live.text, at: live.startedAt, user: false)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The same copy/timestamp row Android uses for both finished and live text.
private struct RemoteMessageFooter: View {
    @Environment(\.locale) private var locale
    let text: String
    let at: Int64
    let user: Bool

    var body: some View {
        HStack(spacing: 0) {
            if user { Spacer(minLength: 0) }
            Button { UIPasteboard.general.string = text } label: {
                Image(systemName: "doc.on.doc")
                    .font(.system(size: Palette.textBody))
                    .foregroundColor(Palette.muted)
                    .frame(width: 48, height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("复制消息")
            if at > 0 {
                Text(time)
                    .font(.system(size: Palette.textSmall))
                    .foregroundColor(Palette.muted)
            }
            if !user { Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity, minHeight: 48)
    }

    private var time: String {
        let date = Date(timeIntervalSince1970: Double(at) / 1000)
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.dateFormat = locale.identifier.lowercased().hasPrefix("zh")
            ? "M月d日 HH:mm" : "MMM d, HH:mm"
        return formatter.string(from: date)
    }
}

private struct PendingView: View {
    let state: AppModel.OutgoingState
    let at: Int64
    let legacyImage: Bool
    let chinese: Bool
    let showBubble: Bool
    let retryEnabled: Bool
    let onRetry: () -> Void

    private var text: String {
        switch state {
        case .sending(let text), .preparing(let text), .accepted(let text),
             .unconfirmed(let text, _): return text
        case .failed(let draft): return draft
        }
    }

    private var value: String {
        text + (legacyImage ? (chinese ? "\n[图片]" : "\n[Image]") : "")
    }

    private var label: String {
        switch state {
        case .sending: return "正在发送…"
        case .preparing: return "电脑正在准备…"
        case .accepted: return "电脑已接收，等待同步…"
        case .unconfirmed: return "未收到确认：连接失败或超时，点击重试"
        case .failed: return "发送失败，内容已恢复到输入框"
        }
    }

    private var retryAccessibilityLabel: String {
        chinese ? label + "（重试同一请求，不会重复执行）"
                : "Unconfirmed: connection failed or timed out. Tap to retry. (retries the same request without duplicate execution)"
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if showBubble {
                Text(value.isEmpty ? "等待输出…" : value)
                    .font(.body)
                    .foregroundColor(Palette.ink)
                    .padding(EdgeInsets(top: 8, leading: 14, bottom: 12, trailing: 14))
                    .background(RoundedRectangle(cornerRadius: Palette.radius, style: .continuous)
                        .fill(Palette.surface))
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.leading, Palette.userInset)
                if !value.isEmpty {
                    RemoteMessageFooter(text: value, at: at, user: true)
                }
            }
            if state.canRetry {
                Button(action: onRetry) {
                    Text(LocalizedStringKey(label))
                        .font(.system(size: Palette.textSmall))
                        .foregroundColor(Palette.muted)
                        .frame(minHeight: 48, alignment: .trailing)
                }
                .buttonStyle(.plain)
                .disabled(!retryEnabled)
                .accessibilityLabel(retryAccessibilityLabel)
            } else {
                HStack(spacing: 6) {
                    if state.isWorking {
                        ProgressView().progressViewStyle(.circular)
                            .frame(width: 18, height: 18)
                    }
                    Text(LocalizedStringKey(label)).font(.system(size: Palette.textSmall))
                }
                .foregroundColor(Palette.muted)
                .frame(minHeight: 20, alignment: .trailing)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

private extension AppModel.OutgoingState {
    var showsBubble: Bool {
        if case .failed = self { return false }
        return true
    }

    var isWorking: Bool {
        switch self {
        case .sending, .preparing: return true
        default: return false
        }
    }

    var canRetry: Bool {
        if case .unconfirmed = self { return true }
        return false
    }
}

#if targetEnvironment(simulator)
/// A UI-only remote list and detail. It uses the production views with a fresh
/// in-memory model; no pairing, tunnel, command or draft is written. The device
/// build excludes the entire fixture, including the launch string.
struct RemoteListFixtureView: View {
    @StateObject private var model: AppModel
    private static let conversationID = "8f14e45f-ceea-467a-9e0f-3d1c8f2b7a44"

    init() {
        let store = ComputerStore(vault: MemoryCredentialVault())
        let model = AppModel(store: store)
        // Activate before selecting a computer: no session or tunnel is opened.
        // Dummy credentials live only in memory; suppress presence probes too.
        model.remoteScreenChanged(active: true)
        model.checkingComputers = true
        let computer = PairedComputer(address: "http://100.127.255.250:43127",
                                      name: "QA phone", computerName: "Research laptop",
                                      token: "ui-only", deviceId: "ui-only", permission: .control)
        try! store.save(computer)
        model.current = computer
        model.computers = [computer, PairedComputer(address: "http://100.127.255.249:43127",
                                                    name: "QA", computerName: "Studio Mac")]
        model.access = RemoteAccess(permission: .control,
                                    capabilities: [.create, .createWorkspace, .move, .archive,
                                                   .conversationActions, .image, .multiImage,
                                                   .expandedAttachments])
        model.workspaces = [RemoteWorkspace(id: "research", name: "Research")]
        model.includeUnassigned = true
        model.listInstanceId = "fixture"
        model.conversations = [
            RemoteConversation(JSONObject(dictionary: [
                "id": Self.conversationID, "title": "Plan the mobile client",
                "workspaceId": "research", "workspaceName": "Research",
                "pinned": true, "activity": "running", "seq": 4,
                "lastReplyAt": 100, "replyReadAt": 0,
            ])),
            RemoteConversation(JSONObject(dictionary: [
                "id": "cc0715e1-20a5-4969-9c91-2f12378941ed",
                "title": "Review release notes", "workspaceId": "research",
                "workspaceName": "Research", "seq": 2,
            ])),
            RemoteConversation(JSONObject(dictionary: [
                "id": "96d5cbaf-33bd-47da-bd74-a6ddde0ba1ea",
                "title": "Quick question", "workspaceId": NSNull(), "seq": 1,
            ])),
        ]
        model.streamState = .connected
        _model = StateObject(wrappedValue: model)
    }

    var body: some View {
        RootView(appModel: model)
            .onChange(of: model.openId) { id in
                if id != nil { showDetail() }
            }
    }

    private func showDetail() {
        guard let conversation = model.conversations.first(where: { $0.id == model.openId }) else { return }
        let snapshot = RemoteSnapshot(JSONObject(dictionary: [
            "instanceId": "fixture", "cursor": 1, "permission": "control",
            "conversation": conversation.json, "nextBefore": NSNull(),
            "messages": [
                ["seq": 1, "role": "user", "text": "Match the Android layout and behavior.", "at": 1_791_109_100_000],
                ["seq": 2, "role": "assistant", "text": "I will compare the screens and interactions one by one.", "at": 1_791_109_200_000],
            ],
            "settings": ["version": "fixture", "editable": true, "model": "gpt-5", "thinking": "medium",
                         "permissionMode": "ask", "models": [["id": "gpt-5", "name": "GPT-5"]]],
            "queue": [], "queueVersion": 1,
        ]))
        model.transcript.apply(snapshot)
        model.streamState = .connected
    }
}

/// A simulator-only rendering fixture for the production remote message views.
/// It makes states that otherwise require a paired desktop inspectable without
/// putting fake pairing or command behavior in the device IPA.
struct RemoteFeedbackFixtureView: View {
    @EnvironmentObject private var model: AppModel
    @State private var editTaps = 0
    @State private var retryTaps = 0
    private let at: Int64 = 1_791_109_200_000

    private var process: [RemoteProcessEntry] {
        [RemoteProcessEntry(type: "thinking", title: "", status: "completed",
                            text: "Checked the available files."),
         RemoteProcessEntry(type: "tool", title: "Shell", status: "completed",
                            input: "echo test", text: "test")]
    }

    private var live: RemoteLive {
        RemoteLive(JSONObject(dictionary: [
            "runId": 1, "text": "Streaming reply with a tool result.",
            "startedAt": at, "userSeq": 1,
            "process": [["type": "tool", "title": "Shell", "status": "completed",
                         "input": "echo test", "text": "test"]],
        ]))
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                Text("Remote message rendering QA")
                    .font(.system(size: Palette.textTitle, weight: .semibold))
                Text("Edit taps: \(editTaps) · Retry taps: \(retryTaps)")
                    .font(.system(size: Palette.textSmall))
                    .foregroundColor(Palette.muted)
                Button("Show rejected-send alert") {
                    model.notice = .init(text: "fixture rejection", serious: true,
                                         kind: .rejectedSend)
                }
                .foregroundColor(Palette.accent)
                Button("Show unconfirmed alert") {
                    model.notice = .init(text: "fixture timeout", serious: true,
                                         kind: .transportUnconfirmed)
                }
                .foregroundColor(Palette.accent)
                Button("Show status details") {
                    model.openId = "fixture"
                    model.streamState = .failed(RemoteApi.Failure(status: 403,
                                                                  detail: "fixture denial"))
                }
                .foregroundColor(Palette.accent)
                Button("Show unavailable status") {
                    model.openId = "fixture"
                    model.streamState = .failed(RemoteApi.Failure(status: 404,
                                                                  detail: "fixture unavailable"))
                }
                .foregroundColor(Palette.accent)
                Button("Show long status details") {
                    model.openId = "fixture"
                    model.streamState = .failed(RemoteApi.Failure(
                        status: 403,
                        detail: String(repeating: "A long desktop error for scrolling QA.\n", count: 24)))
                }
                .foregroundColor(Palette.accent)
                MessageView(row: RenderedMessage(
                    message: RemoteMessage(seq: 1, role: .user,
                                           text: "Repeat prompt", at: at), process: []),
                    editable: true, onEdit: { editTaps += 1 }, onOpenArtifacts: {})
                MessageView(row: RenderedMessage(
                    message: RemoteMessage(seq: 2, role: .assistant,
                                           text: "Final answer after the tool call.", at: at,
                                           process: process, truncated: true), process: process),
                    editable: false, onEdit: {}, onOpenArtifacts: {})
                LiveView(live: live, process: live.process)
                PendingView(state: .sending(""), at: at, legacyImage: true,
                            chinese: false, showBubble: true,
                            retryEnabled: false, onRetry: {})
                PendingView(state: .unconfirmed("Repeat prompt", "not confirmed"), at: at,
                            legacyImage: false, chinese: false, showBubble: false,
                            retryEnabled: true, onRetry: { retryTaps += 1 })
                PendingView(state: .failed("Rejected draft"),
                            at: at, legacyImage: false, chinese: false, showBubble: true,
                            retryEnabled: false, onRetry: {})
                StreamBar().environmentObject(model)
            }
            .padding(.horizontal, PageGutter.horizontal)
            .padding(.vertical, 12)
        }
        .background(Palette.background)
    }
}
#endif

/// The same collapsed execution-process block Android places above a reply.
/// Its tool rows expand separately, preserving their input and full output.
struct ProcessView: View {
    let entries: [RemoteProcessEntry]
    let live: Bool
    @State private var expanded = false

    init(entries: [RemoteProcessEntry], live: Bool = false) {
        self.entries = entries
        self.live = live
    }

    private var onlyThinking: Bool {
        !entries.isEmpty && entries.allSatisfy { $0.type == "thinking" }
    }

    private var caption: String {
        if onlyThinking { return live ? "正在思考" : "思考已完成" }
        return live ? "执行过程 · 进行中" : "执行过程"
    }

    private var toolCount: Int { entries.filter { $0.type == "tool" }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 10) {
                    Text("◇")
                        .font(.system(size: 19))
                    HStack(spacing: 0) {
                        Text(LocalizedStringKey(caption))
                        if toolCount > 0 {
                            Text(verbatim: " · \(toolCount)")
                            Text(LocalizedStringKey(" 次工具调用"))
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 14))
                        .frame(width: 18, height: 18)
                }
                .font(.system(size: Palette.textBody))
                .foregroundColor(Palette.muted)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(minHeight: 48)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(entries.enumerated()), id: \.offset) { pair in
                        ProcessEntryView(entry: pair.element)
                    }
                }
                .padding(.leading, 14)
                .padding(.trailing, 14)
                .padding(.bottom, 12)
            }
        }
        .background(RoundedRectangle(cornerRadius: Palette.smallRadius, style: .continuous)
            .fill(Palette.background))
        .overlay(RoundedRectangle(cornerRadius: Palette.smallRadius, style: .continuous)
            .stroke(Palette.separator, lineWidth: 1))
    }
}

private struct ProcessEntryView: View {
    let entry: RemoteProcessEntry
    @State private var toolOpen = false

    private var fallbackTitle: String {
        switch entry.type {
        case "thinking": return "思考"
        case "plan": return "计划"
        default: return "过程信息"
        }
    }

    private var statusTitle: String {
        switch entry.status {
        case "completed": return "已完成"
        case "failed": return "失败"
        case "cancelled": return "已停止"
        default: return "进行中"
        }
    }

    private var detail: String {
        (entry.input.isEmpty ? "" : entry.input + "\n") + entry.text
    }

    private var heading: some View {
        HStack(spacing: 8) {
            if entry.type == "tool" {
                Image(systemName: toolOpen ? "chevron.down" : "chevron.right")
                    .frame(width: 18, height: 18)
            }
            if entry.title.isEmpty {
                Text(LocalizedStringKey(fallbackTitle))
            } else {
                Text(verbatim: entry.title)
            }
            if !entry.status.isEmpty {
                Text("·")
                Text(LocalizedStringKey(statusTitle))
            }
        }
        .font(.system(size: Palette.textSmall))
        .foregroundColor(Palette.muted)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if entry.type == "tool" {
                Button { toolOpen.toggle() } label: {
                    heading.frame(minHeight: 48, alignment: .leading)
                }
                .buttonStyle(.plain)
            } else {
                heading.padding(.top, 10)
            }
            if entry.type != "tool" || toolOpen {
                Text(detail)
                    .font(.system(size: Palette.textBody,
                                  design: entry.type == "tool" ? .monospaced : .default))
                    .foregroundColor(Palette.ink)
                    .textSelection(.enabled)
            }
            if entry.truncated {
                Text("内容过长，仅显示部分。")
                    .font(.system(size: Palette.textTiny))
                    .foregroundColor(Palette.muted)
            }
        }
    }
}

/// A request the desktop is waiting on.
///
/// Android shows every request when control is allowed. A question or an
/// oversized prompt keeps its details but offers no answer buttons.
private struct ApprovalCard: View {
    let approval: RemoteApproval
    @EnvironmentObject private var model: AppModel
    /// Which answer is being confirmed, so the dialog can tell the person which
    /// of the two they are about to give.
    @State private var confirming: Bool?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(approval.toolName.isEmpty ? "需要确认" : approval.toolName,
                  systemImage: "hand.raised.fill")
                .font(.subheadline.weight(.medium))
            if !approval.details.isEmpty {
                Text(approval.details)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundColor(Palette.muted)
                    .textSelection(.enabled)
            }
            if approval.actionable {
                // Both answers, as Android offers them: a phone that can only
                // allow cannot refuse a tool it should not run.
                HStack(spacing: 8) {
                    CapsuleButton(title: "允许一次", systemImage: "checkmark") { confirming = true }
                    CapsuleButton(title: "拒绝", systemImage: "xmark", prominent: false) { confirming = false }
                }
                .disabled(!model.canDrive || model.commandBusy || model.hasPendingDetailOperation)
            } else {
                Text("此请求需要电脑处理（问答或内容过长）。")
                    .font(.system(size: Palette.textNote))
                    .foregroundColor(Palette.muted)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: Palette.radius, style: .continuous)
            .fill(Palette.surface))
        .overlay(RoundedRectangle(cornerRadius: Palette.radius, style: .continuous)
            .stroke(Color.orange.opacity(0.5), lineWidth: 1))
        .confirmationDialog(confirming == true ? "确认允许此操作？" : "拒绝此操作？",
                            isPresented: Binding(get: { confirming != nil },
                                                 set: { if !$0 { confirming = nil } }),
                            titleVisibility: .visible) {
            if let allow = confirming {
                Button(allow ? "允许一次" : "拒绝") {
                    model.approve(approval, allow: allow)
                    confirming = nil
                }
            }
            Button("取消", role: .cancel) { confirming = nil }
        } message: {
            Text([approval.toolName, approval.details]
                .filter { !$0.isEmpty }.joined(separator: "\n"))
        }
    }
}

// MARK: - Composer

private struct RemoteModelAnchorKey: PreferenceKey {
    static var defaultValue: CGRect? = nil
    static func reduce(value: inout CGRect?, nextValue: () -> CGRect?) { value = nextValue() }
}

private struct RemotePermissionAnchorKey: PreferenceKey {
    static var defaultValue: CGRect? = nil
    static func reduce(value: inout CGRect?, nextValue: () -> CGRect?) { value = nextValue() }
}

private struct RemoteAttachHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 460
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct Composer: View {
    @EnvironmentObject private var model: AppModel
    let onAttach: () -> Void
    let onModelPicker: () -> Void
    let onPermission: () -> Void
    @State private var writing = false
    /// How tall the draft comes out, as the ruler measured it.
    @State private var draftHeight: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            if model.outgoing == nil, model.hasPendingDetailOperation {
                Button { model.retryPendingDetailOperation() } label: {
                    StatusLine(text: model.commandBusy
                               ? "正在查询未确认操作…"
                               : "有一项未确认操作 · 点击重试同一请求",
                               tone: .bad)
                }
                .buttonStyle(.plain)
                .disabled(!model.canDrive || model.commandBusy)
                .padding(.horizontal, 12)
                .padding(.bottom, 6)
            }
            // One floating bar holding the tray, the input and the tool row,
            // which is what Android's `ChatComposer` is: the three things that
            // steer a run live with the message being written instead of up in
            // the navigation bar, where a hand on the keyboard cannot reach
            // them.
            //
            // Full-bleed rather than inset. Android adds this bar to its dock
            // with `LayoutParams(-1, -2)` and an 8dp bottom margin and nothing
            // at all on the sides, so the only things separating it from the
            // page are the 28dp corners, the hairline and the shadow — and an
            // inset bar reads as a card floating in a well instead.
            VStack(spacing: 0) {
                if !model.attachments.isEmpty { AttachmentTray().environmentObject(model) }
                if model.editingSeq != nil { editingBanner }
                // The field is inset 12/12/8/12 and stands 48 points tall until
                // it has more than one line to show, which is the `minHeight
                // dp(48)` and the four `maxLines` of Android's `ComposerInput`.
                //
                // The bar's height is the field's own report of how many lines
                // it has: see `ComposerField` for why the field is not simply
                // offered the height and left to fill it.
                ZStack(alignment: .topLeading) {
                    ComposerField(text: draftBinding, height: $draftHeight, focus: $writing,
                                  sendOnReturn: model.preferences.enterMode == .send,
                                  maxUTF16Length: Self.draftLimit,
                                  onSubmit: { if canSend { model.send() } })
                        .disabled(model.hasPendingDetailOperation || model.commandBusy)
                    // Android sets a hint on the same field rather than drawing
                    // one beside it, so the invitation sits on the first line,
                    // in the muted tone, and goes when there is a draft.
                    if model.draft.isEmpty {
                        Text("发消息，继续任务…")
                            .font(.system(size: Palette.textRow))
                            .foregroundColor(Palette.muted)
                            .allowsHitTesting(false)
                    }
                }
                .frame(height: fieldHeight, alignment: .topLeading)
                .padding(EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 8))
                toolRow
            }
            .padding(EdgeInsets(top: 6, leading: 8, bottom: 6, trailing: 8))
            .background(RoundedRectangle(cornerRadius: Palette.capsuleRadius, style: .continuous)
                .fill(Palette.background))
            .overlay(RoundedRectangle(cornerRadius: Palette.capsuleRadius, style: .continuous)
                .stroke(writing ? Palette.accent : Palette.separator, lineWidth: 1))
            // Full-bleed *within the page*: Android adds this bar to its dock
            // with `LayoutParams(-1, -2)` and an 8dp bottom margin, so the only
            // things separating it from the page are the 28dp corners, the
            // hairline and the shadow — no second inset of its own. The 18dp
            // gutter is the page's, from `shell()`, and applies to the dock and
            // the transcript alike.
            .padding(.horizontal, PageGutter.horizontal)
            .padding(.bottom, PageGutter.dockBottom)
        }
        .background(Palette.background)
        .onChange(of: model.composerFocusTick) { _ in writing = true }
    }

    // MARK: - Tool row

    /// The field's height: one line on an empty draft, four at the most.
    ///
    /// The field reports a line at a little under 20 points, so the floor lifts
    /// an empty draft to 24 and the 12-point insets above and below take it to
    /// Android's 48. `draftHeight` is zero until the first report arrives, and
    /// the floor is the right answer for that frame.
    private var fieldHeight: CGFloat {
        min(ComposerField.fourLines, max(ComposerField.floorHeight, draftHeight))
    }

    /// Attach, safety level, the model, then send *or* stop — the order Android
    /// builds by inserting each tool ahead of the model button.
    ///
    /// Send and stop are mutually exclusive, which is not obvious and is what
    /// `updateControls` settles: `send` shows while nothing is running, and
    /// while something *is* running only if there is a message to queue;
    /// `stop` shows the rest of the time. Drawing both at once offers a button
    /// that stops the run beside one that adds to it, and the one the person
    /// meant is as likely to be the wrong one.
    private var toolRow: some View {
        HStack(spacing: 0) {
            toolButton("plus", label: "添加附件", enabled: attachEnabled, action: onAttach)
            toolButton("shield", label: model.usesChinese
                       ? "安全级别：\(permissionTitle)" : "Safety level: \(permissionTitle)",
                       enabled: configurable,
                       tint: permissionLevel == "full" ? .orange : Palette.ink,
                       action: onPermission)
                .background(GeometryReader { geometry in
                    Color.clear.preference(key: RemotePermissionAnchorKey.self,
                                           value: geometry.frame(in: .named("remote-chat-detail")))
                })
            modelButton
            if showsSend { sendButton(queued: model.queuesInsteadOfSending) }
            if showsStop { stopButton }
        }
        .frame(height: 48)
    }

    /// Whether the run is holding a message slot open, which is what decides
    /// which of send and stop is on screen.
    private var showsSend: Bool {
        model.transcript.live == nil || (model.queuesInsteadOfSending && canSend)
    }

    private var showsStop: Bool {
        model.transcript.live != nil && !showsSend
    }

    private func toolButton(_ symbol: String, label: String, enabled: Bool = true,
                            tint: Color = Palette.ink,
                            action: @escaping () -> Void) -> some View {
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

    /// "K2.5 · 标准" — which model will answer and how hard it will think, both
    /// changeable in place. It takes the space that is left, as Android's
    /// weighted `model` view does, and dims rather than disappears when the
    /// desktop will not take a change: a missing control reads as a missing
    /// feature, a dimmed one reads as a reason.
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
            // Android fills this capsule with `background`, the same colour as
            // the bar it sits in: the button is legible by position, not by a
            // second surface tone.
            .background(Capsule(style: .continuous).fill(Palette.background))
        }
        .buttonStyle(.plain)
        .disabled(!configurable)
        .opacity(configurable ? 1 : 0.45)
        .accessibilityLabel(model.usesChinese
            ? "切换模型和思考等级：\(modelLabel)"
            : "Change model and thinking level: \(modelLabel)")
        .background(GeometryReader { geometry in
            Color.clear.preference(key: RemoteModelAnchorKey.self,
                                   value: geometry.frame(in: .named("remote-chat-detail")))
        })
    }

    // MARK: - What the tool row shows

    private var settings: RemoteSettings? { model.transcript.settings }

    /// Whether the desktop will take a settings change at all.
    ///
    /// `editable` is the desktop's own answer and the one that matters: an older
    /// desktop advertises no models and takes no change, and a control that
    /// looks live and then does nothing is worse than a dimmed one.
    private var configurable: Bool {
        guard model.canDrive, let settings, settings.editable else { return false }
        guard !model.hasPendingDetailOperation, !model.commandBusy else { return false }
        if model.outgoing?.showsBubble == true { return false }
        return true
    }

    private var modelLabel: String {
        let id = settings?.model ?? ""
        let name = ModelLabel.compact(id.isEmpty ? (model.usesChinese ? "模型" : "Model") : id)
        let thinking = LocalChatThinking.display(settings?.thinking ?? "", chinese: model.usesChinese)
        return thinking.isEmpty ? name : name + " · " + thinking
    }

    private var permissionLevel: String { settings?.permissionMode ?? "ask" }

    private var permissionTitle: String {
        PermissionMode.label(permissionLevel, chinese: model.usesChinese)
    }

    /// The draft lives in the model, not in this view: leaving the conversation
    /// must not lose a half-written message, and entering edit mode has to be
    /// able to put an already-sent message back into the box.
    private var draftBinding: Binding<String> {
        Binding(get: { model.draft }, set: { value in
            // Android caps the draft with an `InputFilter.LengthFilter(16000)`
            // on this composer. Without the same cut the field would keep
            // accepting text and the desktop would refuse the send.
            model.draft = ComposerField.limited(value, to: Self.draftLimit)
        })
    }

    /// `ChatComposer`'s length filter on the remote composer.
    private static let draftLimit = 16000

    /// The banner Android puts above the input while a sent message is being
    /// rewritten. Its wording is the short one: the longer "· 发送后将重新生成
    /// 回复" belongs to the status line under the bar, not to the row that only
    /// has to say which turn the input is holding.
    private var editingBanner: some View {
        HStack(spacing: 0) {
            Text("正在编辑上一条消息")
                .font(.system(size: Palette.textSmall))
                .foregroundColor(Palette.muted)
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(.leading, 12)
            Spacer(minLength: 0)
            Button { model.cancelEdit() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: Palette.textDisplay))
                    .foregroundColor(Palette.muted)
                    .frame(width: 48, height: 48)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("取消编辑")
        }
    }

    /// The send button, which says "加入队列" rather than "发送" on a desktop
    /// that takes messages while it is still working — or while earlier ones are
    /// already waiting, since the reply order is then not this message's to
    /// choose either way.
    private func sendButton(queued: Bool) -> some View {
        actionButton(symbol: queued ? "tray.and.arrow.up" : "arrow.up",
                     label: queued ? "加入队列" : "发送",
                     enabled: canSend) { model.send() }
    }

    /// Stop, drawn the way Android draws it: the accent capsule with a white
    /// glyph, the same button as send rather than a red one. What separates the
    /// pair is what they do, and Android lets the row's colour say only "this is
    /// the control at the end" instead of inventing a second meaning for it.
    private var stopButton: some View {
        actionButton(symbol: "stop.fill", label: "停止",
                     enabled: model.canDrive && !model.hasPendingDetailOperation && !model.commandBusy) {
            model.stop()
        }
    }

    /// One 48dp accent capsule with a white glyph, as `ChatStyle.composerAction`
    /// builds it: a 48dp button carrying 13dp of padding, which puts the glyph
    /// at 22dp.
    private func actionButton(symbol: String, label: String, enabled: Bool,
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

    /// Whether the attach button is usable. Android gates it on the device being
    /// allowed to command the desktop at all and on no upload already being in
    /// flight, and dims it rather than hiding it, so the row does not reflow.
    private var attachEnabled: Bool {
        model.canDrive && !model.attaching
            && !model.hasPendingDetailOperation && !model.commandBusy
    }

    private var canSend: Bool { model.canSubmitDraft }
}

/// The panel the composer's "+" opens.
///
/// Android's `AttachSheet` draws square source tiles and capability rows in a
/// bottom dialog, not in a new navigation page.
struct AttachSheetView: View {
    enum Action { case camera, photos, files, artifacts, permission }

    let onClose: () -> Void
    let onPick: (Action) -> Void
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 13) {
                Image(systemName: "plus")
                    .foregroundColor(Palette.accent)
                    .frame(width: 40, height: 40)
                    .background(RoundedRectangle(cornerRadius: Palette.fieldRadius).fill(Palette.card))
                    .accessibilityHidden(true)
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
            limitNote
            tiles
                .padding(.bottom, 16)
            Text("文件支持 PDF、Word、Excel、PPT、文本等常见格式。")
                .font(.system(size: Palette.textNote))
                .foregroundColor(Palette.secondary)
                .padding(.horizontal, 4)
                .padding(.bottom, 14)
            capabilities
            if !imagesEnabled {
                imageReason
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
        .padding(.bottom, 18)
        .background(RoundedRectangle(cornerRadius: Palette.sheetRadius, style: .continuous)
            .fill(Palette.grouped))
    }

    // MARK: - What is on offer

    /// What this desktop will actually take, stated before the picker opens
    /// rather than after a send is refused.
    private var limitNote: some View {
        Text(verbatim: limitText)
            .font(.system(size: Palette.textNote))
            .foregroundColor(Palette.secondary)
            .padding(.horizontal, 4)
            .padding(.bottom, 14)
    }

    private var limitText: String {
        if model.access.usesExpandedAttachments {
            return model.usesChinese
                ? AttachmentRules.limits(remote: true)
                : "Up to 20 attachments · 4 MiB/image · 10 MiB/document · 32 MiB total"
        }
        if model.access.canAttachFiles {
            return model.usesChinese
                ? AttachmentRules.legacyLimits(files: true)
                : "This desktop supports 9 attachments · 8 MiB total; update it for higher limits."
        }
        return model.usesChinese
            ? AttachmentRules.legacyLimits(files: false)
            : "Update and restart the desktop for documents and up to 20 attachments."
    }

    private var tiles: some View {
        HStack(spacing: 12) {
            tile("camera", "拍照", enabled: imagesEnabled && CameraPicker.isAvailable, action: .camera)
            tile("photo", "照片", enabled: imagesEnabled, action: .photos)
            tile("doc", "文件", enabled: filesEnabled, action: .files)
        }
    }

    private func tile(_ symbol: String, _ label: String, enabled: Bool, action: Action) -> some View {
        Button { onPick(action) } label: {
            VStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.system(size: Palette.textTitle))
                    .foregroundColor(Palette.ink)
                Text(LocalizedStringKey(label))
                    .font(.system(size: Palette.textBody))
                    .foregroundColor(Palette.ink)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 96)
            .background(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                .fill(Palette.card))
            .opacity(enabled ? 1 : 0.45)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(Text(LocalizedStringKey(label)))
    }

    /// The two rows Android puts under the tiles: the safety level in force, and
    /// the way to the conversation's files.
    private var capabilities: some View {
        VStack(spacing: 0) {
            capability("shield", title: "安全级别",
                       subtitle: "控制电脑执行工具操作前的确认方式",
                       value: PermissionMode.label(model.transcript.settings?.permissionMode ?? "ask",
                                                   chinese: model.usesChinese),
                       enabled: configurable, action: .permission)
            Palette.divider.frame(height: 1).padding(.leading, 52).padding(.trailing, 16)
            capability("folder", title: "查看产物",
                       subtitle: UIDevice.current.userInterfaceIdiom == .pad
                           ? "列出会话中的文件并下载到平板"
                           : "列出会话中的文件并下载到手机",
                       value: "", enabled: sendable, action: .artifacts)
        }
        .background(RoundedRectangle(cornerRadius: Palette.groupRadius, style: .continuous)
            .fill(Palette.card))
    }

    private func capability(_ symbol: String, title: String, subtitle: String,
                            value: String, enabled: Bool, action: Action) -> some View {
        Button { onPick(action) } label: {
            HStack(spacing: 12) {
                Image(systemName: symbol)
                    .font(.system(size: Palette.textRowStrong))
                    .foregroundColor(Palette.ink)
                    .frame(width: 23)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 10) {
                        Text(LocalizedStringKey(title))
                            .font(.system(size: Palette.textRow))
                            .foregroundColor(Palette.ink)
                        Spacer(minLength: 0)
                        if !value.isEmpty {
                            Text(LocalizedStringKey(value))
                                .font(.system(size: Palette.textBody))
                                .foregroundColor(Palette.secondary)
                                .lineLimit(1)
                                .frame(maxWidth: 96, alignment: .trailing)
                        }
                    }
                    // The subtitle gets its own line, which is what stops a long
                    // value and a long description from squeezing each other on
                    // a narrow phone — the same split Android makes.
                    Text(LocalizedStringKey(subtitle))
                        .font(.system(size: Palette.textNote))
                        .foregroundColor(Palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: Palette.textSmall, weight: .semibold))
                    .foregroundColor(Palette.faint)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(minHeight: 68)
            .contentShape(Rectangle())
            .opacity(enabled ? 1 : 0.45)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    /// Why the picture tiles are dim, in the same three cases Android
    /// distinguishes: no capability, no room left, or not connected yet.
    private var imageReason: some View {
        Text(verbatim: model.usesChinese ? imageReasonText.zh : imageReasonText.en)
            .font(.system(size: Palette.textNote))
            .foregroundColor(Palette.secondary)
            .padding(.horizontal, 4)
            .padding(.top, 14)
    }

    private var imageReasonText: (zh: String, en: String) {
        if !model.access.canAttachImages && !model.access.canAttachFiles {
            return ("添加图片需要更新并重启电脑端。",
                    "Images require an updated and restarted desktop.")
        }
        if room <= 0 {
            if model.access.usesExpandedAttachments {
                return ("最多添加 20 个附件。", "Add up to 20 attachments.")
            }
            if model.access.canAttachFiles {
                return ("当前电脑最多 9 个附件，请更新电脑端提高限额。",
                        "This desktop supports up to 9 attachments; update it for higher limits.")
            }
            if model.access.allowsMultipleImages {
                return ("旧版电脑端最多 9 张图片，请更新电脑端。",
                        "This desktop supports up to 9 images; update it.")
            }
            return ("多图发送需要更新并重启电脑端。",
                    "Multiple images require an updated and restarted desktop.")
        }
        return ("连接电脑后可添加图片。", "Connect to your computer to add images.")
    }

    // MARK: - State

    /// Whether this desktop will take a settings change at all.
    private var configurable: Bool {
        sendable && (model.transcript.settings?.editable ?? false)
    }

    /// How many more attachments this chat has room for.
    private var room: Int { max(0, model.access.attachmentCount - model.attachments.count) }

    /// Whether anything can be attached right now.
    private var sendable: Bool {
        guard model.canDrive, !model.attaching,
              !model.hasPendingDetailOperation, !model.commandBusy else { return false }
        if model.outgoing?.showsBubble == true { return false }
        return true
    }

    private var imagesEnabled: Bool {
        sendable && (model.access.canAttachImages || model.access.canAttachFiles) && room > 0
    }

    private var filesEnabled: Bool {
        sendable && model.access.canAttachFiles && room > 0
    }
}

/// The row of picked files above the input.
struct AttachmentTray: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(model.attachments, id: \.data) { attachment in
                    chip(attachment)
                }
            }
            .padding(.horizontal, 12)
        }
        .frame(height: 72)
    }

    private func chip(_ attachment: RemoteAttachment) -> some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if attachment.isImage, let image = model.attachmentPreviews[attachment.data] {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 60, height: 60)
                        .clipShape(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous))
                } else {
                    VStack(spacing: 3) {
                        Image(systemName: "doc.fill").foregroundColor(Palette.muted)
                        Text(ArtifactReferences.fileExtension(of: attachment.name))
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(Palette.muted)
                    }
                    .frame(width: 60, height: 60)
                    .background(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous).fill(Palette.surface))
                }
            }
            Button { model.removeAttachment(attachment) } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: Palette.textRow))
                    .foregroundColor(.white)
                    .background(Circle().fill(Color.black.opacity(0.55)))
            }
            .buttonStyle(.plain)
            .offset(x: 5, y: -5)
            .accessibilityLabel(model.usesChinese
                ? "移除 \(attachment.name)" : "Remove \(attachment.name)")
        }
    }
}

/// The bottom-dialog chrome used for both remote creation flows.
private struct RemoteCreatePanel<Content: View>: View {
    let title: String
    let subtitle: String
    let onClose: () -> Void
    let content: Content

    init(title: String, subtitle: String, onClose: @escaping () -> Void,
         @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.onClose = onClose
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RoundedRectangle(cornerRadius: Palette.gripRadius)
                .fill(Palette.divider)
                .frame(width: 36, height: 4)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 16)
            HStack(spacing: 13) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: Palette.textDialog))
                    .foregroundColor(Palette.accent)
                    .frame(width: 40, height: 40)
                    .background(RoundedRectangle(cornerRadius: Palette.fieldRadius).fill(Palette.card))
                    .accessibilityHidden(true)
                Text(LocalizedStringKey(title))
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
            Text(LocalizedStringKey(subtitle))
                .font(.system(size: Palette.textNote))
                .foregroundColor(Palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10)
                .padding(.bottom, 16)
            content
        }
        .padding(.horizontal, 18)
        .padding(.top, 14)
        .padding(.bottom, 18)
        .background(RoundedRectangle(cornerRadius: Palette.sheetRadius, style: .continuous)
            .fill(Palette.grouped))
    }
}

/// Android lists the advertised engines in a bottom dialog, even if there is
/// only one choice. Selection is the moment the create command is sent.
struct EnginePickerSheet: View {
    let engines: [RemoteEngine]
    let onClose: () -> Void
    let onPick: (RemoteEngine) -> Void

    var body: some View {
        RemoteCreatePanel(title: "新建会话",
                          subtitle: "选择执行引擎，沿用电脑端的连接设置。",
                          onClose: onClose) {
            SettingsGroupLabel(title: "执行引擎")
            SettingsCard {
                ForEach(Array(engines.enumerated()), id: \.offset) { index, engine in
                    if index > 0 { SettingsDivider(leading: 16) }
                    Button { onPick(engine) } label: {
                        SettingsRowLabel(icon: "", title: engine.label)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

/// Creates a workspace on the desktop.
///
/// The two fields Android's panel asks for. The path is the one worth stating
/// twice, because it is the one that is easy to get wrong: the desktop makes a
/// real folder there, so it is an absolute path on the *computer*, and a path
/// on this phone could not name anything on the other side of the tunnel.
struct NewWorkspaceSheet: View {
    let onClose: () -> Void
    let onCreate: (String, String) -> Void
    @State private var name = ""
    @State private var path = ""
    @State private var nameError: String?
    @State private var pathError: String?

    var body: some View {
        RemoteCreatePanel(title: "新建工作区",
                          subtitle: UIDevice.current.userInterfaceIdiom == .pad
                              ? "填写电脑上已存在文件夹的完整路径，不是平板路径。"
                              : "填写电脑上已存在文件夹的完整路径，不是手机路径。",
                          onClose: onClose) {
            VStack(alignment: .leading, spacing: 4) {
                Text("工作区名称")
                    .font(.system(size: Palette.textSmall))
                    .foregroundColor(nameError == nil ? Palette.secondary : Palette.error)
                TextField("工作区名称", text: $name)
                    .font(.system(size: Palette.textRow))
                    .foregroundColor(Palette.ink)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 49)
                    .background(RoundedRectangle(cornerRadius: Palette.fieldRadius).fill(Palette.field))
                    .overlay(RoundedRectangle(cornerRadius: Palette.fieldRadius)
                        .stroke(nameError == nil ? Palette.fieldBorder : Palette.error, lineWidth: 1))
                    .onChange(of: name) { value in
                        if ComposerText.utf16Length(value) > 200 {
                            name = ComposerText.limited(value, to: 200)
                        }
                        nameError = nil
                    }
                if let nameError { errorText(nameError) }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("电脑文件夹绝对路径")
                    .font(.system(size: Palette.textSmall))
                    .foregroundColor(pathError == nil ? Palette.secondary : Palette.error)
                TextField("电脑文件夹绝对路径", text: $path)
                    .font(.system(size: Palette.textRow))
                    .foregroundColor(Palette.ink)
                    .textInputAutocapitalization(.never)
                    .disableAutocorrection(true)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 49)
                    .background(RoundedRectangle(cornerRadius: Palette.fieldRadius).fill(Palette.field))
                    .overlay(RoundedRectangle(cornerRadius: Palette.fieldRadius)
                        .stroke(pathError == nil ? Palette.fieldBorder : Palette.error, lineWidth: 1))
                    .onChange(of: path) { value in
                        if ComposerText.utf16Length(value) > 1024 {
                            path = ComposerText.limited(value, to: 1024)
                        }
                        pathError = nil
                    }
                if let pathError { errorText(pathError) }
            }
            .padding(.top, 14)
            Button(action: submit) {
                Text("创建")
                    .font(.system(size: Palette.textRow, weight: .medium))
                    .foregroundColor(Palette.card)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(RoundedRectangle(cornerRadius: Palette.dialogActionRadius)
                        .fill(Palette.ink))
            }
            .buttonStyle(.plain)
            .padding(.top, 20)
            Button(action: onClose) {
                Text("取消")
                    .font(.system(size: Palette.textRow, weight: .medium))
                    .foregroundColor(Palette.ink)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(RoundedRectangle(cornerRadius: Palette.dialogActionRadius)
                        .fill(Palette.card))
            }
            .buttonStyle(.plain)
            .padding(.top, 8)
        }
    }

    private func errorText(_ value: String) -> some View {
        Text(LocalizedStringKey(value))
            .font(.system(size: Palette.textSmall))
            .foregroundColor(Palette.error)
            .padding(.leading, 4)
    }

    /// Android keeps a blank field open and marks that field rather than
    /// closing the dialog to show a global alert.
    private func submit() {
        let trimmedName = ComposerText.androidTrim(name)
        let trimmedPath = ComposerText.androidTrim(path)
        guard !trimmedName.isEmpty else {
            nameError = "请输入名称"
            return
        }
        guard !trimmedPath.isEmpty else {
            pathError = "请输入电脑文件夹路径"
            return
        }
        onCreate(trimmedName, trimmedPath)
    }
}
