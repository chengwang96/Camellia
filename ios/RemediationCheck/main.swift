import Foundation
import SwiftUI
import UIKit
import CryptoKit

/// Runs production model transitions in a separate simulator app/container.
@main
struct CamelliaRemediationCheck: App {
    var body: some Scene {
        WindowGroup {
            if LaunchScreen.requested == "remoteListFixture" {
                RemoteListFixtureView()
            } else {
                Text("Camellia remediation checks").onAppear { Task { await RemediationChecks.run() } }
            }
        }
    }
}

private final class PersistenceGate: @unchecked Sendable {
    private let lock = NSLock()
    private var entered = false
    private let release = DispatchSemaphore(value: 0)
    var started: Bool { lock.lock(); defer { lock.unlock() }; return entered }
    func block() {
        lock.lock(); entered = true; lock.unlock()
        _ = release.wait(timeout: .now() + 8)
    }
    func resume() { release.signal() }
}

/// Delay the first prepared-send seal, then fail the first rollback seal.
private final class RollbackFaultKeys: SecretKeyStore, @unchecked Sendable {
    let gate = PersistenceGate()
    private let base: SecretKeyStore
    private let lock = NSLock()
    private var calls: Int?
    init(_ base: SecretKeyStore) { self.base = base }
    func arm() { lock.lock(); calls = 0; lock.unlock() }
    private func nextCall() -> Int? {
        lock.lock(); defer { lock.unlock() }
        guard let current = calls else { return nil }
        let next = current + 1
        calls = next == 4 ? nil : next
        return next
    }
    func key() throws -> SymmetricKey {
        let call = nextCall()
        if call == 1 { gate.block() }
        if call == 4 { throw LocalChatStoreError.storageUnavailable }
        return try base.key()
    }
}

private struct PopupFrameProbe: UIViewRepresentable {
    let view: UIView
    func makeUIView(context: Context) -> UIView { view }
    func updateUIView(_ uiView: UIView, context: Context) {}
}

@MainActor
private final class CoverFixtureState: ObservableObject {
    @Published var page = false
    @Published var camera = false
    var pageDismissals = 0
    var cameraDismissals = 0
    var backCalls = 0
    var scanned: String?
    var applied: String?
}

private struct CoverFixture: View {
    @ObservedObject var state: CoverFixtureState
    var body: some View {
        Text("Fixture home")
            .pageCover(isPresented: $state.page, onDismiss: { state.pageDismissals += 1 }) {
                CoverPairingFixture(state: state)
            }
    }
}

/// Like PairingView, the mounted page observes its own scanner state. Reading
/// it only in the hidden home fixture would not exercise the production tree.
private struct CoverPairingFixture: View {
    @ObservedObject var state: CoverFixtureState
    var body: some View {
        NavigationView {
            VStack {
                RoundBackButton { state.page = false }
                Text("Pair computer")
            }
            .navigationBarHidden(true)
        }
        .navigationViewStyle(.stack)
        .pageCover(isPresented: $state.camera, keepsPresentingView: true, onDismiss: {
            state.cameraDismissals += 1
            state.applied = state.scanned
        }) {
            VStack {
                RoundBackButton { state.camera = false }
                Text("Scanner result fixture; no camera access")
            }
        }
    }
}

@MainActor
private enum RemediationChecks {
    private static var failures: [String] = []
    private static var count = 0
    private static var started = false

    private static func expect(_ value: Bool, _ label: String) {
        count += 1
        if !value {
            failures.append(label)
            print("FAIL: \(label)")
            fflush(stdout)
        }
    }

    private static func waitUntil(_ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(8)
        while !condition(), Date() < deadline { try? await Task.sleep(nanoseconds: 10_000_000) }
        return condition()
    }

    static func run() async {
        guard !started else { return }
        started = true
        precondition(Bundle.main.bundleIdentifier == "app.camellia.mobile.remediationcheck")
        do {
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                      appropriateFor: nil, create: true)
            for name in ["camellia-localchat", "camellia-attachments"] {
                try? FileManager.default.removeItem(at: support.appendingPathComponent(name))
            }
            let model = LocalChatModel()
            expect(await waitUntil { !model.loading }, "background store load finishes")
            let rawConfig = #"{"providers":[{"id":"check","name":"Check","protocol":"openai","baseUrl":"https://invalid.example","keys":[{"key":"fixture-key"}],"models":[{"id":"check","upstream":"fixture"}]}]}"#
            let config = try LocalChatConfiguration.export(JSONBody.object(Data(rawConfig.utf8)).raw)
            let importProblem = await model.importConfig(config)
            expect(importProblem == nil, "provider import commits asynchronously: \(importProblem ?? model.notice?.text ?? "ok")")
            guard let conversation = await model.createConversation(workspace: "") else {
                throw LocalChatStoreError.conversationNotFound
            }
            let id = conversation.id
            model.draft = "keep this draft"
            _ = await model.stashDraft()?.value
            let state = support.appendingPathComponent("camellia-localchat/state")
            let savedState = try Data(contentsOf: state)
            let blobDirectory = support.appendingPathComponent("camellia-attachments")
            let filesBefore = Set((try? FileManager.default.contentsOfDirectory(atPath: blobDirectory.path)) ?? [])
            try FileManager.default.removeItem(at: state)
            try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
            let image = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { context in
                UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
            }
            let encoded = try AttachmentImage.encode(image)
            model.addEncodedImages([encoded])
            expect(await waitUntil { !model.busy }, "failed attachment transaction completes")
            expect(model.images.isEmpty && model.draft == "keep this draft", "failed attachment save restores the composer")
            expect(Set((try? FileManager.default.contentsOfDirectory(atPath: blobDirectory.path)) ?? []) == filesBefore,
                   "failed attachment save removes its new blob and thumbnail")
            model.close(); model.open(id)
            expect(model.images.isEmpty && model.draft == "keep this draft", "failed attachment draft remains recoverable after navigation")
            try FileManager.default.removeItem(at: state)
            try savedState.write(to: state)
            _ = await model.stashDraft()?.value
            model.addEncodedImages([encoded])
            expect(await waitUntil { !model.busy }, "successful attachment transaction completes")
            expect(model.images.count == 1 && LocalChatDraft.images(model.store.conversation(id) ?? [:]) == model.images,
                   "the tray accepts files only after their draft commits")

            let store = model.store
            let gate = PersistenceGate()
            let blocked = Task.detached { try await store.perform { _ in gate.block() } }
            expect(await waitUntil { gate.started }, "the persistence worker can be delayed without blocking UI")
            model.send(chinese: true)
            expect(model.preparing && model.running, "send enters background preparation")
            try? await Task.sleep(nanoseconds: 80_000_000)
            model.stop()
            gate.resume()
            _ = try await blocked.value
            expect(await waitUntil { !model.running }, "cancelling a send waits for any durable rollback")
            expect(model.draft == "keep this draft" && model.images.count == 1, "cancelled preparation preserves text and attachments")
            expect((store.conversation(id)?["messages"] as? [Any])?.isEmpty == true,
                   "cancelled preparation leaves no unsent history placeholder")

            let deleteGate = PersistenceGate()
            let delayedDelete = Task.detached { try await store.perform { _ in deleteGate.block() } }
            expect(await waitUntil { deleteGate.started }, "the delete race is staged")
            model.send(chinese: true)
            let deletion = Task { await model.delete([id]) }
            try? await Task.sleep(nanoseconds: 80_000_000)
            deleteGate.resume()
            _ = try await delayedDelete.value
            expect(await deletion.value, "deleting a preparing conversation completes")
            expect(store.conversation(id) == nil && !model.running, "deletion cannot resurrect the preparing conversation")
            expect((try? FileManager.default.contentsOfDirectory(atPath: blobDirectory.path))?.isEmpty == true,
                   "deleting the last attachment owner reclaims its files")

            let parseGate = PersistenceGate()
            let renderer = MarkdownRenderScheduler { source, cancellation in
                if source == "start" { parseGate.block() }
                return MarkdownParser.parse(source, isCancelled: { cancellation.isCancelled })
            }
            let markdown = MarkdownRenderModel(scheduler: renderer)
            markdown.update("start", streaming: true)
            expect(await waitUntil { parseGate.started }, "Markdown parsing starts on its worker")
            for index in 0..<200 { markdown.update("stream \(index)", streaming: true) }
            expect(renderer.runningCount == 1 && renderer.pendingCount == 1,
                   "streaming Markdown keeps one active and one latest pending version")
            markdown.update("**final**", streaming: false)
            parseGate.resume()
            expect(await waitUntil { markdown.document?.source == "**final**" }, "the final Markdown version cancels and supersedes old work")
            expect(markdown.document?.plainText == "final", "background Markdown preserves formatting")

            let queueGate = PersistenceGate()
            let bounded = MarkdownRenderScheduler { source, cancellation in
                if source == "blocked" { queueGate.block() }
                return MarkdownParser.parse(source, isCancelled: { cancellation.isCancelled })
            }
            let first = MarkdownRenderModel(scheduler: bounded)
            first.update("blocked", streaming: true)
            expect(await waitUntil { queueGate.started }, "the Markdown backlog race is staged")
            let owners = (0..<65).map { _ in MarkdownRenderModel(scheduler: bounded) }
            for (index, owner) in owners.enumerated() { owner.update("answer \(index)", streaming: false) }
            expect(bounded.pendingCount == 32 && bounded.runningCount == 1,
                   "many completed messages cannot create an unbounded parse backlog")
            first.cancel()
            queueGate.resume()
            expect(await waitUntil { bounded.runningCount == 0 && bounded.pendingCount == 0 }, "the bounded Markdown queue drains")
            expect(first.document == nil, "a cancelled Markdown owner receives no late result")

            let recoveryRoot = support.appendingPathComponent("rollback-check-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: recoveryRoot) }
            let keys = RollbackFaultKeys(FileSecretKeyStore(url: recoveryRoot.appendingPathComponent("key")))
            let recoveryBlobs = AttachmentStore(directory: recoveryRoot.appendingPathComponent("blobs"), keys: keys)
            let recoveryStore = try LocalChatStore(directory: recoveryRoot.appendingPathComponent("store"), keys: keys, attachments: recoveryBlobs)
            let recovery = LocalChatModel(store: recoveryStore, attachments: recoveryBlobs)
            expect(await waitUntil { !recovery.loading }, "an isolated recovery model loads")
            _ = await recovery.importConfig(config)
            guard let recoveryConversation = await recovery.createConversation(workspace: "") else {
                throw LocalChatStoreError.conversationNotFound
            }
            let originalBlob = try recoveryBlobs.save(Data("original image".utf8))
            let originalMessages: [[String: Any]] = [
                ["role": "user", "content": "original question", "images": [originalBlob]],
                ["role": "assistant", "content": "original answer", "state": "completed"]
            ]
            try await recoveryStore.perform { store in
                try store.update(recoveryConversation.id) { $0["messages"] = originalMessages }
            }
            recoveryBlobs.updateReferences(owner: "remote", references: [])
            try recoveryBlobs.reconcile()
            recovery.open(recoveryConversation.id)
            recovery.beginEdit(0)
            recovery.removeImage(originalBlob)
            recovery.draft = "recover after rollback failure"
            _ = await recovery.stashDraft()?.value
            keys.arm()
            recovery.send(chinese: true)
            expect(await waitUntil { keys.gate.started }, "prepared-send persistence is staged before cancellation")
            recovery.stop()
            keys.gate.resume()
            expect(await waitUntil { recovery.needsSaveRetry }, "a failed cancellation rollback is reported as retryable")
            expect(recovery.running && recovery.preparing && recovery.draft == "recover after rollback failure",
                   "rollback failure preserves input and prevents another send")
            expect(try recoveryBlobs.open(originalBlob) == Data("original image".utf8),
                   "rollback failure keeps the replaced message's original attachment")
            recovery.resumePendingSaves()
            expect(await waitUntil { !recovery.running }, "foreground recovery retries storage without resending")
            let restored = recoveryStore.conversation(recoveryConversation.id)?["messages"] as? [[String: Any]] ?? []
            expect((restored as NSArray).isEqual(to: originalMessages) && !recovery.needsSaveRetry,
                   "retry restores the original history and completes the cancelled edit rollback")
            expect(try recoveryBlobs.open(originalBlob) == Data("original image".utf8),
                   "restored history keeps its file after temporary protection is released")
            let reopened = try LocalChatStore(directory: recoveryRoot.appendingPathComponent("store"), keys: keys)
            let reopenedMessages = reopened.conversation(recoveryConversation.id)?["messages"] as? [[String: Any]] ?? []
            expect((reopenedMessages as NSArray).isEqual(to: originalMessages),
                   "cancelled edit history is recoverable after reopening the store")

            try await checkBackground(.dark)
            try await checkBackground(.light)
            for style: UIUserInterfaceStyle in [.light, .dark] {
                try await checkPopupSurface(style, size: CGSize(width: 288, height: 248))
                try await checkPopupSurface(style, size: CGSize(width: 312, height: 344))
            }
            try await checkBackNavigation()
            try await checkPageCovers()
            try await checkComposerFeedback()
            try await captureReferenceScreens()
        } catch {
            failures.append("unexpected error: \(error)")
            print("FAIL: unexpected error: \(error)")
        }
        print("remediation checks=\(count) verdict=\(failures.isEmpty ? "PASS" : "FAIL")")
        fflush(stdout)
        exit(failures.isEmpty ? 0 : 1)
    }

    private static func checkBackground(_ style: UIUserInterfaceStyle) async throws {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let window = scene.windows.first(where: { $0.isKeyWindow }) else { throw CocoaError(.fileReadUnknown) }
        let old = window.rootViewController
        defer { window.rootViewController = old }
        let fixture = List {
            Text("Camellia list background").plainPageRow()
            Text("Native background API").plainPageRow()
        }
        .listStyle(.plain)
        .background(Palette.background)
        .plainPageBackground()
        .preferredColorScheme(style == .dark ? .dark : .light)
        let host = UIHostingController(rootView: fixture)
        host.overrideUserInterfaceStyle = style
        window.rootViewController = host
        host.view.layoutIfNeeded()
        try await Task.sleep(nanoseconds: 300_000_000)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let name = style == .dark ? "dark" : "light"
        try image.pngData()?.write(to: documents.appendingPathComponent("remediation-background-\(name).png"))
        guard let cgImage = image.cgImage else { throw CocoaError(.fileReadUnknown) }
        var pixel = [UInt8](repeating: 0, count: 4)
        let rgba = pixel.withUnsafeMutableBytes { buffer -> [UInt8] in
            let context = CGContext(data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)!
            context.draw(cgImage, in: CGRect(x: -window.bounds.width / 2, y: -window.bounds.height / 2,
                                           width: window.bounds.width, height: window.bounds.height))
            return Array(buffer)
        }
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        UIColor(Palette.background).resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
            .getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        expect(abs(CGFloat(rgba[0]) / 255 - red) < 0.03 && abs(CGFloat(rgba[1]) / 255 - green) < 0.03
               && abs(CGFloat(rgba[2]) / 255 - blue) < 0.03,
               "\(name) list background matches the page palette: \(rgba)")
    }

    private static func checkPopupSurface(_ style: UIUserInterfaceStyle, size: CGSize) async throws {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let window = scene.windows.first(where: { $0.isKeyWindow }) else { throw CocoaError(.fileReadUnknown) }
        let old = window.rootViewController
        defer { window.rootViewController = old }
        let probe = UIView()
        let fixture = ZStack {
            VStack(spacing: 0) {
                Color.blue
                Color.orange
                Color.green
                Color.purple
            }
            PopupGlassSurface()
                .overlay(VStack(alignment: .leading, spacing: 24) {
                    Text("切换默认模型").font(.system(size: 18, weight: .semibold))
                    Text("GPT-6.1-Sol").font(.system(size: 17))
                    Text("gpt-6.1-sol · 最高").font(.system(size: 14)).foregroundColor(Palette.muted)
                }.foregroundColor(Palette.ink).padding(24))
                .frame(width: size.width, height: size.height)
                .background(PopupFrameProbe(view: probe))
        }
        .ignoresSafeArea()
        .preferredColorScheme(style == .dark ? .dark : .light)
        let host = UIHostingController(rootView: fixture)
        host.overrideUserInterfaceStyle = style
        window.rootViewController = host
        host.view.layoutIfNeeded()
        try await Task.sleep(nanoseconds: 300_000_000)
        let rect = probe.convert(probe.bounds, to: window)
        let name = "\(style == .dark ? "dark" : "light")-\(Int(size.width))x\(Int(size.height))"
        expect(probe.window === window && abs(rect.width - size.width) < 0.5 && abs(rect.height - size.height) < 0.5,
               "\(name) glass preserves the popup's requested size: \(rect)")
        expect(window.bounds.insetBy(dx: 20, dy: 20).contains(rect),
               "\(name) glass remains inside the visible window")
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask,
                                                    appropriateFor: nil, create: true)
        try image.pngData()?.write(to: documents.appendingPathComponent("remediation-popup-\(name).png"))
        print("popup capture=\(name) os=\(UIDevice.current.systemVersion) lowPower=\(ProcessInfo.processInfo.isLowPowerModeEnabled) reduceTransparency=\(UIAccessibility.isReduceTransparencyEnabled)")
    }

    private static func checkBackNavigation() async throws {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let window = scene.windows.first(where: { $0.isKeyWindow }) else { throw CocoaError(.fileReadUnknown) }
        let old = window.rootViewController
        defer { window.rootViewController = old }
        let stack = PageStackController<Int>()
        window.rootViewController = stack
        stack.show(AnyView(Text("Home")), route: 0, depth: 0, animated: false, colorScheme: .light)
        stack.view.layoutIfNeeded()
        try await Task.sleep(nanoseconds: 150_000_000)
        var backs = 0
        let returnHome = {
            backs += 1
            stack.show(AnyView(Text("Home")), route: 0, depth: 0, animated: false, colorScheme: .light)
        }
        stack.backAction = returnHome
        stack.show(AnyView(Text("Computer list")), route: 1, depth: 1, animated: false, colorScheme: .light)
        stack.view.layoutIfNeeded()
        expect(stack.backAvailable, "the root page keeps a parent preview for interactive back")
        expect(stack.beginBack(returnHome), "root back can begin")
        stack.updateBack(0.2)
        expect(!stack.backAvailable, "a second back cannot begin during the first")
        stack.endBack(finish: false)
        try await Task.sleep(nanoseconds: 300_000_000)
        expect(backs == 0 && stack.backAvailable, "cancelled back keeps the current route and re-enables interaction")
        expect(stack.beginBack(returnHome), "back can begin again after cancellation")
        stack.updateBack(0.6)
        stack.endBack(finish: true)
        try await Task.sleep(nanoseconds: 400_000_000)
        expect(backs == 1 && !stack.backAvailable, "committed back changes the route exactly once")

        let navigation = UINavigationController(rootViewController: UIHostingController(rootView: Text("Settings")))
        navigation.setNavigationBarHidden(true, animated: false)
        window.rootViewController = navigation
        let action = PageBackAction()
        var fallbackCalls = 0
        let child = UIHostingController(rootView: Text("General settings")
            .background(PageBackSupport(action: action, enabled: true, onBack: { fallbackCalls += 1 })))
        navigation.pushViewController(child, animated: false)
        child.view.layoutIfNeeded()
        try await Task.sleep(nanoseconds: 250_000_000)
        expect(navigation.interactivePopGestureRecognizer?.isEnabled == true,
               "a hidden navigation bar still enables native interactive pop")
        let allowed = navigation.interactivePopGestureRecognizer.map { gesture in
            gesture.delegate?.gestureRecognizerShouldBegin?(gesture) ?? false
        } ?? false
        expect(allowed, "the production pop delegate allows the visible pushed page")
        action.perform { fallbackCalls += 1 }
        try await Task.sleep(nanoseconds: 450_000_000)
        expect(navigation.viewControllers.count == 1 && fallbackCalls == 0,
               "the custom back button pops the navigation stack instead of dismissing its modal parent")
    }

    private static func descendants(_ controller: UIViewController) -> [UIViewController] {
        // UIKit can expose one presented controller through more than one
        // ancestor. Inventory the controller graph, not each path to a node.
        var seen = Set<ObjectIdentifier>()
        func visit(_ node: UIViewController) -> [UIViewController] {
            guard seen.insert(ObjectIdentifier(node)).inserted else { return [] }
            return [node] + node.children.flatMap(visit) + (node.presentedViewController.map(visit) ?? [])
        }
        return visit(controller)
    }

    /// Controller-level integration, not injected touch events. This covers
    /// cancellation and scanner dismissal using the production page presenter.
    private static func checkPageCovers() async throws {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let window = scene.windows.first(where: { $0.isKeyWindow }) else { throw CocoaError(.fileReadUnknown) }
        let old = window.rootViewController
        defer { window.rootViewController = old }
        let state = CoverFixtureState()
        let host = UIHostingController(rootView: CoverFixture(state: state))
        window.rootViewController = host
        host.view.layoutIfNeeded()
        try await Task.sleep(nanoseconds: 100_000_000)
        state.page = true
        let covers = { descendants(host).compactMap { $0 as? PageBackContainer }.filter { $0.backHost != nil } }
        expect(await waitUntil { covers().first?.backAvailable == true }, "a production page cover finishes presenting")
        guard let parent = covers().first else { throw CocoaError(.fileReadUnknown) }
        let anchors = descendants(parent.backHost!).compactMap { $0 as? PageBackAnchor }
        expect(!anchors.isEmpty, "the covered page installs its production back anchor")
        expect(parent.backHost?.view.gestureRecognizers?.contains(where: { $0 is UIScreenEdgePanGestureRecognizer }) == true,
               "a modal root installs the left-edge recognizer on the visible page")
        expect(parent.beginBack { state.backCalls += 1 }, "a covered page can begin interactive back")
        parent.updateBack(0.2)
        parent.endBack(finish: false)
        expect(await waitUntil { parent.backAvailable }, "cancelling a cover restores its interactive state")
        expect(state.page && state.pageDismissals == 0 && state.backCalls == 0,
               "cancelled cover back changes neither binding nor dismissal callbacks")

        state.camera = true
        expect(await waitUntil { covers().count == 2 && covers().contains(where: { $0 !== parent && $0.backAvailable }) },
               "a scanner child can open over the pair-computer cover")
        expect(!parent.backAvailable, "a parent cannot start back while its scanner child is open")
        expect(parent.backHost?.view.window === window, "scanner presentation retains the pairing parent's view")
        state.scanned = "fixture-pairing-code"
        state.camera = false
        expect(await waitUntil { covers().count == 1 && state.cameraDismissals == 1 },
               "scanner result dismisses its child page exactly once")
        expect(state.page && parent.backAvailable && state.applied == state.scanned,
               "scanner result reaches the still-mounted pairing page after dismissal")

        // Exercise the button's container path, not a mutation of a hidden
        // home view's binding that UIKit may defer until it reappears.
        parent.performBack { state.page = false }
        try await Task.sleep(nanoseconds: 60_000_000)
        state.page = true
        expect(await waitUntil { state.pageDismissals == 1 && covers().count == 1 && parent.backAvailable },
               "rapid close and reopen settles to exactly one interactive cover")
        print("cover rapid reopen: covers=\(covers().count) dismissals=\(state.pageDismissals) scannerDismissals=\(state.cameraDismissals) interactive=\(parent.backAvailable)")
        expect(state.page && state.cameraDismissals == 1, "rapid reopening does not rerun the scanner callback")
        expect(parent.beginBack { state.backCalls += 1 }, "cover back works after rapid reopening")
        parent.updateBack(0.65)
        parent.endBack(finish: true)
        expect(await waitUntil { covers().isEmpty && !state.page }, "committed cover back clears its binding")
        expect(state.backCalls == 1 && state.pageDismissals == 2,
               "committed cover back and dismissal callbacks each fire once")
    }

    private static func captureReferenceScreens() async throws {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let window = scene.windows.first(where: { $0.isKeyWindow }) else { throw CocoaError(.fileReadUnknown) }
        let old = window.rootViewController
        defer { window.rootViewController = old }
        guard UIImage(contentsOfFile: Bundle.main.bundlePath + "/CamelliaBrand.png") != nil else {
            throw CocoaError(.fileReadNoSuchFile)
        }
        let app = AppModel(store: ComputerStore(vault: MemoryCredentialVault()))
        // Activate before supplying the in-memory pairing, so no transport is
        // constructed. Presence probes remain disabled throughout rendering.
        app.remoteScreenChanged(active: true)
        app.checkingComputers = true
        app.setLanguage(.simplifiedChinese)
        app.setTheme(.light)
        app.setDeviceName("14Ultra")
        app.remoteEntryState = .ready
        app.computers = ["HP", "Cheng"].enumerated().map { index, name in
            PairedComputer(address: "http://100.127.255.\(250 - index):43127", name: name,
                           computerName: name, token: "render-only", deviceId: "render-only", permission: .control)
        }
        app.current = app.computers[0]
        app.computerStates = Dictionary(uniqueKeysWithValues: app.computers.map { ($0.address, ComputerStatus.connected) })
        app.access = RemoteAccess(permission: .control, capabilities: [.create, .createWorkspace, .conversationActions])
        app.workspaces = ["ARDS", "TOMA", "cc_memory", "NeuroClaw", "Camellia"].map { RemoteWorkspace(id: $0, name: $0) }
        app.collapsedWorkspaces = Set(app.workspaces.map(\.id))
        app.conversations = [RemoteConversation(JSONObject(dictionary: ["id": "render-chat", "title": "大总管", "seq": 2]))]
        app.includeUnassigned = true
        app.streamState = .connected
        let localRoot = FileManager.default.temporaryDirectory.appendingPathComponent("reference-render-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: localRoot) }
        let keys = FileSecretKeyStore(url: localRoot.appendingPathComponent("key"))
        let blobs = AttachmentStore(directory: localRoot.appendingPathComponent("blobs"), keys: keys)
        let store = try LocalChatStore(directory: localRoot.appendingPathComponent("store"), keys: keys, attachments: blobs)
        let local = LocalChatModel(store: store, attachments: blobs)
        expect(await waitUntil { !local.loading }, "the reference renderer loads only its isolated local store")
        let config = #"{"providers":[{"id":"render","name":"Ollama Cloud","protocol":"openai","baseUrl":"https://invalid.example","keys":[{"key":"render-only"}],"models":[{"id":"render","upstream":"render"}]}]}"#
        let imported = await local.importConfig(try LocalChatConfiguration.export(JSONBody.object(Data(config.utf8)).raw))
        expect(imported == nil, "the reference renderer imports only dummy provider keys")
        if let chat = await local.createConversation(workspace: "") { _ = await local.rename(chat.id, to: "你好") }
        local.close()
        local.notice = nil
        let levels = ["low", "medium", "high", "xhigh", "max", "ultra"]
        let accountModels: [[String: Any]] = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"].map {
            ["id": $0, "name": $0.uppercased(), "connection": "subscription", "thinking": levels]
        }
        let apiModels: [[String: Any]] = ["kimi-k3", "deepseek-v4.1-flash", "glm-5.3", "gpt-6-astra", "gpt-5.6-sol"].map {
            ["id": $0, "name": $0, "connection": "api", "thinking": ["low", "medium", "high"]]
        }
        let snapshot = RemoteSnapshot(JSONObject(dictionary: ["instanceId": "render", "cursor": 1,
            "permission": "control", "conversation": app.conversations[0].json, "nextBefore": NSNull(),
            "messages": [["seq": 1, "role": "user", "text": "我们东大的材料都交了吧"],
                         ["seq": 2, "role": "assistant", "text": "是，两套最新材料都已提交。\n\n- 面试材料包：6 份文件\n- 职称材料包：20 份文件，含申报表、花名册及证明材料\n\n现在等待学院审核反馈。"]],
            "settings": ["version": "render", "editable": true, "modelEditable": true,
                "engine": "codex", "connection": "subscription", "model": "gpt-6.1-sol",
                "thinking": "max", "permissionMode": "full", "models": accountModels + apiModels,
                "quickSwitch": ["model": "gpt-6.1-sol", "thinking": "max", "available": true]]]))
        let detail = AnyView(NavigationView {
            ConversationDetailView(conversation: app.conversations[0], onComputerPickerAction: { _ in })
        }.navigationViewStyle(.stack))
        let localList = AnyView(NavigationView {
            LocalChatListView().safeAreaInset(edge: .top, spacing: 0) {
                HStack(spacing: 10) {
                    RoundBackButton {}
                    RemotePageHeading(title: "本机聊天", computer: "本机 · 手机直连 API", systemImage: "iphone")
                    Spacer(minLength: 0)
                }.padding(.horizontal, PageGutter.horizontal).padding(.vertical, 12)
            }.navigationBarHidden(true)
        }.navigationViewStyle(.stack))
        let scenes: [(String, AnyView)] = [
            ("home", AnyView(HomeView(onLocalChat: {}, onRemoteControl: {}, onSettings: {}, onMobileAccess: {}))),
            ("settings", AnyView(SettingsView(onClose: {}))),
            ("computers", AnyView(ComputersView(onClose: {}))),
            ("local", localList), ("detail", detail),
            ("models", AnyView(detail.overlay(alignment: .bottomTrailing) {
                RemoteSettingsPopupView(mode: .models, maxHeight: max(180, window.bounds.height - 240), onDismiss: {})
                    .frame(width: min(312, window.bounds.width - 24)).padding(.trailing, 12).padding(.bottom, 150)
            })),
            ("permissions", AnyView(detail.overlay(alignment: .bottomTrailing) {
                RemoteSettingsPopupView(mode: .permissions, maxHeight: 500, onDismiss: {})
                    .frame(width: min(312, window.bounds.width - 24)).padding(.trailing, 12).padding(.bottom, 150)
            }))
        ]
        let documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask,
                                                    appropriateFor: nil, create: true)
        for (name, view) in scenes {
            let host = UIHostingController(rootView: view.environmentObject(app).environmentObject(local)
                .environment(\.locale, app.interfaceLocale).preferredColorScheme(.light))
            host.overrideUserInterfaceStyle = .light
            window.rootViewController = host
            host.view.layoutIfNeeded()
            // The real detail's onAppear resets its previous transcript. Prime
            // the isolated renderer after that lifecycle work, never by racing it.
            try await Task.sleep(nanoseconds: 100_000_000)
            if ["detail", "models", "permissions"].contains(name) {
                app.transcript.apply(snapshot)
                app.streamState = .connected
                app.objectWillChange.send()
            }
            try await Task.sleep(nanoseconds: 400_000_000)
            let format = UIGraphicsImageRendererFormat.default(); format.scale = 1
            let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            try image.pngData()?.write(to: documents.appendingPathComponent("reference-\(name).png"))
            expect(host.view.window === window, "reference \(name) renders in the visible window")
            print("reference capture=\(name) size=\(window.bounds.size); controlled production views, no touch or network")
        }
    }

    private static func checkComposerFeedback() async throws {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let window = scene.windows.first(where: { $0.isKeyWindow }) else { throw CocoaError(.fileReadUnknown) }
        let old = window.rootViewController
        defer { window.rootViewController = old }
        for pressed in [false, true] {
            let fixture = ZStack {
                Color.white
                Color(red: 1, green: 0, blue: 0)
                    .overlay(ComposerPressStyle.feedback(isPressed: pressed))
                    .frame(width: 160, height: 48)
            }.ignoresSafeArea().preferredColorScheme(.light)
            let host = UIHostingController(rootView: fixture)
            host.overrideUserInterfaceStyle = .light
            window.rootViewController = host
            host.view.layoutIfNeeded()
            try await Task.sleep(nanoseconds: 200_000_000)
            let format = UIGraphicsImageRendererFormat.default()
            format.scale = 1
            let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            guard let pixelImage = image.cgImage?.cropping(to: CGRect(x: window.bounds.midX,
                y: window.bounds.midY, width: 1, height: 1)) else { throw CocoaError(.fileReadUnknown) }
            var pixel = [UInt8](repeating: 0, count: 4)
            pixel.withUnsafeMutableBytes { buffer in
                let context = CGContext(data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8,
                    bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)!
                context.draw(pixelImage, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            }
            expect(pressed ? (pixel[0] < 250 && pixel[1] > 10 && pixel[2] > 20)
                           : (pixel[0] > 250 && pixel[1] < 5 && pixel[2] < 5),
                   "composer feedback \(pressed ? "shows only while pressed" : "is transparent at rest"): \(pixel)")
        }
    }
}
