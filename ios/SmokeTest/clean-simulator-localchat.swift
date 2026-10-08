import Foundation

/// Removes only the fake provider and empty conversation created during
/// simulator UI testing. Never targets a device or an existing user profile.
@main
enum CleanSimulatorLocalChat {
    static func main() throws {
        guard CommandLine.arguments.count == 3,
              ["--check", "--remove"].contains(CommandLine.arguments[2]) else {
            fatalError("usage: clean-simulator-localchat APP_DATA_CONTAINER --check|--remove")
        }
        let container = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
        guard container.path.contains("/CoreSimulator/Devices/"),
              container.path.contains("/Containers/Data/Application/") else {
            fatalError("only a simulator app data container may be inspected")
        }
        let support = container.appendingPathComponent("Library/Application Support")
        let key = FileSecretKeyStore(url: support.appendingPathComponent("camellia-credentials/credential.key"))
        let store = try LocalChatStore(directory: support.appendingPathComponent("camellia-localchat"), keys: key)

        let config = store.config()
        let providers = config["providers"] as? [[String: Any]] ?? []
        let conversations = store.conversations()
        guard store.workspaces().isEmpty,
              providers.count == 1,
              let provider = providers.first,
              provider["name"] as? String == "UI-only QA",
              provider["baseUrl"] as? String == "https://example.invalid/v1",
              let providerID = provider["id"] as? String,
              let keys = provider["keys"] as? [[String: Any]], keys.count == 1,
              keys[0]["key"] as? String == "sk-ui-only-fake",
              let models = provider["models"] as? [[String: Any]], models.count == 1,
              // The iPad simulator's predictive keyboard dropped the initial
              // "q" during this menu fixture; accept only these two fake IDs.
              ["qa-model", "a-model"].contains((models[0]["id"] as? String)?.lowercased() ?? ""),
              conversations.count == 1,
              let conversation = conversations.first,
              let conversationID = conversation["id"] as? String,
              conversation["title"] as? String == "",
              conversation["draft"] as? String == "",
              (conversation["messages"] as? [Any])?.isEmpty == true else {
            fatalError("refusing to touch a profile with non-fixture local chat data")
        }
        if CommandLine.arguments[2] == "--check" {
            print("found exactly one fake provider and one empty test conversation")
            return
        }
        try store.deleteConversation(conversationID)
        try store.importConfig(LocalProviderEditor.remove(providerID: providerID, from: config))
        print("removed the fake provider and empty test conversation")
    }
}
