import SwiftUI

/// One request and what came back.
struct GatewayAnswer: Identifiable {
    let id = UUID()
    let title: String
    let status: Int
    let contentType: String
    let byteCount: Int
    let body: String
    let note: String
    let failed: Bool
}

@MainActor
final class GatewayModel: ObservableObject {
    private static let addressKey = "diagnostics.gateway.address"
    private static let tokenKey = "diagnostics.gateway.token"

    /// Both are kept between launches so a 43-character token does not have to
    /// be retyped for every run. That is a deliberate trade for a diagnostic
    /// build: the shipping client keeps the token in the Keychain, and
    /// `UserDefaults` is the wrong place for it anywhere else.
    @Published var address: String = "" { didSet { UserDefaults.standard.set(address, forKey: Self.addressKey) } }
    @Published var token: String = "" { didSet { UserDefaults.standard.set(token, forKey: Self.tokenKey) } }

    @Published var path = GatewayClient.paths[0]
    @Published var answers: [GatewayAnswer] = []
    @Published var busy = false

    init() {
        address = UserDefaults.standard.string(forKey: Self.addressKey) ?? ""
        token = UserDefaults.standard.string(forKey: Self.tokenKey) ?? ""
    }

    func send() {
        guard !busy, let endpoint = validated() else { return }
        busy = true
        let chosen = path
        let secret = token
        Task { @MainActor in
            let outcome: Result<GatewayClient.Answer, Error>
            do {
                outcome = .success(try await Task.detached(priority: .userInitiated) {
                    try GatewayClient.fetch(endpoint: endpoint, path: chosen, token: secret)
                }.value)
            } catch {
                outcome = .failure(error)
            }
            busy = false
            record(outcome, title: "GET \(chosen)")
        }
    }

    func sampleStream() {
        guard !busy, let endpoint = validated() else { return }
        busy = true
        let secret = token
        Task { @MainActor in
            let outcome: Result<GatewayClient.Answer, Error>
            do {
                outcome = .success(try await Task.detached(priority: .userInitiated) {
                    try GatewayClient.sampleStream(
                        endpoint: endpoint, path: GatewayClient.streamPath, token: secret, seconds: 3)
                }.value)
            } catch {
                outcome = .failure(error)
            }
            busy = false
            record(outcome, title: "STREAM \(GatewayClient.streamPath)")
        }
    }

    /// The address is validated with the shipping rule before anything is
    /// dialled, so a typo is reported as a rejected address rather than as a
    /// timeout that looks like a network fault.
    private func validated() -> Endpoint? {
        do {
            return try Endpoint(address)
        } catch {
            let described = (error as? EndpointError)?.description ?? error.localizedDescription
            answers.insert(GatewayAnswer(
                title: "地址校验", status: 0, contentType: "", byteCount: 0,
                body: described, note: "未发出请求", failed: true), at: 0)
            DiagnosticsLog.shared.note("address rejected: \(described)", .bad)
            return nil
        }
    }

    private func record(_ outcome: Result<GatewayClient.Answer, Error>, title: String) {
        switch outcome {
        case .success(let answer):
            answers.insert(GatewayAnswer(
                title: title, status: answer.status, contentType: answer.contentType,
                byteCount: answer.byteCount, body: answer.body, note: answer.note, failed: false), at: 0)
            DiagnosticsLog.shared.note(
                "\(title) -> HTTP \(answer.status), \(answer.byteCount) bytes", answer.status == 200 ? .good : .bad)
        case .failure(let error):
            let described = FailureText.describe(error)
            answers.insert(GatewayAnswer(
                title: title, status: 0, contentType: "", byteCount: 0,
                body: described, note: "请求未完成", failed: true), at: 0)
            DiagnosticsLog.shared.note("\(title) failed: \(described)", .bad)
        }
        if answers.count > 20 { answers.removeLast(answers.count - 20) }
    }
}

struct GatewaySection: View {
    @StateObject private var model = GatewayModel()

    var body: some View {
        // NavigationView rather than NavigationStack: this screen never pushes,
        // it only needs a navigation bar for the title, and NavigationStack
        // would raise the floor of the whole app to iOS 16.
        NavigationView {
            ScrollView {
                VStack(spacing: 14) {
                    targetCard
                    if model.answers.isEmpty {
                        SectionCard(title: "结果") {
                            Text("还没有请求。")
                                .font(.footnote)
                                .foregroundColor(.secondary)
                        }
                    }
                    ForEach(model.answers) { answer in
                        resultCard(answer)
                    }
                }
                .padding(14)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("网关探测")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var targetCard: some View {
        SectionCard(title: "目标") {
            TextField("http://100.x.x.x:43127", text: $model.address)
                .textFieldStyle(.roundedBorder)
                .font(.system(.subheadline, design: .monospaced))
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
            SecureField("设备令牌（可留空，先只验隧道）", text: $model.token)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            Picker("路径", selection: $model.path) {
                ForEach(GatewayClient.paths, id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(.menu)
            HStack(spacing: 10) {
                Button("发送") { model.send() }
                    .buttonStyle(.borderedProminent)
                Button("读事件流 3 秒") { model.sampleStream() }
                    .buttonStyle(.bordered)
                if model.busy { ProgressView().controlSize(.small) }
            }
            .font(.subheadline)
            Text("地址须是 100.64.0.0/10 内的字面量且带显式端口，路径限于客户端白名单。留空令牌也能验证隧道是否通（会得到 401）。")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    private func resultCard(_ answer: GatewayAnswer) -> some View {
        SectionCard(title: answer.title) {
            HStack(spacing: 10) {
                StatusPill(
                    text: answer.failed ? "未完成" : "HTTP \(answer.status)",
                    tint: answer.failed ? .red : (answer.status == 200 ? .green : .orange))
                if answer.byteCount > 0 {
                    Text("\(answer.byteCount) 字节")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
                Spacer()
            }
            if !answer.contentType.isEmpty {
                DetailRow(label: "类型", value: answer.contentType, monospaced: true)
            }
            if !answer.note.isEmpty {
                DetailRow(label: "读取", value: answer.note)
            }
            CodeBlock(text: answer.body.isEmpty ? "（空响应体）" : answer.body)
        }
    }
}
