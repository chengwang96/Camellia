import SwiftUI

@MainActor
final class RemoteUsageModel: ObservableObject {
    @Published var computer: PairedComputer?
    @Published var data: AccountUsage?
    @Published var loading = false
    @Published var cached = true
    @Published var notice = ""
    @Published var noticeTitle = ""
    @Published var detail = ""
    private var supported: Bool?
    private let worker = DispatchQueue(label: "camellia.account-usage")
    private var client: RemoteApi?
    private var poll: DispatchWorkItem?
    private var generation = 0
    private var polls = 0
    private var store: ComputerStore?
    private var active = false
    var chinese = true

    func select(_ computer: PairedComputer?, store: ComputerStore) {
        stop(); active = true; self.store = store; self.computer = computer
        data = nil; cached = true; notice = ""; noticeTitle = ""; detail = ""; polls = 0; supported = nil
        guard let computer else { return }
        let ticket = generation
        worker.async { [weak self] in
            let stored = try? store.all().first { $0.address == computer.address && $0.token == computer.token }
            let cached = stored.flatMap { $0.accountUsage }.flatMap(AccountUsage.init)
            DispatchQueue.main.async {
                guard let self, self.active, self.generation == ticket else { return }
                self.data = cached
                self.fetch()
            }
        }
    }
    func stop() {
        active = false; generation += 1; poll?.cancel(); poll = nil; client?.cancel(); client = nil; loading = false
    }
    func fetch(force: Bool = false) {
        guard active, !loading, let computer, let token = computer.token, let store else { return }
        if force { polls = 0 }
        poll?.cancel(); poll = nil; loading = true; notice = ""; noticeTitle = ""; detail = ""
        let ticket = generation
        let knownSupport = supported
        do {
            let request = try RemoteApi(endpoint: Endpoint(computer.address), token: token)
            client = request
            worker.async { [weak self] in
                let result: Result<(AccountUsage, Bool), Error>
                var capability = knownSupport
                do {
                    if force || capability == nil {
                        let info = try request.json("/v1/status")
                        capability = info.strings("capabilities").contains("account-usage")
                    }
                    let refreshAccounts = force && capability == true
                    let json = try request.json(refreshAccounts ? "/v1/account-usage/refresh" : "/v1/account-usage", payload: refreshAccounts ? [:] : nil)
                    guard let data = AccountUsage(json) else { throw RemoteApiError.invalidJSON }
                    var saved = false
                    do { saved = try store.saveAccountUsage(json, for: computer) } catch { }
                    result = .success((data, saved))
                } catch {
                    if let denied = error as? RemoteHttpError, [401, 403].contains(denied.status) {
                        try? store.saveAccountUsage(nil, for: computer)
                    }
                    result = .failure(error)
                }
                request.cancel()
                let available = capability
                DispatchQueue.main.async {
                    guard let self, self.active, self.generation == ticket else { return }
                    self.loading = false; self.client = nil; self.supported = available
                    switch result {
                    case .success(let (data, saved)):
                        self.data = data; self.cached = false
                        self.notice = saved ? "" : self.t("本次数据未缓存，离线时将显示旧记录。", "This result was not cached. Older data will appear offline.")
                        if data.json.bool("refreshing"), self.polls < 40 {
                            self.polls += 1
                            let work = DispatchWorkItem { [weak self] in self?.fetch() }
                            self.poll = work
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: work)
                        }
                    case .failure(let error):
                        self.cached = true
                        self.showFailure(error)
                        if let denied = error as? RemoteHttpError, [401, 403].contains(denied.status) { self.data = nil }
                    }
                }
            }
        } catch { loading = false; notice = String(describing: error) }
    }
    private func showFailure(_ error: Error) {
        detail = AppModel.describe(error)
        switch (error as? RemoteHttpError)?.status {
        case 404, 405:
            noticeTitle = t("电脑端需要更新或重启", "Update or restart the desktop")
            notice = t("请在这台电脑上更新并重启 Camellia，然后点击刷新。", "Update and restart Camellia on this computer, then tap Refresh.")
        case 401:
            noticeTitle = t("需要重新配对", "Pair this computer again")
            notice = t("配对已失效或被撤销。请返回远程电脑页面重新配对。", "Pairing has expired or was revoked. Pair again from Remote computers.")
        case 403:
            noticeTitle = t("需要完整电脑权限", "Full-device permission required")
            notice = t("请在电脑端的移动端访问设置中，允许此设备控制全部工作区。", "In the desktop's Mobile access settings, allow this device to control all workspaces.")
        default:
            noticeTitle = t("暂时无法同步", "Unable to sync")
            notice = data == nil ? t("请确认电脑已打开、网络已连接，然后重试。", "Check that the computer is running and connected, then try again.") : t("正在显示上次保存的数据。电脑恢复连接后，点击刷新即可更新。", "Showing saved data. Tap Refresh when the computer is connected again.")
        }
    }
    private func t(_ zh: String, _ en: String) -> String { chinese ? zh : en }
}

struct RemoteUsageView: View {
    var initialAddress = ""
    var onClose: (() -> Void)? = nil
    @EnvironmentObject private var app: AppModel
    @Environment(\.scenePhase) private var phase
    @StateObject private var usage = RemoteUsageModel()
    @State private var tab = "quota"
    @State private var range = "7"
    @State private var source = ""
    @State private var account = ""
    @State private var model = ""
    @State private var choice: ChoiceDropdownRequest?
    @State private var computerMenu = false
    @State private var computerAnchor: CGRect?
    @State private var detailsExpanded = false
    @State private var filtersExpanded = false
    private var paired: [PairedComputer] { app.computers.filter(\.isPaired) }
    private var accounts: [JSONObject] { usage.data?.accounts(source: source) ?? [] }
    private var rows: [JSONObject] { usage.data?.rows(range: range, source: source, account: account, model: model) ?? [] }
    private func t(_ zh: String, _ en: String) -> String { app.usesChinese ? zh : en }

    var body: some View {
        VStack(spacing: 0) {
            usageCard {
                HStack(spacing: 8) {
                    Button(action: chooseComputer) {
                        HStack(spacing: 12) {
                            MobileLineIcon(name: "computer", size: 22).foregroundColor(Palette.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(usage.computer?.displayName ?? t("选择电脑", "Choose a computer")).font(.system(size: Palette.textBody, weight: .medium)).foregroundColor(Palette.ink).lineLimit(1)
                                Text(status).font(.system(size: Palette.textSmall)).foregroundColor(Palette.secondary).fixedSize(horizontal: false, vertical: true)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            MobileLineIcon(name: "down", size: 14).rotationEffect(.degrees(computerMenu ? 180 : 0)).foregroundColor(Palette.secondary)
                        }.padding(.leading, 8).padding(.trailing, 4).padding(.vertical, 4).frame(minHeight: 56).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityIdentifier("usageComputer")
                        .background(GeometryReader { geometry in
                            Color.clear.preference(key: UsageComputerAnchorKey.self, value: geometry.frame(in: .named("usage-page")))
                        })
                    Button { usage.fetch(force: true) } label: {
                        Image(systemName: "arrow.clockwise").font(.system(size: 20)).foregroundColor(Palette.accent).frame(width: 48, height: 48).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel(t("刷新", "Refresh"))
                        .disabled(usage.loading || usage.computer == nil).opacity(usage.loading ? 0.5 : 1)
                        .accessibilityIdentifier("usageRefresh")
                }.padding(.horizontal, 6).padding(.vertical, 4)
            }
            .padding(.horizontal, 16)
            tabs.padding(.horizontal, 16).padding(.top, 8)
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    if !usage.notice.isEmpty { noticeCard }
                    if usage.computer != nil {
                        if usage.data != nil {
                            if usage.data?.json.bool("refreshFailed") == true { SettingsNote(text: t("部分刷新失败，保留上次成功结果。", "Refresh failed. Last successful readings are retained.")) }
                            filters
                            if tab == "quota" { quota } else { history }
                        } else if usage.notice.isEmpty {
                            usageCard {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(usage.loading ? t("正在连接电脑", "Connecting to computer") : t("连接后查看用量", "Connect to view usage")).font(.system(size: Palette.textRowStrong, weight: .medium)).foregroundColor(Palette.ink)
                                    note(t("订阅额度、API 余额和使用记录将在这里显示。", "Subscription quotas, API balances and usage will appear here."))
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
                            }
                        }
                    } else {
                        SettingsNote(text: t("在远程电脑中添加电脑，即可查看它的额度与用量。", "Add a remote computer to view its quota and usage."))
                    }
                }.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 24)
            }.id(tab + (usage.computer?.address ?? ""))
        }
        .settingsPage(title: "额度与用量", onBack: onClose)
        .coordinateSpace(name: "usage-page")
        .onPreferenceChange(UsageComputerAnchorKey.self) { computerAnchor = $0 }
        .onAppear(perform: start)
        .onDisappear { computerMenu = false; usage.stop() }
        .onReceive(usage.$data, perform: reconcileFilters)
        .onChange(of: usage.detail) { _ in detailsExpanded = false }
        .onChange(of: phase) { value in if value == .active { start() } else { computerMenu = false; usage.stop() } }
        .overlay { computerMenuPanel }
        .choiceDropdownHost($choice)
    }
    private func start() {
        usage.chinese = app.usesChinese
        let address = usage.computer?.address ?? (initialAddress.isEmpty ? app.current?.address ?? "" : initialAddress)
        usage.select(paired.first { $0.address == address } ?? paired.first, store: app.store)
    }
    private func reconcileFilters(_ data: AccountUsage?) {
        guard let data else { return }
        if range == "month" && !data.hasRange("month") { range = "7" }
        if !account.isEmpty && !data.accounts(source: source).contains(where: { $0.text("id") == account }) {
            account = ""
        }
        if !model.isEmpty && !data.rows(range: range, source: source, account: account).contains(where: { $0.text("model") == model }) {
            model = ""
        }
    }
    private var tabs: some View {
        HStack(spacing: 0) {
            tabButton("quota", t("额度与余额", "Quota & balances"))
            tabButton("usage", t("使用统计", "Usage history"))
        }.fixedSize(horizontal: false, vertical: true).padding(4).background(RoundedRectangle(cornerRadius: Palette.settingsCardRadius).fill(Palette.progressTrack))
    }
    private func tabButton(_ id: String, _ title: String) -> some View {
        Button { tab = id } label: {
            Text(title).font(.system(size: Palette.textBody, weight: tab == id ? .semibold : .regular))
                .foregroundColor(tab == id ? Palette.ink : Palette.secondary)
                .padding(.horizontal, 6).padding(.vertical, 8)
                .frame(maxWidth: .infinity, minHeight: 44, maxHeight: .infinity)
                .background(RoundedRectangle(cornerRadius: Palette.settingsControlRadius).fill(tab == id ? Palette.card : Color.clear))
        }.buttonStyle(.plain).accessibilityAddTraits(tab == id ? .isSelected : [])
    }
    private var status: String {
        if usage.loading { return t("正在读取…", "Loading…") }
        guard let data = usage.data else { return usage.noticeTitle.isEmpty ? t("等待连接", "Waiting to connect") : t("暂未同步", "Not synced") }
        if usage.cached { return t("上次数据 · ", "Cached · ") + date(data.json.text("updatedAt")) }
        return t("更新于 ", "Updated ") + date(data.json.text("updatedAt")) + (data.json.bool("refreshing") ? t(" · 刷新中", " · Refreshing") : "")
    }
    private func usageCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0, content: content)
            .background(RoundedRectangle(cornerRadius: Palette.settingsCardRadius).fill(Palette.card))
            .clipShape(RoundedRectangle(cornerRadius: Palette.settingsCardRadius))
            .overlay(RoundedRectangle(cornerRadius: Palette.settingsCardRadius).strokeBorder(Palette.cardBorder, lineWidth: 1))
            .padding(.bottom, 10)
    }
    private var noticeCard: some View {
        usageCard {
            VStack(alignment: .leading, spacing: 8) {
                if !usage.noticeTitle.isEmpty { Text(usage.noticeTitle).font(.system(size: Palette.textRowStrong, weight: .medium)).foregroundColor(Palette.ink) }
                note(usage.notice)
                if !usage.detail.isEmpty {
                    Button(detailsExpanded ? t("收起详情", "Hide details") : t("查看详情", "View details")) { detailsExpanded.toggle() }
                        .font(.system(size: Palette.textNote)).foregroundColor(Palette.accent).frame(minHeight: 44).buttonStyle(.plain)
                    if detailsExpanded { note(usage.detail).textSelection(.enabled).padding(10).frame(maxWidth: .infinity, alignment: .leading).background(Palette.field).cornerRadius(Palette.settingsControlRadius) }
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
        }
    }
    private var filters: some View {
        VStack(spacing: 0) {
            if tab == "quota" {
                textControl(sourceName, expanded: choice?.anchor == "类型", action: chooseSource).frame(maxWidth: .infinity, alignment: .leading).choiceDropdownAnchor("类型")
            } else {
                HStack(spacing: 8) {
                    textControl(rangeName, expanded: choice?.anchor == "时间") {
                        select("时间", rangeIds, rangeLabels, range) { range = $0; model = "" }
                    }.choiceDropdownAnchor("时间")
                    textControl(t("筛选", "Filters") + (activeFilters == 0 ? "" : " · \(activeFilters)"), expanded: filtersExpanded, highlighted: filtersExpanded || activeFilters > 0) { filtersExpanded.toggle() }
                        .accessibilityIdentifier("usageFiltersToggle")
                        .accessibilityValue(filtersExpanded ? t("已展开", "Expanded") : t("已收起", "Collapsed"))
                }
                if filtersExpanded { expandedFilters }
            }
        }.padding(.bottom, 8)
    }
    private var sourceName: String { source == "api" ? "API" : source == "subscription" ? t("订阅", "Subscriptions") : t("全部类型", "All types") }
    private var activeFilters: Int { (source.isEmpty ? 0 : 1) + (account.isEmpty ? 0 : 1) + (model.isEmpty ? 0 : 1) }
    private var rangeIds: [String] {
        usage.data?.hasRange("month") == true ? ["1", "7", "30", "month", "all"] : ["1", "7", "30", "all"]
    }
    private var rangeLabels: [String] {
        usage.data?.hasRange("month") == true
            ? [t("今天", "Today"), t("最近 7 天", "Last 7 days"), t("最近 30 天", "Last 30 days"), t("本月", "This month"), t("全部", "Total")]
            : [t("今天", "Today"), t("最近 7 天", "Last 7 days"), t("最近 30 天", "Last 30 days"), t("全部", "Total")]
    }
    private func chooseSource() {
        select("类型", ["", "subscription", "api"], [t("全部类型", "All types"), t("订阅", "Subscriptions"), "API"], source) { source = $0; account = ""; model = "" }
    }
    private func textControl(_ title: String, expanded: Bool = false, highlighted: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Text(title).font(.system(size: Palette.textBody, weight: .medium)).foregroundColor(Palette.ink).lineLimit(1)
                Spacer(minLength: 0)
                MobileLineIcon(name: "down", size: 14).rotationEffect(.degrees(expanded ? 180 : 0)).foregroundColor(Palette.secondary)
            }.padding(.horizontal, 12).padding(.vertical, 8).frame(maxWidth: .infinity, minHeight: 44)
                .background(RoundedRectangle(cornerRadius: Palette.settingsControlRadius).fill(highlighted ? Palette.controlFill : Palette.card))
                .overlay(RoundedRectangle(cornerRadius: Palette.settingsControlRadius).strokeBorder(highlighted ? Palette.selectedBorder : Palette.cardBorder, lineWidth: 1))
                .contentShape(RoundedRectangle(cornerRadius: Palette.settingsControlRadius))
        }.buttonStyle(.plain)
    }
    private var expandedFilters: some View {
        usageCard {
            filterRow("类型", sourceName, action: chooseSource)
                SettingsDivider()
                filterRow("账号 / Key", accounts.first { $0.text("id") == account }.map(accountName) ?? t("全部账号", "All accounts")) {
                    select("账号 / Key", [""] + accounts.map { $0.text("id") }, [t("全部账号", "All accounts")] + accounts.map(accountName), account) { account = $0; model = "" }
                }
                SettingsDivider()
                filterRow("模型", model.isEmpty ? t("全部模型", "All models") : model) {
                    let models = Array(Set((usage.data?.rows(range: range, source: source, account: account) ?? []).map { $0.text("model") }.filter { !$0.isEmpty })).sorted()
                    select("模型", [""] + models, [t("全部模型", "All models")] + models, model) { model = $0 }
                }
        }
    }
    private var rangeName: String {
        switch range { case "1": return t("今天", "Today"); case "30": return t("最近 30 天", "Last 30 days"); case "month": return t("本月", "This month"); case "all": return t("全部", "Total"); default: return t("最近 7 天", "Last 7 days") }
    }
    private func filterRow(_ title: String, _ value: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(LocalizedStringKey(title)).foregroundColor(Palette.secondary)
                Spacer(minLength: 12)
                Text(value).foregroundColor(Palette.ink).lineLimit(2).multilineTextAlignment(.trailing)
                MobileLineIcon(name: "down", size: 14).rotationEffect(.degrees(choice?.anchor == title ? 180 : 0)).foregroundColor(Palette.secondary)
            }.font(.system(size: Palette.textBody)).padding(.horizontal, 14).padding(.vertical, 8).frame(minHeight: 48).contentShape(Rectangle())
        }.buttonStyle(.plain).choiceDropdownAnchor(title)
    }
    private func select(_ title: String, _ ids: [String], _ labels: [String], _ selected: String, action: @escaping (String) -> Void) {
        computerMenu = false
        choice = ChoiceDropdownRequest(anchor: title, title: title, labels: labels, selected: ids.firstIndex(of: selected) ?? 0,
            searchable: title == "模型" || title == "账号 / Key", choose: { index in action(ids[index]) })
    }
    private func chooseComputer() {
        guard !paired.isEmpty else { return }
        choice = nil; computerMenu.toggle()
    }
    @ViewBuilder private var computerMenuPanel: some View {
        if computerMenu, let anchor = computerAnchor {
            GeometryReader { geometry in
                let width = min(264, max(1, geometry.size.width - 24))
                let left = max(12, min(anchor.maxX - width, geometry.size.width - width - 12))
                let top = anchor.maxY + 8
                ZStack(alignment: .topLeading) {
                    PopupDismissArea { computerMenu = false }
                    ComputerPickerPopupView(maxHeight: max(1, min(520, geometry.size.height - top - 8)), onAction: { action in
                        computerMenu = false
                        if case .open(let computer) = action, computer.address != usage.computer?.address {
                            account = ""; model = ""; usage.select(computer, store: app.store)
                        }
                    }, computers: paired, selectedAddress: usage.computer?.address, selectionOnly: true)
                        .environmentObject(app)
                        .frame(width: width)
                        .padding(.leading, left).padding(.top, top)
                        .accessibilityIdentifier("usageComputerMenu")
                }
            }
        }
    }
    private var quota: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(["subscription", "api"], id: \.self) { source in
                let matches = accounts.filter { $0.text("source") == source && !$0.bool("archived") }
                if !matches.isEmpty {
                    SettingsGroupLabel(title: source == "api" ? "API" : "订阅")
                    ForEach(matches, id: \.textID) { account in quotaCard(account) }
                }
            }
            if accounts.filter({ !$0.bool("archived") }).isEmpty { SettingsNote(text: t("这台电脑尚无相关账号。", "No matching accounts on this computer.")) }
            SettingsNote(text: t("额度由服务商提供，可能与其他设备共享。不同账号、Key 和币种的余额不合计。", "Provider quotas may be shared across devices. Balances are not summed across accounts, keys or currencies."))
        }
    }
    private func quotaCard(_ account: JSONObject) -> some View {
        usageCard {
            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(account.text("provider")).font(.system(size: Palette.textRowStrong, weight: .medium))
                    note(account.text("label"))
                }
                if !account.bool("enabled", fallback: true) { note(t("未启用或未登录", "Disabled or signed out")) }
                ForEach(Array(account.objects("balances").enumerated()), id: \.offset) { _, balance in
                    Text(balance.isNull("value") ? balance.text("currency") + " · " + t("余额未知", "Balance unavailable") : number(balance.double("value")) + " " + balance.text("currency"))
                        .font(.system(size: balance.isNull("value") ? Palette.textBody : Palette.textTitle, weight: .medium)).monospacedDigit()
                }
                ForEach(Array(account.objects("windows").enumerated()), id: \.offset) { _, window in quotaWindow(window) }
                if account.objects("balances").isEmpty && account.objects("windows").isEmpty {
                    note(account.bool("supported") ? t("尚未查询到额度，点击刷新。", "No reading yet. Tap Refresh.") : t("暂不支持查询额度", "Quota queries are not supported"))
                }
                if !account.isNull("updatedAt") { note(t("更新于 ", "Updated ") + date(account.text("updatedAt"))) }
                if account.bool("failed") || account.bool("stale") { note(t("数据可能过期；请稍后刷新。", "Reading may be stale. Refresh again later.")).foregroundColor(Palette.error) }
            }.foregroundColor(Palette.ink).frame(maxWidth: .infinity, alignment: .leading).padding(16)
        }
    }
    private func quotaWindow(_ window: JSONObject) -> some View {
        let remaining = max(0, min(100, 100 - window.double("usedPercent")))
        let value = !window.isNull("usedPercent") ? number(remaining) + t("% 剩余", "% remaining") : !window.isNull("remainingValue") ? number(window.double("remainingValue")) + " " + window.text("unit") : t("暂不可用", "Unavailable")
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(window.text("label")).foregroundColor(Palette.secondary)
                Spacer(minLength: 8)
                Text(value).monospacedDigit()
            }.font(.system(size: Palette.textBody))
            if !window.isNull("usedPercent") { ProgressView(value: remaining, total: 100).progressViewStyle(SettingsProgressStyle()).accessibilityLabel(window.text("label")) }
            if !window.isNull("resetsAt") { note(t("重置于 ", "Resets ") + date(window.text("resetsAt"))) }
        }
    }
    private var history: some View {
        VStack(alignment: .leading, spacing: 0) {
            usageCard {
                VStack(alignment: .leading, spacing: 10) {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), alignment: .leading), count: 2), alignment: .leading, spacing: 12) {
                        stat(t("Token 总量", "Total tokens"), ["inputTokens", "outputTokens"])
                        stat(t("成功请求 / 轮次", "Successful requests / turns"), ["requests"])
                        stat(t("输入 Token", "Input tokens"), ["inputTokens"])
                        stat(t("输出 Token", "Output tokens"), ["outputTokens"])
                    }
                }.padding(16)
            }
            if AccountUsage.sum(rows, ["unreported"]) > 0 { SettingsNote(text: t("部分请求未完整上报 Token，用量合计可能偏低。", "Some requests did not report complete token usage. Totals may be low.")) }
            if usage.data?.json.bool("usageFailed") == true { SettingsNote(text: t("电脑端订阅统计保存异常，请检查电脑端。", "Subscription usage could not be saved. Check the desktop.")) }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in historyCard(row) }
            if rows.isEmpty { SettingsNote(text: t("此时间范围没有相关记录。", "No matching usage in this period.")) }
            SettingsNote(text: t("仅统计这台电脑记录的调用，日期按电脑时区计算。订阅金额按标准 API 价格折算，不是实际账单。", "Only calls recorded on this computer are included; dates use its time zone. Subscription amounts are standard API equivalents, not bills."))
        }
    }
    private func stat(_ title: String, _ fields: [String]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: Palette.textSmall)).foregroundColor(Palette.secondary)
            Text(count(AccountUsage.sum(rows, fields))).font(.system(size: Palette.textRowStrong)).foregroundColor(Palette.ink).monospacedDigit()
                .accessibilityLabel(title + ": " + number(AccountUsage.sum(rows, fields)))
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func historyCard(_ row: JSONObject) -> some View {
        let account = accounts.first { $0.text("id") == row.text("accountId") }
        return usageCard {
            VStack(alignment: .leading, spacing: 6) {
                Text(row.text("model").isEmpty ? t("历史合计（未按模型归类）", "Legacy totals (model unknown)") : row.text("model")).font(.system(size: Palette.textRowStrong, weight: .medium)).foregroundColor(Palette.ink)
                if let account { note(accountName(account)) }
                usageLine(t("输入 ", "Input "), row.double("inputTokens"), t("输出 ", "Output "), row.double("outputTokens"))
                usageLine(t("缓存读取 ", "Cache read "), row.double("cacheReadTokens"), t("写入 ", "Write "), row.double("cacheWriteTokens"))
                usageLine(t("成功 ", "Success "), row.double("requests"), t("失败/取消 ", "Failed/canceled "), AccountUsage.sum([row], ["failures", "cancelled"]))
                if account?.text("source") == "subscription" {
                    if row.double("pricedTokens") > 0 { note(t("API 等价估值 ", "API equivalent ") + String(format: "$%.4f", row.double("estimatedCostUsd"))) }
                    if row.double("unpricedTokens") > 0 { note(t("部分 Token 尚未定价", "Some tokens are unpriced")) }
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
        }
    }
    private func accountName(_ account: JSONObject) -> String {
        account.text("provider") + " · " + account.text("label") + (account.bool("archived") ? t(" · 历史 Key", " · Previous key") : "")
    }
    private func note(_ value: String) -> some View { Text(value).font(.system(size: Palette.textNote)).foregroundColor(Palette.secondary).fixedSize(horizontal: false, vertical: true) }
    private func usageLine(_ firstTitle: String, _ first: Double, _ secondTitle: String, _ second: Double) -> some View {
        note(firstTitle + count(first) + " · " + secondTitle + count(second))
            .accessibilityLabel(firstTitle + number(first) + " · " + secondTitle + number(second))
    }
    private func count(_ value: Double) -> String {
        value.formatted(.number.locale(Locale(identifier: app.usesChinese ? "zh_CN" : "en_US"))
            .notation(.compactName).precision(.fractionLength(0...1)))
    }
    private func number(_ value: Double) -> String {
        let formatter = NumberFormatter(); formatter.numberStyle = .decimal; formatter.maximumFractionDigits = 2
        formatter.locale = Locale(identifier: app.usesChinese ? "zh_CN" : "en_US")
        return formatter.string(from: NSNumber(value: value)) ?? "0"
    }
    private func date(_ value: String) -> String {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var parsed = parser.date(from: value)
        if parsed == nil { parser.formatOptions = [.withInternetDateTime]; parsed = parser.date(from: value) }
        guard let parsed else { return t("未知", "Unknown") }
        let formatter = DateFormatter(); formatter.dateFormat = "MM-dd HH:mm"; return formatter.string(from: parsed)
    }
}

private extension JSONObject { var textID: String { text("id") } }

private struct UsageComputerAnchorKey: PreferenceKey {
    static var defaultValue: CGRect? = nil
    static func reduce(value: inout CGRect?, nextValue: () -> CGRect?) { value = nextValue() ?? value }
}
