#if targetEnvironment(simulator)
import SwiftUI

/// Real root/list/detail views over an isolated store, for touch interaction QA.
struct LocalListFixtureView: View {
    @StateObject private var app = AppModel(store: ComputerStore(vault: MemoryCredentialVault()))
    @StateObject private var model: LocalChatModel
    @State private var seeded = false

    init() {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ui-local-\(UUID().uuidString)")
        let keys = FileSecretKeyStore(url: root.appendingPathComponent("key"))
        let attachments = AttachmentStore(directory: root.appendingPathComponent("blobs"), keys: keys)
        let store = try! LocalChatStore(directory: root.appendingPathComponent("store"), keys: keys,
                                       attachments: attachments)
        _model = StateObject(wrappedValue: LocalChatModel(store: store, attachments: attachments))
    }

    var body: some View {
        RootView(appModel: app, localModel: model)
            .task {
                guard !seeded else { return }
                seeded = true
                let raw = #"{"providers":[{"id":"ui","name":"UI fixture","protocol":"openai","baseUrl":"https://invalid.example","keys":[{"key":"ui-only"}],"models":[{"id":"fixture","upstream":"fixture"}]}]}"#
                let config = try! LocalChatConfiguration.export(JSONBody.object(Data(raw.utf8)).raw)
                _ = await model.importConfig(config)
                if let first = await model.createConversation(workspace: "") {
                    _ = await model.rename(first.id, to: "Local interaction check")
                }
                if let second = await model.createConversation(workspace: "") {
                    _ = await model.rename(second.id, to: "Draft persistence check")
                }
            }
    }
}
#endif
