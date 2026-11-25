import SwiftUI
import UIKit
import WebKit

/// The transcript owns only native summary rows; a browser exists only while a card is open.
struct RemoteVisualizationCards: View {
    let cards: [RemoteVisualization]
    let chinese: Bool
    let loader: InlineImageLoader?
    @State private var selected: RemoteVisualization?

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(chinese ? "交互卡片" : "Interactive cards")
                .font(.system(size: Palette.textSmall, weight: .medium))
                .foregroundColor(Palette.muted)
            ForEach(cards) { card in
                Button { selected = card } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "diamond")
                            .font(.system(size: 18))
                            .foregroundColor(Palette.accent)
                            .frame(width: 38, height: 38)
                            .background(RoundedRectangle(cornerRadius: Palette.smallRadius).fill(Palette.background))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(card.title.isEmpty ? (chinese ? "交互卡片" : "Interactive card") : card.title)
                                .font(.system(size: Palette.textRow, weight: .medium))
                                .foregroundColor(Palette.ink)
                                .lineLimit(1)
                            if !card.summary.isEmpty {
                                Text(card.summary)
                                    .font(.system(size: Palette.textSmall))
                                    .foregroundColor(Palette.muted)
                                    .lineLimit(2)
                            }
                            Text((card.wide ? (chinese ? "宽卡片" : "Wide card") : (chinese ? "卡片" : "Card"))
                                 + " · v\(card.revision)")
                                .font(.system(size: Palette.textSmall))
                                .foregroundColor(Palette.faint)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Text(chinese ? "打开" : "Open")
                            .font(.system(size: Palette.textSmall, weight: .medium))
                            .foregroundColor(Palette.accent)
                            .frame(minHeight: 44)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: Palette.groupRadius).fill(Palette.surface))
                    .overlay(RoundedRectangle(cornerRadius: Palette.groupRadius).stroke(Palette.cardBorder, lineWidth: 1))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(loader == nil)
                .accessibilityIdentifier("visualization-card:\(card.id)")
            }
        }
        .fullScreenCover(item: $selected) { card in
            if let loader {
                RemoteVisualizationScreen(computer: loader.session.computer,
                                          conversationId: loader.conversationId, card: card, chinese: chinese)
            }
        }
    }
}

private enum VisualizationViewMode: Equatable {
    case width, whole, manual
}

private struct RemoteVisualizationScreen: View {
    let computer: PairedComputer
    let conversationId: String
    let card: RemoteVisualization
    let chinese: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var document = RemoteVisualizationDocument()
    /// Presentation hides the toolbar and lets the card draw under the status bar.
    @State private var presenting = false
    @State private var toolsOpen = false
    @State private var viewMode: VisualizationViewMode = .width
    @State private var manualZoom = 1.0
    @State private var shownZoom = 1.0
    /// The viewer owns a landscape lock only while its rotate control is active.
    @State private var landscape = false
    /// Follow the device's gravity once the user enables sensor rotation.
    @State private var followGravity = false

    var body: some View {
        VStack(spacing: 0) {
            if !presenting {
                ZStack {
                    HStack {
                        Button(action: close) {
                            Image(systemName: "xmark")
                                .frame(width: 44, height: 44)
                        }
                        .foregroundColor(Palette.ink)
                        .accessibilityLabel(chinese ? "关闭卡片" : "Close card")
                        .accessibilityIdentifier("visualization-close")
                        Spacer()
                        Button {
                            toolsOpen = false
                            presenting = true
                        } label: {
                            Label(chinese ? "演示" : "Present", systemImage: "play")
                        }
                        .font(.system(size: Palette.textSmall, weight: .semibold))
                        .foregroundColor(colorScheme == .dark ? .black : .white)
                        .padding(.horizontal, 10)
                        .frame(minWidth: 44, minHeight: 44)
                        .background(colorScheme == .dark ? Palette.accent : Color(red: 34/255.0, green: 92/255.0, blue: 189/255.0),
                                    in: RoundedRectangle(cornerRadius: 9))
                        .disabled(document.html == nil)
                        .accessibilityIdentifier("visualization-present")
                    }
                    Button {
                        toolsOpen.toggle()
                    } label: {
                        Label(viewLabel, systemImage: toolsOpen ? "chevron.up" : "chevron.down")
                            .font(.system(size: Palette.textSmall, weight: .medium))
                            .padding(.horizontal, 10)
                            .frame(minHeight: 44)
                            .background(Palette.card, in: RoundedRectangle(cornerRadius: 9))
                    }
                    .foregroundColor(Palette.ink)
                    .disabled(document.html == nil)
                    .accessibilityIdentifier("visualization-view-options")
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
            }
            if let html = document.html {
                VisualizationWebView(html: html, presenting: presenting, viewMode: viewMode, manualZoom: manualZoom,
                                     onZoom: { shownZoom = $0 },
                                     onFailure: { document.renderingFailed(chinese: chinese) })
                    .ignoresSafeArea(.container, edges: presenting ? .all : [])
            } else if let error = document.error {
                VStack(spacing: 16) {
                    Text(error)
                        .font(.system(size: Palette.textBody))
                        .foregroundColor(Palette.muted)
                        .multilineTextAlignment(.center)
                    Button(chinese ? "重试" : "Retry", action: load)
                        .frame(minWidth: 64, minHeight: 48)
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView(chinese ? "正在加载卡片…" : "Loading card…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Palette.background.ignoresSafeArea())
        .onAppear(perform: load)
        .statusBarHidden(presenting)
        .onDisappear {
            document.close()
            CardOrientation.request(.portrait)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in close() }
        .overlay(alignment: .top) {
            if toolsOpen {
                Color.clear.contentShape(Rectangle())
                    .padding(.top, 52)
                    .onTapGesture { toolsOpen = false }
                ScrollView {
                    viewTools
                }
                .frame(maxWidth: 252, maxHeight: 194)
                .background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.cardBorder, lineWidth: 1))
                .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
                .padding(.top, 56)
            }
        }
        .overlay(alignment: .topTrailing) {
            // Presentation has no toolbar, so an always-reachable exit stays on top.
            if presenting {
                Button(chinese ? "退出演示" : "Exit") { presenting = false }
                    .font(.system(size: Palette.textSmall, weight: .medium))
                    .foregroundColor(.white)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)
                    .background(Capsule().fill(Color.black.opacity(0.55)))
                    .padding(.top, 10)
                    .padding(.trailing, 12)
                    .accessibilityIdentifier("visualization-exit-present")
            }
        }
    }

    private var zoomLabel: String { "\(Int((shownZoom * 100).rounded()))%" }

    private var viewLabel: String {
        let label: String
        switch viewMode {
        case .width: label = chinese ? "适宽" : "Fit"
        case .whole: label = chinese ? "全卡" : "All"
        case .manual: label = chinese ? "缩放" : "Zoom"
        }
        return label + " · " + zoomLabel
    }

    private var viewTools: some View {
        VStack(spacing: 0) {
            viewOption(chinese ? "适应宽度" : "Fit width", selected: viewMode == .width) { viewMode = .width }
            viewOption(chinese ? "完整显示" : "Show whole card", selected: viewMode == .whole) { viewMode = .whole }
            Divider()
            HStack(spacing: 0) {
                Button("−") { setZoom(shownZoom / 1.25) }.accessibilityLabel(chinese ? "缩小" : "Zoom out")
                Text(zoomLabel).monospacedDigit().frame(maxWidth: .infinity, minHeight: 44)
                Button("+") { setZoom(shownZoom * 1.25) }.accessibilityLabel(chinese ? "放大" : "Zoom in")
            }
            .buttonStyle(VisualizationZoomButtonStyle())
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 8))
            Button {
                toolsOpen = false
                rotate()
            } label: {
                Label(rotateLabel, systemImage: "rotate.right")
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.horizontal, 8)
            }
            .accessibilityIdentifier("visualization-orientation")
        }
        .buttonStyle(.plain)
        .font(.system(size: Palette.textSmall))
        .foregroundColor(Palette.ink)
        .padding(6)
    }

    private func viewOption(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button {
            action()
            toolsOpen = false
        } label: {
            HStack {
                Text(title)
                Spacer()
                if selected { Image(systemName: "checkmark").foregroundColor(Palette.accent) }
            }
            .padding(.horizontal, 8)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func setZoom(_ scale: Double) {
        manualZoom = max(0.05, min(3, scale))
        viewMode = .manual
    }

    private func load() {
        document.load(computer: computer, path: card.path(conversationId: conversationId, dark: colorScheme == .dark),
                      chinese: chinese)
    }

    private func close() {
        document.close()
        CardOrientation.request(.portrait)
        dismiss()
    }

    private var rotateLabel: String {
        if followGravity { return chinese ? "重力" : "Sensor" }
        return landscape ? (chinese ? "竖屏" : "Portrait") : (chinese ? "横屏" : "Landscape")
    }

    /// Landscape, portrait, then sensor: the third state follows gravity so a
    /// phone with auto-rotate enabled can turn the card by turning the device.
    private func rotate() {
        if !landscape && !followGravity {
            landscape = true
            followGravity = false
            CardOrientation.request(.landscape)
        } else if landscape && !followGravity {
            landscape = false
            followGravity = false
            CardOrientation.request(.portrait)
        } else {
            landscape = false
            followGravity = true
            CardOrientation.request(.allButUpsideDown)
        }
    }
}

/// The app is portrait-only outside a card. Landscape is declared in Info.plist
/// because iOS ignores a geometry request the plist does not allow; AppDelegate
/// limits every other screen back to this mask.
@MainActor
enum CardOrientation {
    static private(set) var mask: UIInterfaceOrientationMask = .portrait

    static func request(_ next: UIInterfaceOrientationMask) {
        mask = next
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
            ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
        else { return }
        if #available(iOS 16.0, *) {
            scene.windows.first?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: next))
        } else {
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }
}

@MainActor
private final class RemoteVisualizationDocument: ObservableObject {
    @Published private(set) var html: String?
    @Published private(set) var error: String?
    private var api: RemoteApi?
    private var generation = UUID()
    private let queue = DispatchQueue(label: "app.camellia.visualization")

    func load(computer: PairedComputer, path: String, chinese: Bool) {
        guard api == nil, html == nil else { return }
        error = nil
        guard let endpoint = computer.endpoint, let token = computer.token,
              let client = try? RemoteApi(endpoint: endpoint, token: token) else {
            error = chinese ? "请先连接已配对的电脑。" : "Connect to a paired computer first."
            return
        }
        api = client
        let ticket = UUID()
        generation = ticket
        queue.async { [weak self] in
            let result = Result { () throws -> String in
                let data = try client.read(path, maximumBytes: RemoteVisualization.maximumResponseBytes)
                let response = try JSONBody.object(data)
                guard let html = response.object("card")?.string("html"), !html.isEmpty else {
                    throw RemoteApiError.invalidJSON
                }
                return html
            }
            client.cancel()
            DispatchQueue.main.async { [weak self] in
                guard let self, self.generation == ticket else { return }
                self.api = nil
                switch result {
                case .success(let html): self.html = html
                case .failure(let failure):
                    if let http = failure as? RemoteHttpError {
                        self.error = RemoteFailure.httpMessage(status: http.status, detail: http.detail, chinese: chinese)
                    } else {
                        self.error = chinese ? "无法加载交互卡片。请检查电脑连接或卡片大小后重试。"
                            : "Could not load the card. Check the computer connection and card size, then retry."
                    }
                }
            }
        }
    }

    func renderingFailed(chinese: Bool) {
        close()
        error = chinese ? "卡片显示已中断，请重试。" : "Card rendering stopped. Retry to reopen it."
    }

    func close() {
        generation = UUID()
        api?.cancel()
        api = nil
        html = nil
    }
}

private struct VisualizationZoomButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.5 : 1)
    }
}

private final class VisualizationViewport: WKWebView {
    var resized: (() -> Void)?
    private var previousSize = CGSize.zero

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.size != previousSize else { return }
        previousSize = bounds.size
        resized?()
    }
}

private struct VisualizationWebView: UIViewRepresentable {
    let html: String
    let presenting: Bool
    let viewMode: VisualizationViewMode
    let manualZoom: Double
    let onZoom: (Double) -> Void
    let onFailure: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFailure: onFailure) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        let view = VisualizationViewport(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = false
        view.isOpaque = false
        view.backgroundColor = UIColor(Palette.background)
        let left = UISwipeGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.swipe(_:)))
        left.direction = .left
        left.cancelsTouchesInView = false
        let right = UISwipeGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.swipe(_:)))
        right.direction = .right
        right.cancelsTouchesInView = false
        view.addGestureRecognizer(left)
        view.addGestureRecognizer(right)
        let coordinator = context.coordinator
        coordinator.presentation = presenting
        view.resized = { [weak coordinator] in coordinator?.applyZoom() }
        // The document carries the same restrictive CSP as Android. No token or host bridge enters WebKit.
        view.loadHTMLString(html, baseURL: nil)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        let coordinator = context.coordinator
        let changed = coordinator.presentation != presenting || coordinator.viewMode != viewMode || coordinator.manualZoom != manualZoom
        coordinator.presentation = presenting
        coordinator.viewMode = viewMode
        coordinator.manualZoom = manualZoom
        coordinator.onZoom = onZoom
        if changed { coordinator.applyZoom() }
        guard coordinator.appliedPresentation != presenting, coordinator.ready else { return }
        coordinator.appliedPresentation = presenting
        coordinator.command("(window.__camelliaSetPresenting&&window.__camelliaSetPresenting("
            + (presenting ? "true" : "false") + "))")
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.onFailure = nil
        coordinator.ready = false
        coordinator.activeView = nil
        coordinator.onZoom = nil
        view.stopLoading()
        view.setAllMediaPlaybackSuspended(true, completionHandler: nil)
        view.navigationDelegate = nil
        view.uiDelegate = nil
        view.configuration.userContentController.removeAllUserScripts()
        view.loadHTMLString("", baseURL: nil)
        view.removeFromSuperview()
        // WKWebView has no destroy() API. SwiftUI drops its final owner after this teardown.
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var onFailure: (() -> Void)?
        var presentation = false
        var viewMode: VisualizationViewMode = .width
        var manualZoom = 1.0
        var onZoom: ((Double) -> Void)?
        private var zoomRequest = 0
        var appliedPresentation = false
        var ready = false
        weak var activeView: WKWebView?
        init(onFailure: @escaping () -> Void) {
            self.onFailure = onFailure
        }

        func applyZoom() {
            guard ready, let view = activeView else { return }
            zoomRequest += 1
            let request = zoomRequest
            let mode = viewMode
            let baseScale = !presentation && mode == .manual ? manualZoom : 1
            view.pageZoom = CGFloat(baseScale)
            if !presentation && mode != .manual {
                view.evaluateJavaScript("""
                    ({width: Math.max(document.body.scrollWidth, document.documentElement.clientWidth),
                      height: Math.max(document.body.scrollHeight, document.documentElement.clientHeight)})
                    """) { [weak self, weak view] result, _ in
                    guard let self = self, let view = view, request == self.zoomRequest, self.ready,
                          let size = result as? [String: Double],
                          let width = size["width"], let height = size["height"], width > 0, height > 0 else { return }
                    let widthScale = Double(view.bounds.width) / width
                    let scale = max(0.05, min(1, widthScale, mode == .whole ? Double(view.bounds.height) / height : 1))
                    view.pageZoom = CGFloat(scale)
                    self.onZoom?(scale)
                }
            } else if !presentation {
                DispatchQueue.main.async { [weak self] in
                    guard let self = self, request == self.zoomRequest else { return }
                    self.onZoom?(baseScale)
                }
            }
        }

        func command(_ source: String) {
            activeView?.evaluateJavaScript(source, completionHandler: nil)
        }

        @objc func swipe(_ gesture: UISwipeGestureRecognizer) {
            guard presentation, let view = gesture.view as? WKWebView else { return }
            let command = gesture.direction == .left ? "next" : "previous"
            view.evaluateJavaScript(
                "(function(command){if(window.__camelliaPresentationCommand)"
                + "window.__camelliaPresentationCommand(command);"
                + "else window.dispatchEvent(new CustomEvent('camellia:presentation-command',{detail:{command:command}}));"
                + "})('" + command + "')",
                completionHandler: nil)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            activeView = webView
            ready = true
            appliedPresentation = presentation
            applyZoom()
            if presentation {
                command("(window.__camelliaSetPresenting&&window.__camelliaSetPresenting(true))")
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // Only the initial in-memory document may navigate; links, frames and redirects stay blocked.
            decisionHandler(navigationAction.navigationType == .other
                && navigationAction.request.url?.absoluteString == "about:blank"
                && navigationAction.targetFrame?.isMainFrame == true ? .allow : .cancel)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { onFailure?() }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { onFailure?() }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { onFailure?() }
        }
    }
}
