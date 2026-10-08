import SwiftUI

/// The node state as `bridge.go` serialises it.
///
/// `EmbeddedNetwork.Status` carries the two fields the client acts on; the rest
/// is the diagnostics the bridge adds for exactly this app. Decoding them here
/// keeps the shipping type free of fields only a test build reads.
struct NodeStatus: Decodable {
    var state = "—"
    var loginUrl = ""
    var tailnetIPs: [String] = []
    var hostName = ""
    var tailnet = ""
    var online = false

    private enum CodingKeys: String, CodingKey {
        case state, loginUrl, tailnetIPs, hostName, tailnet, online
    }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decodeIfPresent(String.self, forKey: .state) ?? "—"
        loginUrl = try container.decodeIfPresent(String.self, forKey: .loginUrl) ?? ""
        tailnetIPs = try container.decodeIfPresent([String].self, forKey: .tailnetIPs) ?? []
        hostName = try container.decodeIfPresent(String.self, forKey: .hostName) ?? ""
        tailnet = try container.decodeIfPresent(String.self, forKey: .tailnet) ?? ""
        online = try container.decodeIfPresent(Bool.self, forKey: .online) ?? false
    }
}

/// The node's work, off the main queue.
///
/// Starting a node and reading its status both block — the status call waits on
/// the local API with a five second ceiling — so none of it runs on the queue
/// that draws the screen.
enum NodeActions {
    static func start() async -> Result<Double, Error> {
        let began = Date()
        do {
            try await Task.detached(priority: .userInitiated) {
                _ = try EmbeddedNetwork.shared.currentNode()
            }.value
            let seconds = Date().timeIntervalSince(began)
            // Reported here rather than by the caller, so the line is written
            // once no matter which screen brought the node up.
            DiagnosticsLog.shared.note(String(format: "node started in %.2fs", seconds), .good)
            return .success(seconds)
        } catch {
            DiagnosticsLog.shared.note("node failed to start: \(FailureText.describe(error))", .bad)
            return .failure(error)
        }
    }

    static func readStatus() async -> Result<NodeStatus, Error> {
        do {
            let text = try await Task.detached(priority: .userInitiated) { () -> String in
                let node = try EmbeddedNetwork.shared.currentNode()
                var failure: NSError?
                let text = node.status(&failure)
                if let failure { throw failure }
                return text
            }.value
            return .success(try JSONDecoder().decode(NodeStatus.self, from: Data(text.utf8)))
        } catch {
            return .failure(error)
        }
    }

    static func requestLogin() async -> Result<Void, Error> {
        await run { try EmbeddedNetwork.shared.login() }
    }

    static func forget() async -> Result<Void, Error> {
        await run { try EmbeddedNetwork.shared.forget() }
    }

    /// Enumerates the interfaces the way `SetInterfaces` would receive them.
    ///
    /// Worth doing on a device even when the node starts fine: it is the same
    /// call the injection path uses, and it answers whether the iOS sandbox
    /// permits `getifaddrs` for the addresses tsnet cares about.
    static func sampleInterfaces() async -> Result<[String], Error> {
        do {
            let json = try await Task.detached(priority: .userInitiated) {
                try InterfaceSnapshot().encode()
            }.value
            let parsed = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]] ?? []
            return .success(parsed.map { entry in
                let name = entry["Name"] as? String ?? "?"
                let addresses = entry["Addresses"] as? [String] ?? []
                return "\(name)  \(addresses.isEmpty ? "—" : addresses.joined(separator: ", "))"
            })
        } catch {
            return .failure(error)
        }
    }

    private static func run(_ work: @escaping () throws -> Void) async -> Result<Void, Error> {
        do {
            try await Task.detached(priority: .userInitiated, operation: work).value
            return .success(())
        } catch {
            return .failure(error)
        }
    }
}

@MainActor
final class NetworkModel: ObservableObject {
    @Published var status = NodeStatus()
    @Published var failure: String?
    @Published var starting = false
    @Published var interfaces: [String] = []
    @Published var injectsInterfaces = EmbeddedNetwork.shared.injectsInterfaces

    private var polling = false

    var stateLabel: String {
        NodeState(raw: status.state).label()
    }

    var stateTint: Color {
        switch NodeState(raw: status.state) {
        case .running: return .green
        case .needsLogin, .needsMachineAuth: return .orange
        case .starting: return .blue
        default: return .gray
        }
    }

    /// Which backend the node state landed in. Worth stating plainly: it is the
    /// one thing this build may do differently from a shipping one.
    var storage: String {
        AppStores.nodeStateOnFile ? "文件（无 entitlement）" : "Keychain"
    }

    func refresh() {
        Task { @MainActor in await refreshNow() }
    }

    private func refreshNow() async {
        switch await NodeActions.readStatus() {
        case .success(let value):
            // Recorded because reading the status is also what starts the node
            // the first time, so without this the log would show a tunnel
            // appearing from nowhere.
            if value.state != status.state {
                DiagnosticsLog.shared.note(
                    "node state: \(status.state) -> \(value.state)", value.state == "Running" ? .good : .plain)
            }
            status = value
            failure = nil
        case .failure(let error):
            failure = FailureText.describe(error)
        }
    }

    func startNode() {
        guard !starting else { return }
        starting = true
        failure = nil
        Task { @MainActor in
            let outcome = await NodeActions.start()
            starting = false
            switch outcome {
            case .success:
                await refreshNow()
            case .failure(let error):
                failure = FailureText.describe(error)
            }
        }
    }

    func signIn() {
        Task { @MainActor in
            switch await NodeActions.requestLogin() {
            case .success:
                DiagnosticsLog.shared.note("sign-in requested")
                pollForSignIn()
            case .failure(let error):
                let described = FailureText.describe(error)
                failure = described
                DiagnosticsLog.shared.note("sign-in request failed: \(described)", .bad)
            }
        }
    }

    /// The node does not learn that the sign-in landed until it is asked, so it
    /// is asked until it says so or the window closes.
    private func pollForSignIn() {
        guard !polling else { return }
        polling = true
        Task { @MainActor in
            let deadline = Date().addingTimeInterval(300)
            defer { polling = false }
            while Date() < deadline {
                await refreshNow()
                if status.state == "Running" {
                    DiagnosticsLog.shared.note("sign-in completed, the node is running", .good)
                    return
                }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
            DiagnosticsLog.shared.note("the sign-in window closed without the node running")
        }
    }

    func forget() {
        Task { @MainActor in
            switch await NodeActions.forget() {
            case .success:
                status = NodeStatus()
                failure = nil
                DiagnosticsLog.shared.note("the stored node identity was discarded", .good)
            case .failure(let error):
                let described = FailureText.describe(error)
                failure = described
                DiagnosticsLog.shared.note("could not discard the node identity: \(described)", .bad)
            }
        }
    }

    func sampleInterfaces() {
        Task { @MainActor in
            switch await NodeActions.sampleInterfaces() {
            case .success(let list):
                interfaces = list
                DiagnosticsLog.shared.note("enumerated \(list.count) interfaces", .good)
            case .failure(let error):
                DiagnosticsLog.shared.note("interface enumeration failed: \(FailureText.describe(error))", .bad)
            }
        }
    }

    func setInjection(_ on: Bool) {
        injectsInterfaces = on
        EmbeddedNetwork.shared.injectsInterfaces = on
        DiagnosticsLog.shared.note("interface injection \(on ? "enabled" : "disabled"), effective at the next launch")
    }
}

struct NetworkSection: View {
    @StateObject private var model = NetworkModel()

    var body: some View {
        // NavigationView, matching the other two tabs: this screen never pushes,
        // and NavigationStack would raise the minimum to iOS 16.
        NavigationView {
            ScrollView {
                VStack(spacing: 14) {
                    statusCard
                    loginCard
                    interfacesCard
                    implementationCard
                }
                .padding(14)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("内置网络")
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear { model.refresh() }
    }

    private var statusCard: some View {
        SectionCard(title: "节点") {
            HStack(spacing: 10) {
                StatusPill(text: model.stateLabel, tint: model.stateTint)
                if model.starting {
                    ProgressView().controlSize(.small)
                    Text("启动中…").font(.footnote).foregroundColor(.secondary)
                }
                Spacer()
            }
            DetailRow(label: "主机名", value: model.status.hostName, monospaced: true)
            DetailRow(label: "网络", value: model.status.tailnet, monospaced: true)
            DetailRow(label: "地址", value: model.status.tailnetIPs.joined(separator: ", "), monospaced: true)
            DetailRow(label: "在线", value: model.status.online ? "是" : "否")
            if let failure = model.failure {
                Text(failure)
                    .font(.footnote)
                    .foregroundColor(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 10) {
                Button("刷新") { model.refresh() }
                Button("启动") { model.startNode() }
                Spacer()
                Button("忘记节点", role: .destructive) { model.forget() }
            }
            .buttonStyle(.bordered)
            .font(.subheadline)
        }
    }

    private var loginCard: some View {
        SectionCard(title: "登录") {
            if let url = EmbeddedNetwork.loginURL(model.status.loginUrl) {
                Text(url.absoluteString)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("打开授权页") { LoginPresenter.shared.present(url) }
                    .buttonStyle(.borderedProminent)
            } else if model.status.loginUrl.isEmpty {
                Text("节点还没有给出登录链接。先启动节点，再请求登录。")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            } else {
                // The link is validated before it is ever opened, so a rejected
                // one is reported rather than followed.
                Text("登录链接未通过校验：\(model.status.loginUrl)")
                    .font(.footnote)
                    .foregroundColor(.red)
            }
            Button("请求登录") { model.signIn() }
                .buttonStyle(.bordered)
        }
    }

    private var interfacesCard: some View {
        SectionCard(title: "接口快照") {
            Button("枚举接口") { model.sampleInterfaces() }
                .buttonStyle(.bordered)
            if !model.interfaces.isEmpty {
                Text("\(model.interfaces.count) 个接口")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                CodeBlock(text: model.interfaces.joined(separator: "\n"))
            }
            Toggle("启动时强制注入", isOn: Binding(
                get: { model.injectsInterfaces },
                set: { model.setInjection($0) }
            ))
            .font(.subheadline)
            Text("iOS 上预计不必注入，默认走系统发现。改动要重启 App 才生效。")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    private var implementationCard: some View {
        SectionCard(title: "本机构建") {
            DetailRow(label: "状态存储", value: model.storage)
            DetailRow(label: "网络实现", value: "内置 tsnet（tailnet.xcframework）")
            DetailRow(label: "版本", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—")
        }
    }
}
