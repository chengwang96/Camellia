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
    /// The viewer owns a landscape lock only while its rotate control is active.
    @State private var landscape = false
    /// Follow the device's gravity once the user enables sensor rotation.
    @State private var followGravity = false

    var body: some View {
        VStack(spacing: 0) {
            if !presenting {
                HStack(spacing: 10) {
                    Text(card.title.isEmpty ? (chinese ? "交互卡片" : "Interactive card") : card.title)
                        .font(.system(size: Palette.textCard, weight: .medium))
                        .foregroundColor(Palette.ink)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button(chinese ? "演示" : "Present") { presenting = true }
                        .font(.system(size: Palette.textSmall, weight: .medium))
                        .foregroundColor(Palette.accent)
                        .frame(minWidth: 56, minHeight: 48)
                        .overlay(RoundedRectangle(cornerRadius: Palette.dialogActionRadius)
                            .stroke(Palette.cardBorder, lineWidth: 1))
                        .accessibilityIdentifier("visualization-present")
                    Button(rotateLabel) { rotate() }
                        .font(.system(size: Palette.textSmall, weight: .medium))
                        .foregroundColor(Palette.accent)
                        .frame(minWidth: 56, minHeight: 48)
                        .overlay(RoundedRectangle(cornerRadius: Palette.dialogActionRadius)
                            .stroke(Palette.cardBorder, lineWidth: 1))
                        .accessibilityIdentifier("visualization-orientation")
                    Button(chinese ? "关闭" : "Close", action: close)
                        .font(.system(size: Palette.textRow))
                        .foregroundColor(Palette.accent)
                        .frame(minWidth: 56, minHeight: 48)
                        .overlay(RoundedRectangle(cornerRadius: Palette.dialogActionRadius)
                            .stroke(Palette.cardBorder, lineWidth: 1))
                        .accessibilityIdentifier("visualization-close")
                }
                .padding(.leading, 16)
                .padding(.trailing, 8)
                .padding(.vertical, 8)
            }
            if let html = document.html {
                VisualizationWebView(html: html, presenting: presenting,
                                     onFailure: { document.renderingFailed(chinese: chinese) })
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

private struct VisualizationWebView: UIViewRepresentable {
    let html: String
    let presenting: Bool
    let onFailure: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFailure: onFailure) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = false
        view.isOpaque = false
        view.backgroundColor = UIColor(Palette.background)
        let left = UISwipeGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.swipe(_:)))
        left.direction = .left
        let right = UISwipeGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.swipe(_:)))
        right.direction = .right
        view.addGestureRecognizer(left)
        view.addGestureRecognizer(right)
        context.coordinator.presentation = presenting
        // The document carries the same restrictive CSP as Android. No token or host bridge enters WebKit.
        view.loadHTMLString(html, baseURL: nil)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.presentation = presenting
        guard coordinator.appliedPresentation != presenting, coordinator.ready else { return }
        coordinator.appliedPresentation = presenting
        coordinator.command("(window.__camelliaSetPresenting&&window.__camelliaSetPresenting("
            + (presenting ? "true" : "false") + "))")
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.onFailure = nil
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
        var appliedPresentation = false
        var ready = false
        weak var activeView: WKWebView?
        init(onFailure: @escaping () -> Void) {
            self.onFailure = onFailure
        }

        func command(_ source: String) {
            activeView?.evaluateJavaScript(source, completionHandler: nil)
        }

        @objc func swipe(_ gesture: UISwipeGestureRecognizer) {
            guard presentation, let view = gesture.view as? WKWebView else { return }
            view.evaluateJavaScript(
                "window.dispatchEvent(new CustomEvent('camellia:presentation-command',"
                + "{detail:{command:'" + (gesture.direction == .left ? "next" : "previous") + "'}}))",
                completionHandler: nil)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            activeView = webView
            ready = true
            appliedPresentation = presentation
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
