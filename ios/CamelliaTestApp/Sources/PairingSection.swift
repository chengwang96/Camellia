import SwiftUI

/// Drives a real pairing against a computer, and keeps the list of them.
///
/// This screen exists so the pairing calls can be exercised on a device before
/// the client's own UI is written: it uses the same `PairingController`, the
/// same vault and the same transport the client will, so a pairing that
/// succeeds here succeeds for the same reasons there.
@MainActor
final class PairingModel: ObservableObject {
    @Published var address = ""
    @Published var port = PairingDraft.defaultPort
    @Published var code = ""
    @Published var name = ""

    @Published var phase: PairingController.Phase = .idle
    @Published var detail = ""
    @Published var computers: [PairedComputer] = []
    @Published var storageNote = ""
    /// Whether a request is stored and still waiting for the desktop.
    @Published var hasPending = false

    /// The scanner is owned here rather than created per sheet, so the session
    /// survives a dismissal and the camera is not reconfigured on every scan.
    let scanner = QRCodeScanner()

    private let store: ComputerStore
    private let transport = RemotePairingTransport()
    private var controller: PairingController?

    init() {
        store = ComputerStore(vault: AppStores.credentialVault)
        name = MobilePreferences(store: UserDefaultsPreferenceStore()).deviceName
        storageNote = AppStores.credentialsOnFile
            ? "凭据密钥存放在文件（此签名方式无 Keychain 权限）"
            : "凭据密钥存放在 Keychain（仅本设备、不进备份）"
        reload()
    }

    /// Reads what is stored, including a request that was left waiting.
    func reload() {
        do {
            computers = try store.all()
            let current = try store.current()
            hasPending = current.isAwaitingApproval
            if hasPending, address.isEmpty {
                address = current.endpoint?.host ?? ""
                port = current.endpoint.map { String($0.port) } ?? PairingDraft.defaultPort
                name = current.name
                detail = "已保存一个等待电脑确认的请求，可继续等待。"
            }
            if let paired = computers.first(where: { $0.isPaired }), address.isEmpty {
                address = paired.endpoint?.host ?? ""
                port = paired.endpoint.map { String($0.port) } ?? PairingDraft.defaultPort
            }
            DiagnosticsLog.shared.note("pairing: \(computers.count) computer(s) stored")
        } catch {
            detail = FailureText.describe(error)
            DiagnosticsLog.shared.note("pairing: stored credentials unreadable: \(detail)", .bad)
        }
    }

    /// Sends the request and starts waiting for the desktop.
    func start() {
        let draft = PairingDraft(address: address, port: port, code: code, name: name)
        let endpoint: Endpoint
        do {
            endpoint = try PairingController.validate(draft)
        } catch {
            report(error)
            return
        }
        let controller = makeController()
        self.controller = controller
        DiagnosticsLog.shared.note("pairing: requesting \(endpoint.origin)")
        do {
            try controller.start(draft)
        } catch {
            report(error)
        }
    }

    /// Picks up a request that is already stored and waiting.
    func resume() {
        let controller = makeController()
        self.controller = controller
        do {
            try controller.resume()
            DiagnosticsLog.shared.note("pairing: resuming the stored request")
        } catch {
            report(error)
        }
    }

    func cancel() {
        controller?.cancel()
        controller = nil
    }

    func remove(_ computer: PairedComputer) {
        do {
            try store.remove(computer.address)
            reload()
            phase = .idle
            detail = "已删除 \(computer.displayName)"
        } catch {
            report(error)
        }
    }

    func select(_ computer: PairedComputer) {
        do {
            try store.select(computer.address)
            reload()
            detail = "已切换到 \(computer.displayName)"
        } catch {
            report(error)
        }
    }

    /// Fills the form from a QR code, refilling the address from the payload.
    func apply(payload: PairingPayload) {
        let draft = PairingDraft(payload: payload, name: name)
        address = draft.address.isEmpty ? address : draft.address
        port = draft.port
        code = draft.code
        detail = "已填入二维码中的地址与配对码。"
        DiagnosticsLog.shared.note("pairing: scanned \(payload.address)")
    }

    private func makeController() -> PairingController {
        let controller = PairingController(transport: transport, store: store)
        controller.onChange = { [weak self] phase in
            DispatchQueue.main.async { self?.publish(phase) }
        }
        return controller
    }

    private func publish(_ phase: PairingController.Phase) {
        self.phase = phase
        switch phase {
        case .idle:
            detail = ""
        case .requesting:
            detail = "正在请求配对…"
        case .awaitingApproval(let expiry):
            detail = "请求已发送，请在电脑端确认授权。" + (expiry > 0 ? "（有效期至 \(expiry)）" : "")
            DiagnosticsLog.shared.note("pairing: waiting for approval, expiry \(expiry)")
        case .approved(let computer):
            detail = "已配对 \(computer.displayName)"
            DiagnosticsLog.shared.note("pairing: approved \(computer.address)", .good)
            reload()
        case .expired:
            detail = "配对已过期，请在电脑重新生成配对码。"
            DiagnosticsLog.shared.note("pairing: expired", .bad)
            reload()
        case .failed(let message):
            detail = message
            DiagnosticsLog.shared.note("pairing: failed: \(message)", .bad)
            reload()
        }
    }

    private func report(_ error: Error) {
        detail = FailureText.describe(error)
        DiagnosticsLog.shared.note("pairing: \(detail)", .bad)
    }
}

struct PairingSection: View {
    @StateObject private var model = PairingModel()
    @State private var scanning = false
    @State private var cameraMessage = ""

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 14) {
                    formCard
                    statusCard
                    listCard
                }
                .padding(14)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("配对")
            .navigationBarTitleDisplayMode(.inline)
        }
        .sheet(isPresented: $scanning) { scannerSheet }
    }

    private var formCard: some View {
        SectionCard(title: "配对信息") {
            TextField("电脑的 Tailscale IP", text: $model.address)
                .textFieldStyle(.roundedBorder)
                .font(.system(.subheadline, design: .monospaced))
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .keyboardType(.decimalPad)
            TextField("端口", text: $model.port)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.numberPad)
            TextField("24 位一次性配对码", text: $model.code)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            TextField("本机名称", text: $model.name)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
            HStack(spacing: 10) {
                Button("扫描二维码") { openScanner() }
                    .buttonStyle(.bordered)
                Button("请求配对") { model.start() }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.phase.isBusy)
                if model.phase.isBusy { ProgressView().controlSize(.small) }
            }
            .font(.subheadline)
            if model.hasPending || model.phase == .idle {
                Button("继续等待电脑确认") { model.resume() }
                    .buttonStyle(.bordered)
                    .font(.subheadline)
            }
            if model.phase.isBusy {
                Button("停止等待") { model.cancel() }
                    .buttonStyle(.bordered)
                    .font(.subheadline)
            }
            Text("扫码或填写后发起请求，之后每 5 秒向电脑询问一次结果，直到电脑端确认或超时。请求会保存在本机，重启后可继续等待。")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    private var statusCard: some View {
        SectionCard(title: "状态") {
            HStack(spacing: 10) {
                StatusPill(text: model.phase.title, tint: model.phase.tint)
                Spacer()
            }
            if !model.detail.isEmpty {
                Text(model.detail)
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }
            Text(model.storageNote)
                .font(.caption)
                .foregroundColor(.secondary)
            if !cameraMessage.isEmpty {
                Text(cameraMessage)
                    .font(.caption)
                    .foregroundColor(.orange)
            }
        }
    }

    private var listCard: some View {
        SectionCard(title: "已保存的电脑") {
            if model.computers.isEmpty {
                Text("还没有配对的电脑。")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }
            ForEach(model.computers, id: \.address) { computer in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(computer.displayName)
                            .font(.subheadline)
                        Text(computer.address)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundColor(.secondary)
                            .textSelection(.enabled)
                    }
                    Spacer()
                    Button("切换") { model.select(computer) }
                        .font(.footnote)
                    Button("删除") { model.remove(computer) }
                        .font(.footnote)
                        .foregroundColor(.red)
                }
                Divider()
            }
        }
    }

    private var scannerSheet: some View {
        NavigationView {
            ZStack(alignment: .bottom) {
                QRCodeScannerView(scanner: model.scanner)
                    .edgesIgnoringSafeArea(.all)
                Text("把电脑上的配对二维码放入取景框。")
                    .font(.footnote)
                    .padding(10)
                    .background(.thinMaterial, in: Capsule())
                    .padding(.bottom, 24)
            }
            .navigationTitle("扫描配对码")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("取消") { closeScanner() }
                }
            }
        }
        .onAppear(perform: startScanner)
    }

    private func openScanner() {
        cameraMessage = ""
        guard QRCodeScanner.access() != .denied else {
            cameraMessage = "相机权限已被拒绝，请在系统设置中允许后重试。"
            return
        }
        QRCodeScanner.requestAccess { granted in
            guard granted else {
                cameraMessage = "没有相机权限，可手动填写配对信息。"
                return
            }
            scanning = true
        }
    }

    private func startScanner() {
        do {
            try model.scanner.configure()
            model.scanner.onCode { text in
                do {
                    model.apply(payload: try PairingPayload(text))
                    closeScanner()
                } catch {
                    cameraMessage = FailureText.describe(error)
                }
            }
            model.scanner.start()
        } catch {
            cameraMessage = FailureText.describe(error)
        }
    }

    private func closeScanner() {
        model.scanner.stop()
        scanning = false
    }
}

extension PairingController.Phase {
    var title: String {
        switch self {
        case .idle: return "未配对"
        case .requesting: return "请求中"
        case .awaitingApproval: return "等待确认"
        case .approved: return "已配对"
        case .expired: return "已过期"
        case .failed: return "失败"
        }
    }

    var tint: Color {
        switch self {
        case .idle: return .secondary
        case .requesting, .awaitingApproval: return .orange
        case .approved: return .green
        case .expired, .failed: return .red
        }
    }
}
