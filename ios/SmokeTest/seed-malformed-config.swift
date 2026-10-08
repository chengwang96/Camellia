import Foundation

/// A disposable simulator fixture for a stored provider config that no longer parses.
@main
enum SeedMalformedConfig {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else {
            fatalError("usage: seed-malformed-config APP_DATA_CONTAINER")
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

        _ = try store.createConversation(workspaceId: "", routeId: "qa-invalid/model")
        try store.importConfig(["providers": [[
            "id": "qa-invalid",
            "protocol": "invalid-protocol",
            "baseUrl": "https://example.invalid/v1",
            "keys": [Any](),
            "models": [Any](),
        ]]])
        do {
            _ = try LocalChatConfiguration.routes(store.config())
            fatalError("fixture did not trigger a route parser failure")
        } catch LocalChatConfigError.unsupportedProtocol {
            print("seeded one empty conversation and an invalid stored provider protocol")
        }
    }
}
