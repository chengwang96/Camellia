import Foundation
import SwiftUI
import UIKit
import CryptoKit

/// Runs production model transitions in a separate simulator app/container.
@main
struct CamelliaRemediationCheck: App {
    var body: some Scene {
        WindowGroup {
            Text("Camellia remediation checks").onAppear { Task { await RemediationChecks.run() } }
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

@MainActor
private enum RemediationChecks {
    private static var failures: [String] = []
    private static var count = 0
    private static var started = false

    private static func expect(_ value: Bool, _ label: String) {
        count += 1
        if !value { failures.append(label) }
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
        } catch { failures.append("unexpected error: \(error)") }
        for failure in failures { print("FAIL: \(failure)") }
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
}
