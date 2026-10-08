import SwiftUI

// MARK: - Computers

struct ComputersView: View {
    var onOpenComputer: () -> Void = {}
    @EnvironmentObject private var model: AppModel
    @Environment(\.presentationMode) private var presentation
    @State private var showPairing = false
    @State private var resumePendingPairing = false
    @State private var pairingComputer: PairedComputer?
    @State private var managingComputer: PairedComputer?
    @State private var managePanelHeight: CGFloat = 360

    var body: some View {
        NavigationView {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 0) {
                    Text("选择一台电脑，继续工作。")
                        .font(.system(size: Palette.textInput))
                        .foregroundColor(Palette.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 2)
                        .padding(.top, 22)
                        .padding(.bottom, 14)

                    SettingsGroupLabel(title: "我的电脑")
                    SettingsCard {
                        ForEach(Array(model.computers.enumerated()), id: \.element.address) { index, computer in
                            if index > 0 { computerDivider }
                            ComputerRow(computer: computer, onSelect: {
                                guard model.select(computer.address) else { return }
                                if computer.isPaired {
                                    presentation.wrappedValue.dismiss()
                                    onOpenComputer()
                                } else {
                                    resumePendingPairing = computer.isAwaitingApproval
                                    pairingComputer = computer
                                    showPairing = true
                                }
                            }, onManage: { managingComputer = computer })
                        }
                        if !model.computers.isEmpty { computerDivider }
                        addComputerRow
                    }

                    if model.computers.isEmpty {
                        VStack(spacing: 0) {
                            Text("连接你的第一台电脑")
                                .font(.system(size: Palette.textDisplay, weight: .medium))
                                .foregroundColor(Palette.ink)
                            Text(LocalizedStringKey(UIDevice.current.userInterfaceIdiom == .pad
                                ? "扫描电脑上的配对二维码，即可在平板继续工作。"
                                : "扫描电脑上的配对二维码，即可在手机继续工作。"))
                                .font(.system(size: Palette.textBody))
                                .foregroundColor(Palette.secondary)
                                .multilineTextAlignment(.center)
                                .padding(.top, 8)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 16)
                        .padding(.top, 42)
                        .accessibilityElement(children: .combine)
                    }

                    if model.current?.isAwaitingApproval == true {
                        Button {
                            resumePendingPairing = true
                            pairingComputer = model.current
                            showPairing = true
                        } label: {
                            Text("继续配对")
                                .font(.system(size: Palette.textBody, weight: .medium))
                                .foregroundColor(Palette.ink)
                                .frame(maxWidth: .infinity, minHeight: 48)
                                .background(RoundedRectangle(cornerRadius: Palette.capsuleRadius, style: .continuous)
                                    .fill(Palette.surface))
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 14)
                    }

                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .background(Palette.grouped.ignoresSafeArea())
            .simultaneousGesture(TapGesture().onEnded { model.userInteracted() })
            .simultaneousGesture(DragGesture(minimumDistance: 8)
                .onChanged { _ in model.userInteracted() })
            .navigationTitle("远程控制")
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            // Checking on entry is what Android's `computersScreen` does with its
            // own `refreshComputers`, and pulling re-runs it — the one thing that
            // makes a list of pairings worth showing on a single screen.
            .task { await model.refreshComputers() }
            .refreshable { await model.refreshComputers() }
            // Returning to the front is when the last answer went stale; Android
            // re-runs the check from `onStart` and the network listener.
            .onChange(of: model.resumeTick) { _ in Task { await model.refreshComputers() } }
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    RoundBackButton { presentation.wrappedValue.dismiss() }
                }
            }
            .fullScreenCover(isPresented: $showPairing) {
                PairingView(initialComputer: pairingComputer, resumePending: resumePendingPairing) {
                    showPairing = false
                    presentation.wrappedValue.dismiss()
                    onOpenComputer()
                }
                .environmentObject(model)
            }
        }
        .overlay {
            GeometryReader { geometry in
                if let computer = managingComputer {
                    ZStack(alignment: .bottom) {
                        Color.black.opacity(0.28).ignoresSafeArea().contentShape(Rectangle())
                            .onTapGesture { managingComputer = nil }
                        ScrollView(.vertical, showsIndicators: false) {
                            ComputerManagePanel(computer: computer,
                                                availableHeight: max(160, geometry.size.height - 32),
                                                onClose: { managingComputer = nil })
                                .environmentObject(model)
                                .background(GeometryReader { panel in
                                    Color.clear
                                        .onAppear { managePanelHeight = panel.size.height }
                                        .onChange(of: panel.size.height) { managePanelHeight = $0 }
                                })
                        }
                        .frame(width: min(560, geometry.size.width - 24),
                               height: min(max(160, geometry.size.height - 32), managePanelHeight))
                        .clipShape(RoundedRectangle(cornerRadius: Palette.sheetRadius, style: .continuous))
                        .padding(.bottom, 12)
                    }
                    .frame(width: geometry.size.width, height: geometry.size.height)
                }
            }
        }
    }

    private var computerDivider: some View {
        Rectangle()
            .fill(Palette.divider)
            .frame(height: 1)
            .padding(.horizontal, 16)
    }

    private var addComputerRow: some View {
        Button {
            resumePendingPairing = false
            pairingComputer = nil
            showPairing = true
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "plus")
                    .font(.system(size: Palette.textTitle))
                    .foregroundColor(Palette.ink)
                    .frame(width: 32, height: 32)
                Text("添加电脑")
                    .font(.system(size: Palette.textRowStrong))
                    .foregroundColor(Palette.ink)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct ComputerRow: View {
    let computer: PairedComputer
    let onSelect: () -> Void
    let onManage: () -> Void
    @EnvironmentObject private var model: AppModel

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onSelect) {
                HStack(spacing: 12) {
                    // Android's row is the computer symbol with a presence dot
                    // on its corner, and no separate selected tick.
                    ZStack(alignment: .topTrailing) {
                        Image(systemName: "desktopcomputer")
                            .font(.system(size: Palette.textCard))
                            .foregroundColor(Palette.ink)
                            .frame(width: 32, height: 32)
                        Circle()
                            .fill(dot)
                            .frame(width: 12, height: 12)
                            .overlay(Circle().stroke(Palette.card, lineWidth: 2))
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(verbatim: computer.displayName)
                            .font(.system(size: Palette.textRowStrong))
                            .foregroundColor(Palette.ink)
                            .lineLimit(2)
                        statusLine
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(computer.displayName), \(spokenState), \(computer.address)")

            // Where Android puts its "管理" capsule. Tapping the row selects the
            // computer; managing it is the other thing this list is for, and
            // burying it in a swipe is how it stops being found.
            Button(action: onManage) {
                Text("管理")
                    .font(.footnote.weight(.medium))
                    .foregroundColor(Palette.ink)
                    .padding(.horizontal, 14)
                    .frame(minWidth: 60, minHeight: 48)
                    .background(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                        .fill(Palette.grouped))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(model.usesChinese ? "管理电脑" : "Manage computer") · \(computer.displayName)")
        }
        .padding(.leading, 18)
        .padding(.trailing, 16)
        .padding(.vertical, 14)
        .frame(minHeight: 84)
    }

    /// The last check's answer, once there is a pairing to check.
    ///
    /// A computer still waiting on the desktop's approval has no token yet, so
    /// there is nothing to probe and the row says what it is waiting for
    /// instead. The dot and the text carry the same three-way distinction
    /// Android's `ComputerRow.state` draws: green when the desktop answered,
    /// grey while there is no answer yet, red when the answer was a failure.
    @ViewBuilder private var statusLine: some View {
        if computer.isPaired {
            HStack(spacing: 6) {
                Text(verbatim: ComputerStatus.display(state, chinese: model.usesChinese))
                    .font(.caption)
                    .foregroundColor(ComputerStatus.isConnected(state) || ComputerStatus.isChecking(state)
                                     ? Palette.muted : .red)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
        } else {
            Text("等待电脑确认")
                .font(.caption)
                .foregroundColor(Palette.muted)
        }
    }

    private var state: String {
        computer.isPaired ? model.computerState(computer.address) : "等待电脑确认"
    }

    private var spokenState: String {
        computer.isPaired ? ComputerStatus.display(state, chinese: model.usesChinese)
            : (model.usesChinese ? "等待电脑确认" : "Waiting for desktop confirmation")
    }

    private var dot: Color {
        guard computer.isPaired else { return Palette.muted }
        if ComputerStatus.isConnected(state) { return .green }
        if ComputerStatus.isChecking(state) { return Palette.muted }
        return .red
    }
}

/// Android's `manageComputer` is a bottom dialog with a grouped pair of
/// actions. Rename and forget replace that dialog rather than stacking native
/// Form/Alert chrome over it.
private struct ComputerManagePanel: View {
    let computer: PairedComputer
    let availableHeight: CGFloat
    let onClose: () -> Void
    @EnvironmentObject private var model: AppModel
    @FocusState private var nameFocused: Bool
    @State private var mode: Mode = .choices
    @State private var name = ""
    @State private var feedback = "最多 80 个字符"

    private enum Mode { case choices, rename, forget }

    @ViewBuilder var body: some View {
        switch mode {
        case .choices:
            VStack(spacing: 0) {
                grip
                header(computer.displayName, description: computerDescription)
                SettingsCard {
                    Button {
                        name = computer.displayName
                        feedback = "最多 80 个字符"
                        mode = .rename
                    } label: {
                        SettingsRowLabel(icon: "", title: "重命名",
                                         detail: "更改这台电脑在本机显示的名称")
                    }
                    .buttonStyle(.plain)
                    SettingsDivider(leading: 16)
                    Button { mode = .forget } label: {
                        SettingsRowLabel(icon: "", title: "移除电脑",
                                         detail: UIDevice.current.userInterfaceIdiom == .pad
                                             ? "删除平板上的凭据，电脑上的会话不受影响"
                                             : "删除手机上的凭据，电脑上的会话不受影响",
                                         destructive: true)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 14)
            .padding(.bottom, 26)
            .background(panelBackground)
        case .rename:
            VStack(alignment: .leading, spacing: 0) {
                if !compactRename { grip }
                header("重命名电脑",
                       description: compactRename ? "" : (UIDevice.current.userInterfaceIdiom == .pad
                           ? "取一个容易辨认的名字，仅在这台平板上显示。"
                           : "取一个容易辨认的名字，仅在这台手机上显示。"),
                       localized: true)
                Text("电脑名称")
                    .font(.system(size: Palette.textSmall))
                    .foregroundColor(Palette.secondary)
                    .padding(.bottom, 6)
                TextField("例如：工作电脑", text: $name)
                    .font(.system(size: Palette.textRow))
                    .foregroundColor(Palette.ink)
                    .textInputAutocapitalization(.sentences)
                    .submitLabel(.done)
                    .focused($nameFocused)
                    .onSubmit(saveName)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 54)
                    .background(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                        .fill(Palette.field))
                    .overlay(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                        .stroke(Palette.fieldBorder, lineWidth: 1))
                    .accessibilityLabel("电脑名称")
                    .onChange(of: name) { value in
                        if ComposerText.utf16Length(value) > 80 {
                            name = ComposerText.limited(value, to: 80)
                        }
                    }
                Text(LocalizedStringKey(feedback))
                    .font(.system(size: Palette.textSmall))
                    .foregroundColor(feedback == "最多 80 个字符" ? Palette.secondary : Palette.error)
                    .padding(.top, 6)
                VStack(spacing: 8) {
                    SettingsDialogAction(title: "保存", primary: true, action: saveName)
                    SettingsDialogAction(title: "取消", primary: false, action: onClose)
                }
                .padding(.top, compactRename ? 4 : 12)
            }
            .padding(.horizontal, 18)
            .padding(.top, compactRename ? 8 : 14)
            .padding(.bottom, compactRename ? 8 : 18)
            .background(panelBackground)
            .onAppear { nameFocused = true }
        case .forget:
            SettingsMessagePanel(title: "移除这台电脑？",
                                 message: UIDevice.current.userInterfaceIdiom == .pad
                                     ? "将删除平板上的凭据。若要撤销权限，还需在电脑端撤销此设备。"
                                     : "将删除手机上的凭据。若要撤销权限，还需在电脑端撤销此设备。",
                                 confirmTitle: "移除", cancelTitle: "取消",
                                 onConfirm: {
                                     if model.remove(computer.address) { onClose() }
                                 }, onCancel: onClose)
        }
    }

    private var grip: some View {
        Capsule()
            .fill(Palette.divider)
            .frame(width: 36, height: 4)
            .frame(maxWidth: .infinity)
            .padding(.bottom, 16)
            .accessibilityHidden(true)
    }

    private func header(_ title: String, description: String, localized: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 13) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: Palette.textCard))
                    .foregroundColor(Palette.accent)
                    .frame(width: 40, height: 40)
                    .background(RoundedRectangle(cornerRadius: Palette.radius, style: .continuous)
                        .fill(Palette.card))
                    .accessibilityHidden(true)
                Group {
                    if localized { Text(LocalizedStringKey(title)) }
                    else { Text(verbatim: title) }
                }
                .font(.system(size: Palette.textTitle, weight: .medium))
                .foregroundColor(Palette.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: Palette.textRow, weight: .medium))
                        .foregroundColor(Palette.secondary)
                        .frame(width: 40, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("关闭")
            }
            if !description.isEmpty {
                Group {
                    if localized { Text(LocalizedStringKey(description)) }
                    else { Text(verbatim: description) }
                }
                .font(.system(size: Palette.textNote))
                .foregroundColor(Palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10)
                .padding(.bottom, 16)
            }
        }
    }

    private var compactRename: Bool { availableHeight < 360 }

    private var computerDescription: String {
        let state = computer.isPaired
            ? ComputerStatus.display(model.computerState(computer.address), chinese: model.usesChinese)
            : (model.usesChinese ? "等待电脑确认" : "Waiting for desktop confirmation")
        return computer.address + (state.isEmpty ? "" : "\n" + state)
    }

    private var panelBackground: some View {
        RoundedRectangle(cornerRadius: Palette.sheetRadius, style: .continuous)
            .fill(Palette.grouped)
    }

    private func saveName() {
        let value = ComposerText.androidTrim(name)
        guard !value.isEmpty else {
            feedback = "请输入电脑名称"
            nameFocused = true
            return
        }
        if model.rename(computer.address, to: value) {
            onClose()
        } else {
            feedback = "保存失败，请重试"
        }
    }
}

// MARK: - Pairing

struct PairingView: View {
    let initialComputer: PairedComputer?
    let resumePending: Bool
    let onApproved: () -> Void
    @EnvironmentObject private var model: AppModel
    @Environment(\.presentationMode) private var presentation
    @State private var address = ""
    @State private var port = PairingDraft.defaultPort
    @State private var code = ""
    @State private var name = ""
    @State private var fieldError: PairingField?
    @State private var fieldMessage = ""
    @State private var scanning = false
    @State private var showingMobileAccess = false

    init(initialComputer: PairedComputer? = nil, resumePending: Bool = false,
         onApproved: @escaping () -> Void = {}) {
        self.initialComputer = initialComputer
        self.resumePending = resumePending
        self.onApproved = onApproved
    }

    /// What to say under the form.
    ///
    /// Read straight off the phase rather than copied into `@State` by
    /// `onChange`: the sheet's own alert can never be shown while the sheet is
    /// up, so this line is the only place a failed pairing can be reported —
    /// and anything that has to survive a missed `onChange` cannot be mirrored
    /// into state. A field error from validation is the one thing the phase
    /// does not carry, so it is kept separately and wins while it is set.
    private var statusText: String {
        if !fieldMessage.isEmpty { return fieldMessage }
        switch model.pairingPhase {
        case .awaitingApproval:
            return "已发送，请在电脑上确认这个请求。"
        case .expired:
            return "配对码已过期，请在电脑上重新生成。"
        case .failed(let reason):
            return reason
        default:
            return ""
        }
    }

    var body: some View {
        NavigationView {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 0) {
                    SettingsCard {
                        Button { showingMobileAccess = true } label: {
                            SettingsRowLabel(icon: "checkmark.shield", title: "Tailscale 网络",
                                             value: mobileAccessState)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.bottom, 4)
                    SettingsNote(text: UIDevice.current.userInterfaceIdiom == .pad
                        ? "平板与电脑需登录同一个 Tailscale 网络。"
                        : "手机与电脑需登录同一个 Tailscale 网络。")
                        .padding(.bottom, 8)

                    SettingsCard {
                        VStack(alignment: .leading, spacing: 0) {
                            HStack(spacing: 12) {
                                Image(systemName: "camera")
                                    .font(.system(size: Palette.textDialog))
                                    .foregroundColor(Palette.accent)
                                    .frame(width: 26, height: 26)
                                Text("扫描电脑二维码")
                                    .font(.system(size: Palette.textRowStrong, weight: .medium))
                                    .foregroundColor(Palette.ink)
                            }
                            Text("打开电脑「手机访问」生成二维码。\n扫描后自动发起配对。")
                                .font(.system(size: Palette.textBody))
                                .foregroundColor(Palette.secondary)
                                .lineSpacing(3)
                                .padding(.top, 12)
                                .padding(.bottom, 8)
                            Button { scanning = true } label: {
                                Text("扫描二维码")
                                    .font(.system(size: Palette.textBody, weight: .medium))
                                    .foregroundColor(Palette.ink)
                                    .frame(maxWidth: .infinity, minHeight: 48)
                                    .background(RoundedRectangle(cornerRadius: Palette.capsuleRadius, style: .continuous)
                                        .fill(Palette.divider))
                            }
                            .buttonStyle(.plain)
                            .disabled(model.pairingPhase.isBusy)
                        }
                        .padding(.horizontal, 18)
                        .padding(.top, 16)
                        .padding(.bottom, 12)
                    }
                    .padding(.bottom, 12)

                    SettingsGroupLabel(title: "配对信息 · 也可手动填写")
                    SettingsCard {
                        VStack(spacing: 6) {
                            HStack(alignment: .top, spacing: 12) {
                                Field(title: "电脑 IP（Tailscale）", text: $address,
                                      hint: "100.x.y.z", invalid: fieldError == .address)
                                    .keyboardType(.numbersAndPunctuation)
                                    .autocapitalization(.none)
                                Field(title: "端口", text: $port, hint: "43127",
                                      invalid: fieldError == .port, maxLength: 5)
                                    .keyboardType(.numberPad)
                                    .frame(width: 96)
                            }
                            Field(title: "一次性配对码", text: $code, hint: "24 位配对码",
                                  invalid: fieldError == .code, maxLength: 24)
                                .autocapitalization(.none)
                            Field(title: UIDevice.current.userInterfaceIdiom == .pad
                                      ? "平板名称" : "本机名称", text: $name,
                                  hint: UIDevice.current.userInterfaceIdiom == .pad
                                      ? "平板上显示的名字" : "手机上显示的名字",
                                  invalid: fieldError == .name, maxLength: 80)
                        }
                        .padding(.horizontal, 18)
                        .padding(.top, 17)
                        .padding(.bottom, 18)
                    }
                    .disabled(model.pairingPhase.isBusy)
                    SettingsNote(text: "请求发出后，在电脑端确认授权即可连接。")

                    if !statusText.isEmpty {
                        StatusLine(text: statusText, tone: statusTone)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 27)
                .padding(.bottom, 24)
            }
            .background(Palette.grouped.ignoresSafeArea())
            .safeAreaInset(edge: .bottom, spacing: 0) { pairingActions }
            .navigationTitle("配对电脑")
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    RoundBackButton {
                        model.pairing.cancel()
                        presentation.wrappedValue.dismiss()
                    }
                }
            }
            .onAppear {
                model.pairingSheetOpen = true
                model.refreshNode()
                if resumePending {
                    do { try model.pairing.resume() }
                    catch { fieldMessage = error.localizedDescription }
                }
                fill()
            }
            .onDisappear { model.pairingSheetOpen = false }
            .onChange(of: model.pairingPhase) { phase in reflect(phase) }
            .fullScreenCover(isPresented: $scanning) {
                PairingScannerView { payload in
                    scanning = false
                    apply(payload)
                }
            }
            .fullScreenCover(isPresented: $showingMobileAccess) {
                NavigationView { MobileAccessView().environmentObject(model) }
                    .navigationViewStyle(.stack)
            }
        }
    }

    private var pairingActions: some View {
        Button { submit() } label: {
            HStack(spacing: 8) {
                if model.pairingPhase.isBusy { ProgressView().tint(.white) }
                Text(LocalizedStringKey(pairButtonTitle))
            }
            .font(.system(size: Palette.textBody, weight: .medium))
            .foregroundColor(.white)
            .frame(maxWidth: .infinity, minHeight: 52)
            .background(RoundedRectangle(cornerRadius: Palette.capsuleRadius, style: .continuous)
                .fill(Palette.accent))
        }
        .buttonStyle(.plain)
        .disabled(model.pairingPhase.isBusy)
        .padding(.horizontal, 20)
        // Android's fixed action lives below the scrolling form and its
        // status line. Reserve that same empty band above the button so the
        // explanatory note below the fields is initially under the viewport.
        .padding(.top, 50)
        .padding(.bottom, 8)
        .background(Palette.grouped)
    }

    private var pairButtonTitle: String {
        switch model.pairingPhase {
        case .requesting: return "正在请求配对…"
        case .awaitingApproval: return "等待电脑确认…"
        default:
            return canResumeRequest ? "继续等待电脑确认" : "请求配对"
        }
    }

    private var canResumeRequest: Bool {
        model.current?.isAwaitingApproval == true &&
            ComposerText.androidTrim(code).isEmpty
    }

    private var statusTone: StatusLine.Tone {
        switch model.pairingPhase {
        case .failed, .expired: return .bad
        default: return fieldMessage.isEmpty ? .muted : .bad
        }
    }

    private var mobileAccessState: String {
        if !EmbeddedNetwork.shared.isEnabled { return "外部模式" }
        return EmbeddedNetwork.shared.isOnline ? "已连接" : "未连接"
    }

    private func fill() {
        let saved = model.pairing.draft
        if let initialComputer, let endpoint = initialComputer.endpoint,
           (saved.address != endpoint.host || saved.port != String(endpoint.port)) {
            address = endpoint.host
            port = String(endpoint.port)
            name = initialComputer.name.isEmpty ? model.preferences.deviceName : initialComputer.name
        } else if !saved.address.isEmpty {
            address = saved.address
            port = saved.port
            code = saved.code
            name = saved.name
        } else {
            name = model.preferences.deviceName
        }
    }

    private func apply(_ payload: PairingPayload) {
        let draft = PairingDraft(payload: payload, name: name.isEmpty ? model.preferences.deviceName : name)
        address = draft.address
        port = draft.port
        code = draft.code
        submit()
    }

    private func submit() {
        fieldError = nil
        fieldMessage = ""
        if canResumeRequest {
            do { try model.pairing.resume() }
            catch { fieldMessage = error.localizedDescription }
            return
        }
        let draft = PairingDraft(address: address, port: port, code: code, name: name)
        do {
            try model.pairing.start(draft)
        } catch let error as PairingFieldError {
            fieldError = error.field
            fieldMessage = error.message
        } catch {
            fieldMessage = error.localizedDescription
        }
    }

    /// The one phase change the sheet has to act on: a pairing that was
    /// approved closes it. Everything else is already on screen, because the
    /// status line is read off the phase.
    private func reflect(_ phase: PairingController.Phase) {
        switch phase {
        case .approved:
            onApproved()
            presentation.wrappedValue.dismiss()
        case .awaitingApproval:
            code = ""
            fieldError = nil
            fieldMessage = ""
        case .requesting, .expired, .failed:
            // The flow has moved on from the form, so whatever the form was
            // complaining about is no longer what the person needs to read.
            fieldError = nil
            fieldMessage = ""
        case .idle:
            break
        }
    }
}

/// A labelled text field that can mark itself as the wrong one.
private struct Field: View {
    let title: String
    @Binding var text: String
    let hint: String
    var invalid = false
    var maxLength: Int? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(LocalizedStringKey(title))
                .font(.system(size: Palette.textSmall))
                .foregroundColor(invalid ? Palette.error : Palette.secondary)
            TextField(LocalizedStringKey(hint), text: $text)
                .font(.system(size: Palette.textRow))
                .foregroundColor(Palette.ink)
                .padding(.horizontal, 14)
                .frame(minHeight: 49)
                .background(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                    .fill(Palette.field))
                .overlay(RoundedRectangle(cornerRadius: Palette.fieldRadius, style: .continuous)
                    .stroke(invalid ? Palette.error : Palette.fieldBorder, lineWidth: 1))
        }
        .onChange(of: text) { value in
            guard let maxLength, ComposerText.utf16Length(value) > maxLength else { return }
            text = ComposerText.limited(value, to: maxLength)
        }
    }
}

/// Dedicated camera screen, matching Android's scanner activity. Keeping the
/// live preview out of the settings card also gives the camera enough area to
/// focus on a QR shown on a desktop monitor.
private struct PairingScannerView: View {
    let onCode: (PairingPayload) -> Void
    @Environment(\.presentationMode) private var presentation
    @Environment(\.scenePhase) private var scenePhase
    @State private var scanner = QRCodeScanner()
    @State private var failure: String?
    @State private var visible = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                RoundBackButton {
                    scanner.stop()
                    presentation.wrappedValue.dismiss()
                }
                .accessibilityLabel("返回配对")
                Text("扫描配对二维码")
                    .font(.system(size: Palette.textTitle, weight: .medium))
                    .foregroundColor(Palette.ink)
                    .frame(maxWidth: .infinity)
                    .accessibilityAddTraits(.isHeader)
                Color.clear.frame(width: 48, height: 1)
                    .accessibilityHidden(true)
            }
            .padding(.top, 4)
            .padding(.bottom, 16)

            GeometryReader { geometry in
                QRCodeScannerView(scanner: scanner)
                    .background(Color(red: 15 / 255, green: 17 / 255, blue: 21 / 255))
                    .overlay(ScannerGuide())
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .clipShape(RoundedRectangle(cornerRadius: Palette.groupRadius,
                                                style: .continuous))
                    .accessibilityHidden(true)
            }
            Text(LocalizedStringKey(failure ?? "将电脑「手机访问」中生成的二维码放入取景框。"))
                .font(.system(size: Palette.textBody))
                .foregroundColor(Palette.secondary)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 12)
                .padding(.top, 20)
                .accessibilityAddTraits(.updatesFrequently)
        }
        .padding(.horizontal, 18)
        .padding(.top, 12)
        .padding(.bottom, 24)
        .background(Palette.grouped.ignoresSafeArea())
        .onAppear {
            visible = true
            startIfPossible()
        }
        .onDisappear {
            visible = false
            scanner.stop()
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active {
                startIfPossible()
            } else {
                scanner.stop()
            }
        }
    }

    private func startIfPossible() {
        guard visible, scenePhase == .active else { return }
        switch QRCodeScanner.access() {
        case .notDetermined:
            QRCodeScanner.requestAccess { granted in
                DispatchQueue.main.async {
                    guard visible, scenePhase == .active else { return }
                    if granted { startIfPossible() }
                    else { failure = "需要相机权限才能扫描二维码。可在系统设置中授予后重试，或手动输入地址和配对码。" }
                }
            }
            return
        case .denied, .restricted:
            failure = "需要相机权限才能扫描二维码。可在系统设置中授予后重试，或手动输入地址和配对码。"
            return
        case .granted:
            break
        }
        do {
            try scanner.configure()
            failure = nil
            arm()
            scanner.start()
        } catch {
            failure = "无法打开相机。请在配对页下方手动填写地址和配对码。"
        }
    }

    private func arm() {
        scanner.onCode { value in
            guard visible, scenePhase == .active else { return }
            guard let payload = try? PairingPayload(value) else {
                failure = "这不是 Camellia 的配对二维码，请扫描电脑端新生成的二维码。"
                // The scanner deliberately delivers one code per arm. Re-arm
                // after an invalid barcode so the user need not close and open
                // the camera merely because another QR entered the frame first.
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    guard visible, scenePhase == .active else { return }
                    failure = nil
                    arm()
                }
                return
            }
            scanner.stop()
            onCode(payload)
        }
    }
}

/// Android's ScanGuide: dim the viewfinder around a 280-point QR window,
/// then draw only the four white corners over its faint rounded outline.
private struct ScannerGuide: View {
    var body: some View {
        GeometryReader { geometry in
            let side = min(280, min(geometry.size.width, geometry.size.height) * 0.76)
            let frame = CGRect(x: (geometry.size.width - side) / 2,
                               y: (geometry.size.height - side) / 2,
                               width: side, height: side)
            Path { path in
                path.addRect(CGRect(origin: .zero, size: geometry.size))
                path.addRoundedRect(in: frame, cornerSize: CGSize(width: 20, height: 20))
            }
            .fill(Color.black.opacity(0.4), style: FillStyle(eoFill: true))
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(Color.white.opacity(0.5), lineWidth: 1)
                .frame(width: side, height: side)
                .position(x: frame.midX, y: frame.midY)
            corners(in: frame)
                .stroke(Color.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
        }
        .allowsHitTesting(false)
    }

    private func corners(in frame: CGRect) -> Path {
        let left = frame.minX, right = frame.maxX
        let top = frame.minY, bottom = frame.maxY
        var path = Path()
        path.move(to: CGPoint(x: left, y: top + 36))
        path.addLine(to: CGPoint(x: left, y: top + 20))
        path.addQuadCurve(to: CGPoint(x: left + 20, y: top), control: CGPoint(x: left, y: top))
        path.addLine(to: CGPoint(x: left + 36, y: top))
        path.move(to: CGPoint(x: right - 36, y: top))
        path.addLine(to: CGPoint(x: right - 20, y: top))
        path.addQuadCurve(to: CGPoint(x: right, y: top + 20), control: CGPoint(x: right, y: top))
        path.addLine(to: CGPoint(x: right, y: top + 36))
        path.move(to: CGPoint(x: right, y: bottom - 36))
        path.addLine(to: CGPoint(x: right, y: bottom - 20))
        path.addQuadCurve(to: CGPoint(x: right - 20, y: bottom), control: CGPoint(x: right, y: bottom))
        path.addLine(to: CGPoint(x: right - 36, y: bottom))
        path.move(to: CGPoint(x: left + 36, y: bottom))
        path.addLine(to: CGPoint(x: left + 20, y: bottom))
        path.addQuadCurve(to: CGPoint(x: left, y: bottom - 20), control: CGPoint(x: left, y: bottom))
        path.addLine(to: CGPoint(x: left, y: bottom - 36))
        return path
    }
}

// MARK: - Settings

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var local: LocalChatModel
    @State private var launchTarget = LaunchScreen.requested
    @State private var editingName = LaunchScreen.requested == "deviceName"
    @State private var nameDraft = ""
    @State private var nameError = ""

    var body: some View {
        NavigationView {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 0) {
                    SettingsCard {
                        NavigationLink(destination: ProviderSettingsView()
                            .environmentObject(local).environmentObject(model),
                                       isActive: launchBinding("providers")) {
                            SettingsRowLabel(icon: "key", title: "供应商与 Key")
                        }
                        .buttonStyle(.plain)
                        SettingsDivider()
                        NavigationLink(destination: GeneralSettingsView().environmentObject(model),
                                       isActive: launchBinding("general")) {
                            SettingsRowLabel(icon: "slider.horizontal.3", title: "通用")
                        }
                        .buttonStyle(.plain)
                    }

                    SettingsGroupLabel(title: "数据与连接")
                    SettingsCard {
                        NavigationLink(destination: LocalChatArchiveView().environmentObject(local),
                                       isActive: launchBinding("archived")) {
                            SettingsRowLabel(icon: "archivebox", title: "已归档",
                                             value: local.archived.isEmpty ? "" : "\(local.archived.count)")
                        }
                        .buttonStyle(.plain)
                        SettingsDivider()
                        NavigationLink(destination: MobileAccessView().environmentObject(model),
                                       isActive: launchBinding("mobileAccess")) {
                            SettingsRowLabel(icon: UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone",
                                             title: "手机访问", value: mobileAccessState)
                        }
                        .buttonStyle(.plain)
                        SettingsDivider()
                        Button { openNameEditor() } label: {
                            SettingsRowLabel(icon: "slider.horizontal.3",
                                             title: deviceNameTitle,
                                             value: model.preferences.deviceName)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 27)
                .padding(.bottom, 24)
            }
            .settingsPage(title: "设置")
        }
        .navigationViewStyle(.stack)
        .onAppear {
            if editingName { nameDraft = model.preferences.deviceName }
        }
        .overlay { if editingName { nameEditor } }
    }

    private var mobileAccessState: String {
        if !EmbeddedNetwork.shared.isEnabled { return "外部模式" }
        return EmbeddedNetwork.shared.isOnline ? "已连接" : "未连接"
    }

    private var deviceNameTitle: String {
        if model.usesChinese { return "本机名称" }
        return UIDevice.current.userInterfaceIdiom == .pad ? "This iPad's name" : "This phone's name"
    }

    private func launchBinding(_ page: String) -> Binding<Bool> {
        Binding(get: { launchTarget == page },
                set: { launchTarget = $0 ? page : "" })
    }

    private func openNameEditor() {
        nameDraft = model.preferences.deviceName
        nameError = ""
        editingName = true
    }

    private var nameEditor: some View {
        ZStack {
            Color.black.opacity(0.38).ignoresSafeArea()
                .onTapGesture { editingName = false }
            VStack(alignment: .leading, spacing: 14) {
                Text(deviceNameTitle)
                    .font(.system(size: Palette.textTitle, weight: .semibold))
                    .foregroundColor(Palette.ink)
                Text("配对时默认提交这个名称，电脑端可以在授权时确认。最多 80 个字符。")
                    .font(.system(size: Palette.textNote))
                    .foregroundColor(Palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("设备名称")
                    .font(.system(size: Palette.textSmall))
                    .foregroundColor(Palette.secondary)
                TextField("设备名称", text: $nameDraft)
                    .font(.system(size: Palette.textRow))
                    .foregroundColor(Palette.ink)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 52)
                    .background(RoundedRectangle(cornerRadius: Palette.fieldRadius).fill(Palette.field))
                    .overlay(RoundedRectangle(cornerRadius: Palette.fieldRadius)
                        .stroke(nameError.isEmpty ? Palette.fieldBorder : Palette.error, lineWidth: 1))
                if !nameError.isEmpty {
                    Text(LocalizedStringKey(nameError))
                        .font(.system(size: Palette.textSmall))
                        .foregroundColor(Palette.error)
                }
                HStack {
                    Spacer()
                    Button("取消") { editingName = false }
                    Button("保存", action: saveName)
                        .font(.system(size: Palette.textBody, weight: .semibold))
                }
                .font(.system(size: Palette.textBody))
                .padding(.top, 4)
            }
            .padding(20)
            .frame(maxWidth: 340)
            .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Palette.card))
            .shadow(color: .black.opacity(0.18), radius: 24)
            .padding(.horizontal, 24)
        }
    }

    private func saveName() {
        let name = ComposerText.androidTrim(nameDraft)
        guard !name.isEmpty, ComposerText.utf16Length(name) <= 80 else {
            nameError = "请输入 1–80 个字符的名称。"
            return
        }
        model.setDeviceName(name)
        editingName = false
    }
}

private struct GeneralSettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var choice: Choice?

    private enum Choice {
        case language, theme, enter
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 0) {
                SettingsCard {
                    preferenceRow(icon: "globe", title: "语言",
                                  value: model.preferences.language.label, choice: .language)
                    SettingsDivider()
                    preferenceRow(icon: "sun.max", title: "外观",
                                  value: model.preferences.theme.label, choice: .theme)
                    SettingsDivider()
                    preferenceRow(icon: "slider.horizontal.3", title: "键盘回车",
                                  value: enterLabel(model.preferences.enterMode), choice: .enter)
                }
                SettingsNote(text: "iOS 键盘没有统一的长按回车手势；需要稳定换行时，请选择回车换行并点击发送按钮。")
                SettingsNote(text: UIDevice.current.userInterfaceIdiom == .pad
                    ? "以上设置仅作用于这台平板。" : "以上设置仅作用于这台手机。")

                SettingsGroupLabel(title: "远程控制")
                SettingsCard {
                    Toggle(isOn: Binding(get: { model.preferences.keepAlive },
                                         set: { model.setKeepAlive($0) })) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("短暂离开时保持连接")
                                .font(.system(size: Palette.textRowStrong))
                                .foregroundColor(Palette.ink)
                            Text("使用系统允许的短暂后台时间，返回后尽快继续。")
                                .font(.system(size: Palette.textNote))
                                .foregroundColor(Palette.secondary)
                        }
                    }
                    .toggleStyle(SwitchToggleStyle(tint: Palette.accent))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 13)
                }
                SettingsNote(text: "iOS 不允许第三方应用像 Android 前台服务一样常驻；系统可能提前结束连接，返回应用后会自动重连。")
            }
            .padding(.horizontal, 20)
            .padding(.top, 27)
            .padding(.bottom, 24)
        }
        .settingsPage(title: "通用")
        .overlay(alignment: .bottom) {
            if let choice {
                ZStack(alignment: .bottom) {
                    Color.black.opacity(0.28).ignoresSafeArea()
                        .onTapGesture { self.choice = nil }
                    SettingsChoicePanel(title: choiceTitle(choice), labels: choiceLabels(choice),
                                        selected: selectedIndex(choice), localizeLabels: true,
                                        onChoose: { index in select(index, for: choice) },
                                        onCancel: { self.choice = nil })
                        .frame(maxWidth: 560)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 12)
                }
            }
        }
    }

    private func preferenceRow(icon: String, title: String, value: String, choice: Choice) -> some View {
        Button { self.choice = choice } label: {
            SettingsRowLabel(icon: icon, title: title, detail: value)
        }
        .buttonStyle(.plain)
    }

    private func choiceTitle(_ choice: Choice) -> String {
        switch choice {
        case .language: return "语言"
        case .theme: return "外观"
        case .enter: return "键盘回车"
        }
    }

    private func choiceLabels(_ choice: Choice) -> [String] {
        switch choice {
        case .language:
            return AppLanguage.allCases.map(\.label)
        case .theme:
            return AppTheme.allCases.map(\.label)
        case .enter:
            return EnterMode.allCases.map(enterLabel)
        }
    }

    private func selectedIndex(_ choice: Choice) -> Int {
        switch choice {
        case .language: return AppLanguage.allCases.firstIndex(of: model.preferences.language) ?? 0
        case .theme: return AppTheme.allCases.firstIndex(of: model.preferences.theme) ?? 0
        case .enter: return EnterMode.allCases.firstIndex(of: model.preferences.enterMode) ?? 0
        }
    }

    private func select(_ index: Int, for choice: Choice) {
        self.choice = nil
        switch choice {
        case .language:
            let value = AppLanguage.allCases[index]
            if value != model.preferences.language { model.setLanguage(value) }
        case .theme:
            let value = AppTheme.allCases[index]
            if value != model.preferences.theme { model.setTheme(value) }
        case .enter:
            let value = EnterMode.allCases[index]
            if value != model.preferences.enterMode { model.setEnterMode(value) }
        }
    }

    private func enterLabel(_ mode: EnterMode) -> String {
        switch mode {
        case .send: return "回车发送"
        case .newline: return "回车换行"
        case .button: return "仅点击发送按钮"
        }
    }
}

struct MobileAccessView: View {
    @EnvironmentObject private var model: AppModel
    @State private var embedded = EmbeddedNetwork.shared.isEnabled
    @State private var forgetting = false
    @State private var loginRequested = false
    @State private var loginBusy = false
    @State private var showingLicenses = false
    @State private var prompt: MobileAccessPrompt?

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 0) {
                Text(LocalizedStringKey(statusText))
                    .font(.system(size: Palette.textNote))
                    .foregroundColor(Palette.ink)
                    .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
                    .padding(.horizontal, 16)
                    .background(RoundedRectangle(cornerRadius: Palette.homeRadius, style: .continuous)
                        .fill(Palette.card))
                    .overlay(RoundedRectangle(cornerRadius: Palette.homeRadius, style: .continuous)
                        .stroke(Palette.divider, lineWidth: 1))
                    .padding(.bottom, 10)

                SettingsCard {
                    Toggle(isOn: Binding(get: { embedded }, set: setEmbedded)) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("内置 Tailscale")
                                .font(.system(size: Palette.textRowStrong))
                                .foregroundColor(Palette.ink)
                            Text("无需另装应用，仅连接 Camellia，不接管其他应用流量。")
                                .font(.system(size: Palette.textNote))
                                .foregroundColor(Palette.secondary)
                        }
                    }
                    .toggleStyle(SwitchToggleStyle(tint: Palette.accent))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 18)
                    SettingsDivider(leading: 16)
                    Button(action: openLogin) {
                        SettingsRowLabel(icon: "", title: "登录 Tailscale",
                                         detail: "登录与电脑相同的网络")
                            .padding(.vertical, 5)
                    }
                    .buttonStyle(.plain)
                    .disabled(!embedded)
                    SettingsDivider(leading: 16)
                    Button { model.refreshNode() } label: {
                        SettingsRowLabel(icon: "", title: "刷新网络状态")
                    }
                    .buttonStyle(.plain)
                    .disabled(!embedded)
                }
                SettingsNote(text: "浏览器授权后返回此处刷新，再继续配对。关闭内置模式可使用外部 Tailscale；不会自动降级为未加密公网连接。")

                SettingsGroupLabel(title: "网络与隐私")
                SettingsCard {
                    SettingsRowLabel(icon: "", title: "独立网络身份",
                                     detail: UIDevice.current.userInterfaceIdiom == .pad
                                         ? "这台平板以 camellia-ios 加入网络，遵循你的 tailnet 访问规则。"
                                         : "这台手机以 camellia-ios 加入网络，遵循你的 tailnet 访问规则。",
                                     showsChevron: false)
                    SettingsDivider(leading: 16)
                    Button { prompt = .forget } label: {
                        SettingsRowLabel(icon: "", title: "清除内置网络身份",
                                         detail: "清除后需要重新登录", destructive: true)
                    }
                    .buttonStyle(.plain)
                    .disabled(!embedded || forgetting)
                }

                SettingsGroupLabel(title: "关于")
                SettingsCard {
                    Button { showingLicenses = true } label: {
                        SettingsRowLabel(icon: "", title: "开源许可")
                    }
                    .buttonStyle(.plain)
                }

                if AppStores.credentialsOnFile {
                    SettingsGroupLabel(title: "存储")
                    SettingsCard {
                        StatusLine(text: "此安装没有 Keychain 权限，凭据密钥保存在应用沙盒内，而不是系统钥匙串。", tone: .bad)
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 27)
            .padding(.bottom, 24)
        }
        .settingsPage(title: "手机访问")
        .onAppear { model.refreshNode() }
        .onChange(of: model.loginURL, perform: openPendingLogin)
        .onChange(of: model.nodeRunning) { running in
            if running { loginRequested = false; loginBusy = false }
        }
        .onChange(of: model.notice) { _ in adoptNotice() }
        .alert(item: $prompt, content: promptAlert)
        .sheet(isPresented: $showingLicenses) { OpenSourceLicensesView() }
    }

    private var statusText: String {
        if !embedded { return "外部模式：请自行连接 Tailscale App。" }
        if forgetting { return "正在清除内置网络身份…" }
        if loginBusy { return "正在准备 Tailscale 登录…" }
        if model.nodeRunning { return "已连接，可以返回配对。" }
        let state = model.nodeState.isEmpty ? "NoState" : model.nodeState
        return model.usesChinese ? "网络状态：\(state)" : "Network state: \(state)"
    }

    private func setEmbedded(_ enabled: Bool) {
        embedded = enabled
        EmbeddedNetwork.shared.isEnabled = enabled
        if enabled { EmbeddedNetwork.shared.start() }
        model.networkModeChanged()
        model.refreshNode()
    }

    private func openLogin() {
        if let url = model.loginURL {
            LoginPresenter.shared.present(url)
            return
        }
        guard !loginBusy else { return }
        loginRequested = true
        loginBusy = true
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try EmbeddedNetwork.shared.login() }
            DispatchQueue.main.async {
                switch result {
                case .success:
                    model.refreshNode()
                case .failure(let error):
                    loginRequested = false
                    loginBusy = false
                    prompt = .notice(AppModel.Notice(text: error.localizedDescription, serious: true))
                }
            }
        }
    }

    private func openPendingLogin(_ url: URL?) {
        guard loginRequested, let url else { return }
        loginRequested = false
        loginBusy = false
        LoginPresenter.shared.present(url)
    }

    private func forget() {
        forgetting = true
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { try EmbeddedNetwork.shared.forget() }
            DispatchQueue.main.async {
                forgetting = false
                switch result {
                case .success:
                    prompt = .notice(AppModel.Notice(text: "已清除，请重新登录。", serious: false))
                    model.refreshNode()
                case .failure(let error):
                    prompt = .notice(AppModel.Notice(text: error.localizedDescription, serious: true))
                }
            }
        }
    }

    private func promptAlert(_ value: MobileAccessPrompt) -> Alert {
        switch value {
        case .forget:
            return Alert(title: Text("清除内置网络身份？"),
                         message: Text(LocalizedStringKey(UIDevice.current.userInterfaceIdiom == .pad
                             ? "将删除平板本地网络身份，之后需要重新登录。还需在 Tailscale 管理后台撤销旧节点。"
                             : "将删除手机本地网络身份，之后需要重新登录。还需在 Tailscale 管理后台撤销旧节点。")),
                         primaryButton: .destructive(Text("清除"), action: forget),
                         secondaryButton: .cancel(Text("取消")))
        case .notice(let notice):
            return Alert(title: Text(notice.serious ? "出错了" : "提示"),
                         message: Text(LocalizedStringKey(notice.text)), dismissButton: .default(Text("好")))
        }
    }

    private func adoptNotice() {
        guard let notice = model.notice else { return }
        model.notice = nil
        prompt = .notice(notice)
    }
}

private enum MobileAccessPrompt: Identifiable {
    case forget
    case notice(AppModel.Notice)

    var id: String {
        switch self {
        case .forget: return "forget"
        case .notice(let notice): return "notice-" + notice.id.uuidString
        }
    }
}

private struct OpenSourceLicensesView: View {
    @Environment(\.presentationMode) private var presentation

    var body: some View {
        NavigationView {
            ScrollView {
                Text(notices)
                    .font(.system(size: Palette.textSmall, design: .monospaced))
                    .foregroundColor(Palette.ink)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
            .background(Palette.background.ignoresSafeArea())
            .navigationTitle("开源许可")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("关闭") { presentation.wrappedValue.dismiss() }
                }
            }
        }
        .navigationViewStyle(.stack)
    }

    private var notices: String {
        ["third-party-notices", "markdown-notices"].compactMap { name in
            guard let url = Bundle.main.url(forResource: name, withExtension: "txt") else { return nil }
            return try? String(contentsOf: url, encoding: .utf8)
        }.joined(separator: "\n\n")
    }
}

// MARK: - Remote permission labels
/// The three answers a desktop takes for "how much may run unattended".
///
/// The wording is Android's `RemoteSettingsPopup.permissionLabel` and
/// `permissions()` verbatim, because it is the same setting on the same desktop:
/// two phones naming one level differently is how a person changes it on one and
/// does not recognise the other. (`ask` is worth calling out — Android calls it
/// "手动批准" rather than the "每次询问" an earlier version here used.)
enum PermissionMode {
    static let all = [
        Item(id: "ask", title: "手动批准", detail: "执行需要授权的操作前先询问"),
        Item(id: "auto", title: "默认", detail: "常规操作自动执行，风险操作会询问"),
        Item(id: "full", title: "全自动", detail: "所有工具操作无需确认直接执行"),
    ]

    /// The level's own label, for the composer and the attach panel, where there
    /// is room for the name and not for the explanation. An unknown level reads
    /// as the strictest one, which is what the desktop would do with it.
    static func label(_ id: String, chinese: Bool = true) -> String {
        if chinese { return all.first { $0.id == id }?.title ?? all[0].title }
        switch id {
        case "full": return "Fully automatic"
        case "auto": return "Default"
        default: return "Manual approval"
        }
    }

    struct Item {
        let id: String
        let title: String
        let detail: String
    }
}
