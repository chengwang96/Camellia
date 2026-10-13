import SwiftUI

enum ChatDockLayout {
    static let fadeHeight: CGFloat = 36
    static let barBottom: CGFloat = 8
    static let fadeStops: [Gradient.Stop] = [
        .init(color: Palette.background.opacity(0), location: 0),
        .init(color: Palette.background.opacity(40.0 / 255), location: 1.0 / 3),
        .init(color: Palette.background.opacity(184.0 / 255), location: 2.0 / 3),
        .init(color: Palette.background, location: 1),
    ]
}

/// Keep a readable final row when an iPad keyboard leaves a short viewport.
struct ChatDockMetrics {
    let fadeHeight: CGFloat
    let contentBottom: CGFloat
    init(viewportHeight: CGFloat = .infinity) {
        fadeHeight = min(ChatDockLayout.fadeHeight, max(0, viewportHeight - 80))
        let margin = min(PageGutter.contentBottom, max(0, viewportHeight - fadeHeight - 48))
        contentBottom = fadeHeight + margin
    }
}

private struct ChatDockMetricsKey: EnvironmentKey {
    static let defaultValue = ChatDockMetrics()
}

private extension EnvironmentValues {
    var chatDockMetrics: ChatDockMetrics {
        get { self[ChatDockMetricsKey.self] }
        set { self[ChatDockMetricsKey.self] = newValue }
    }
}

private struct ChatContentTailPadding: ViewModifier {
    @Environment(\.chatDockMetrics) private var metrics
    func body(content: Content) -> some View { content.padding(.bottom, metrics.contentBottom) }
}

private struct ChatDock<Dock: View>: ViewModifier {
    let dock: Dock
    @State private var viewportHeight: CGFloat = .infinity
    func body(content: Content) -> some View {
        let metrics = ChatDockMetrics(viewportHeight: viewportHeight)
        content
            .environment(\.chatDockMetrics, metrics)
            .background(GeometryReader { geometry in
                Color.clear
                    .onAppear { viewportHeight = geometry.size.height }
                    .onChange(of: geometry.size.height) { viewportHeight = $0 }
            })
            .safeAreaInset(edge: .bottom, spacing: -metrics.fadeHeight) {
                VStack(spacing: 0) {
                    LinearGradient(stops: ChatDockLayout.fadeStops, startPoint: .top, endPoint: .bottom)
                        .frame(height: metrics.fadeHeight)
                        .padding(.horizontal, PageGutter.horizontal)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                    dock
                        .padding(.bottom, PageGutter.dockBottom)
                        .background(Palette.background.ignoresSafeArea(.container, edges: .bottom))
                }
            }
    }
}

extension View {
    /// Content extends behind the transparent fade; the resting final row
    /// reserves the fade plus its own bottom margin. No opaque parent behind it.
    func chatDock<Dock: View>(@ViewBuilder content: () -> Dock) -> some View {
        modifier(ChatDock(dock: content()))
    }
    func chatContentTailPadding() -> some View { modifier(ChatContentTailPadding()) }
}

struct ChatSearchBar: View {
    @Binding var text: String
    let placeholder: String
    let newConversationLabel: String
    let onNewConversation: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 0) {
                MobileLineIcon(name: "search", size: 24).frame(width: 44, height: 44)
                ZStack(alignment: .leading) {
                    if text.isEmpty {
                        Text(LocalizedStringKey(placeholder))
                            .foregroundColor(Palette.muted)
                            .padding(.leading, 2)
                            .allowsHitTesting(false)
                    }
                    TextField("", text: $text)
                        .textFieldStyle(.plain)
                        .foregroundColor(Palette.ink)
                        .frame(minHeight: 48)
                        .padding(EdgeInsets(top: 0, leading: 2, bottom: 0, trailing: 8))
                        .accessibilityLabel(Text(LocalizedStringKey(placeholder)))
                }
                .font(.system(size: Palette.textRow))
            }
            .frame(height: 48)
            .background(Capsule(style: .continuous).fill(Palette.background)
                .shadow(color: .black.opacity(0.04), radius: 4, y: 1))
            .overlay(Capsule(style: .continuous).stroke(Palette.separator, lineWidth: 1))
            Button(action: onNewConversation) {
                MobileLineIcon(name: "plus.bubble", size: 22)
                    .foregroundColor(Palette.ink)
                    .frame(width: 48, height: 48)
                    .background(Circle().fill(Palette.raisedFace)
                        .overlay(Circle().stroke(Palette.raisedEdge, lineWidth: 1))
                        .shadow(color: .black.opacity(0.16), radius: 4, y: 1))
                    .contentShape(Circle())
            }
            .buttonStyle(ComposerPressStyle())
            .accessibilityLabel(newConversationLabel)
        }
        .padding(.vertical, 6)
        .padding(.bottom, ChatDockLayout.barBottom)
    }
}
