import SwiftUI
import UIKit

/// Isolated layout/pixel assertions, not simulated finger or keyboard input.
@main
struct ChatDockChecksApp: App {
    var body: some Scene {
        WindowGroup { DockCheckMount().ignoresSafeArea(.container) }
    }
}

private struct DockCheckMount: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> DockCheckController { DockCheckController() }
    func updateUIViewController(_ controller: DockCheckController, context: Context) {}
}

private final class DockMarks {
    weak var viewport: UIView?
    weak var bar: UIView?
    weak var last: UIView?
    var viewportBottom = CGFloat.nan
}

private struct DockMarker: UIViewRepresentable {
    let marks: DockMarks
    let slot: Int
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        switch slot {
        case 0: marks.viewport = view
        case 1: marks.bar = view
        default: marks.last = view
        }
        return view
    }
    func updateUIView(_ view: UIView, context: Context) {}
}

private struct DockPixelFixture: View {
    let marks: DockMarks
    let barHeight: CGFloat
    var body: some View {
        Color(red: 0.2, green: 0.4, blue: 0.8)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(DockMarker(marks: marks, slot: 0))
            .chatDock {
                Color.clear.frame(height: barHeight)
                    .background(DockMarker(marks: marks, slot: 1))
            }
    }
}

private struct DockScrollFixture: View {
    let marks: DockMarks
    var headerHeight: CGFloat = 0
    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Color.blue.frame(height: 1800)
                Color.red.frame(height: 48)
                    .background(DockMarker(marks: marks, slot: 2))
            }
            .chatContentTailPadding()
        }
        .background(DockMarker(marks: marks, slot: 0))
        .measuringViewportBottom()
        .chatDock {
            Color.clear.frame(height: 116)
                .background(DockMarker(marks: marks, slot: 1))
        }
        .safeAreaInset(edge: .top, spacing: 0) { Color.clear.frame(height: headerHeight) }
        .onPreferenceChange(ScrollViewportBottomKey.self) { marks.viewportBottom = $0 }
    }
}

private struct DockListFixture: View {
    let marks: DockMarks
    var body: some View {
        List {
            Color.blue.frame(height: 1800).plainPageRow()
            Color.red.frame(height: 48)
                .background(DockMarker(marks: marks, slot: 2)).plainPageRow()
            Color.clear.frame(height: 0).chatContentTailPadding().plainPageRow()
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 0)
        .background(DockMarker(marks: marks, slot: 0))
        .plainPageBackground()
        .chatDock {
            Color.clear.frame(height: 68)
                .background(DockMarker(marks: marks, slot: 1))
        }
    }
}

@MainActor private final class DockCheckController: UIViewController {
    private var started = false
    private var assertions = 0
    private var host: UIViewController?
    private struct Failure: Error, CustomStringConvertible { let description: String }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        Task {
            do {
                for dark in [false, true] {
                    for short in [false, true] {
                        for height: CGFloat in [68, 116, 190] {
                            try await pixels(dark: dark, short: short, height: height)
                        }
                    }
                    try await scrollTail(dark: dark)
                    try await listTail(dark: dark)
                    for height: CGFloat in [289, 320] {
                        try await compactScrollTail(dark: dark, height: height)
                    }
                }
                print("PASS: \(assertions) chat-dock layout/pixel assertions; controlled hosting, not touch input")
                fflush(stdout)
                if ProcessInfo.processInfo.environment["CAMELLIA_DOCK_CHECK_PERSIST"] != "1" { exit(0) }
            } catch {
                print("FAIL: \(error)"); fflush(stdout); exit(1)
            }
        }
    }

    private func mount<V: View>(_ fixture: V, dark: Bool, short: Bool = false,
                               height: CGFloat? = nil) async -> UIView {
        if let host {
            host.willMove(toParent: nil); host.view.removeFromSuperview(); host.removeFromParent()
        }
        let controller = UIHostingController(rootView: fixture.environment(\.colorScheme, dark ? .dark : .light))
        controller.overrideUserInterfaceStyle = dark ? .dark : .light
        addChild(controller)
        let bounds = view.bounds
        controller.view.frame = CGRect(x: 0, y: 0, width: bounds.width,
                                       height: height ?? (short ? min(360, bounds.height) : bounds.height))
        view.addSubview(controller.view)
        controller.didMove(toParent: self)
        host = controller
        view.layoutIfNeeded(); controller.view.layoutIfNeeded()
        try? await Task.sleep(nanoseconds: 150_000_000)
        controller.view.layoutIfNeeded()
        return controller.view
    }

    private func check(_ condition: Bool, _ message: String) throws {
        assertions += 1
        if !condition { throw Failure(description: message) }
    }

    private func pixels(dark: Bool, short: Bool, height: CGFloat) async throws {
        let marks = DockMarks()
        let canvas = await mount(DockPixelFixture(marks: marks, barHeight: height), dark: dark, short: short)
        guard let viewport = marks.viewport, let bar = marks.bar else { throw Failure(description: "missing dock layout marks") }
        let viewportRect = viewport.convert(viewport.bounds, to: canvas)
        let barRect = bar.convert(bar.bounds, to: canvas)
        try check(abs(viewportRect.maxY - barRect.minY) < 0.6, "viewport must overlap the fade, not stop above it")
        try check(abs(barRect.height - height) < 0.6, "dock must respect dynamic bar height")
        let bottomGap = canvas.bounds.maxY - canvas.safeAreaInsets.bottom - barRect.maxY
        try check(abs(bottomGap - PageGutter.dockBottom) < 0.6, "root bottom padding must remain separate from bar margin")
        let fade = min(ChatDockLayout.fadeHeight, max(0, viewportRect.height - 80))
        print("DOCK FRAME: viewport=\(viewportRect) bar=\(barRect) safeArea=\(canvas.safeAreaInsets) fade=\(fade)")

        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.preferredRange = .standard
        let image = UIGraphicsImageRenderer(size: canvas.bounds.size, format: format).image { _ in
            canvas.drawHierarchy(in: canvas.bounds, afterScreenUpdates: true)
        }
        let x = floor(canvas.bounds.midX)
        let top = barRect.minY - fade
        let original = try red(image, x: x, y: top - 2)
        let page = try red(image, x: x, y: barRect.minY + 2)
        // A tall input on a notched phone leaves less than 116pt of viewport,
        // so the production fade is intentionally shorter than 36pt. Keep
        // the same opacity assertions, sampled at the same relative stops.
        let fractions: [CGFloat] = [1.0 / 36, 1.0 / 3, 2.0 / 3, 35.0 / 36]
        let samples = try fractions.map {
            (try red(image, x: x, y: top + fade * $0) - original) / (page - original)
        }
        print("DOCK PIXELS: dark=\(dark) short=\(short) height=\(height) alpha=\(samples)")
        try check(samples[0] < 0.1, "fade top must expose underlying content, not an opaque background")
        try check(samples[0] < samples[1] && samples[1] < samples[2] && samples[2] < samples[3],
                  "fade opacity must increase towards the input")
        try check(samples[1] > 0.05 && samples[1] < 0.4, "first middle stop must remain translucent")
        try check(samples[2] > 0.6 && samples[2] < 0.9, "second middle stop must approach the page colour")
        try check(samples[3] > 0.96, "fade bottom must join the opaque dock without a seam")
        let gutter = try red(image, x: 8, y: top + fade / 3)
        try check(abs(gutter - original) < 0.025, "fade must respect the 18-point page gutter")
        let bodySide = try red(image, x: 8, y: barRect.midY)
        try check(abs(bodySide - page) < 0.025, "input-side space must be opaque")
    }

    private func scrollTail(dark: Bool) async throws {
        let marks = DockMarks()
        let canvas = await mount(DockScrollFixture(marks: marks), dark: dark)
        guard let scroll = Self.scroll(in: canvas), let last = marks.last, let bar = marks.bar else {
            throw Failure(description: "missing scroll-tail marks")
        }
        let bottom = max(-scroll.adjustedContentInset.top,
                         scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
        scroll.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
        try? await Task.sleep(nanoseconds: 150_000_000)
        canvas.layoutIfNeeded()
        let lastRect = last.convert(last.bounds, to: canvas)
        let barRect = bar.convert(bar.bounds, to: canvas)
        let gap = barRect.minY - ChatDockLayout.fadeHeight - lastRect.maxY
        print("DOCK TAIL: dark=\(dark) gap=\(gap) scrollInsets=\(scroll.adjustedContentInset)")
        try check(abs(gap - PageGutter.contentBottom) < 0.6, "last row must settle 16 points above the fade")
        let visibleBottom = bar.convert(bar.bounds, to: nil).minY
        try check(abs(marks.viewportBottom - visibleBottom) < 0.6,
                  "scroll-follow measurement must exclude the opaque dock")
    }

    private static func scroll(in view: UIView) -> UIScrollView? {
        if let scroll = view as? UIScrollView { return scroll }
        return view.subviews.lazy.compactMap { scroll(in: $0) }.first
    }

    private func listTail(dark: Bool) async throws {
        let marks = DockMarks()
        let canvas = await mount(DockListFixture(marks: marks), dark: dark)
        guard let scroll = Self.scroll(in: canvas), let viewport = marks.viewport, let bar = marks.bar else {
            throw Failure(description: "missing list dock marks")
        }
        // List first estimates the off-screen cells. Let their real heights
        // settle before asserting the actual end of its scrollable content.
        for _ in 0..<3 {
            let bottom = max(-scroll.adjustedContentInset.top,
                             scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            scroll.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
            try? await Task.sleep(nanoseconds: 100_000_000)
            canvas.layoutIfNeeded()
        }
        guard let last = marks.last else { throw Failure(description: "missing final list row") }
        let viewportRect = viewport.convert(viewport.bounds, to: canvas)
        let barRect = bar.convert(bar.bounds, to: canvas)
        let lastRect = last.convert(last.bounds, to: canvas)
        print("LIST DOCK TAIL: dark=\(dark) viewport=\(viewportRect) last=\(lastRect) bar=\(barRect)")
        try check(abs(viewportRect.maxY - barRect.minY) < 0.6,
                  "list must scroll behind the fade without an external blank band")
        try check(abs(barRect.minY - ChatDockLayout.fadeHeight - lastRect.maxY - PageGutter.contentBottom) < 0.6,
                  "last list row must reserve the fade inside its scrollable content")
    }

    private func compactScrollTail(dark: Bool, height: CGFloat) async throws {
        let marks = DockMarks()
        let canvas = await mount(DockScrollFixture(marks: marks, headerHeight: 80), dark: dark, height: height)
        guard let scroll = Self.scroll(in: canvas), let last = marks.last,
              let viewport = marks.viewport, let bar = marks.bar else {
            throw Failure(description: "missing compact scroll-tail marks")
        }
        let bottom = max(-scroll.adjustedContentInset.top,
                         scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
        scroll.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
        try? await Task.sleep(nanoseconds: 150_000_000)
        canvas.layoutIfNeeded()
        let viewportRect = viewport.convert(viewport.bounds, to: canvas)
        let lastRect = last.convert(last.bounds, to: canvas)
        let barRect = bar.convert(bar.bounds, to: canvas)
        let fade = min(ChatDockLayout.fadeHeight, max(0, viewportRect.height - 80))
        print("COMPACT DOCK TAIL: dark=\(dark) viewport=\(viewportRect) last=\(lastRect) bar=\(barRect)")
        try check(viewportRect.height < 100, "compact fixture must represent an iPad landscape keyboard viewport")
        // A viewport shorter than one row cannot show that whole row. It must
        // still expose its full available height, without extra tail padding.
        let visibleHeight = lastRect.intersection(viewportRect).height
        try check(visibleHeight >= min(lastRect.height, viewportRect.height) - 0.6,
                  "compact viewport must expose as much of the final row as physically fits")
        try check(lastRect.maxY <= barRect.minY - fade + 0.6, "compact viewport must keep the final row out of the opaque dock/fade")
    }

    private func red(_ image: UIImage, x: CGFloat, y: CGFloat) throws -> Double {
        guard let cropped = image.cgImage?.cropping(to: CGRect(x: x, y: floor(y), width: 1, height: 1)) else {
            throw Failure(description: "pixel outside image")
        }
        var rgba = [UInt8](repeating: 0, count: 4)
        rgba.withUnsafeMutableBytes { bytes in
            let context = CGContext(data: bytes.baseAddress, width: 1, height: 1, bitsPerComponent: 8,
                                    bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(),
                                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            context?.draw(cropped, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        }
        return Double(rgba[0]) / 255
    }
}
