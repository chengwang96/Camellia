import Foundation

/// A disposable simulator profile for the send-time missing-attachment path.
@main
enum SeedMissingAttachment {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else {
            fatalError("usage: seed-missing-attachment APP_DATA_CONTAINER")
        }
        let container = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
        guard container.path.contains("/CoreSimulator/Devices/"),
              container.path.contains("/Containers/Data/Application/") else {
            fatalError("only a simulator app data container may be seeded")
        }

        let support = container.appendingPathComponent("Library/Application Support")
        let key = FileSecretKeyStore(url: support.appendingPathComponent("camellia-credentials/credential.key"))
        let store = try LocalChatStore(directory: support.appendingPathComponent("camellia-localchat"), keys: key)
        guard store.config().isEmpty, store.workspaces().isEmpty, store.conversations().isEmpty else {
            fatalError("refusing to change a non-empty local-chat profile")
        }

        let config: [String: Any] = ["providers": [[
            "id": "qa-missing",
            "name": "UI-only QA",
            "protocol": "openai",
            "baseUrl": "https://example.invalid/v1",
            "keys": [["id": "key-qa", "key": "q", "enabled": true]],
            "models": [["id": "Q", "upstream": "Q"]],
        ]]]
        let route = try LocalChatConfiguration.routes(config).first!
        try store.importConfig(config)
        let created = try store.createConversation(workspaceId: "", routeId: route.id)
        let id = created["id"] as! String
        try store.update(id) { conversation in
            LocalChatDraft.save(&conversation, text: "", editIndex: nil,
                                images: ["camellia-blob:00000000-0000-0000-0000-000000000000"],
                                documents: [])
        }
        print("seeded one empty conversation with a missing image reference; no real API key or network request")
    }
}
