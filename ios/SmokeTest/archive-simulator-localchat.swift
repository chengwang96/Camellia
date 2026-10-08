import Foundation

/// Exercises the archived screen with the single throwaway iPhone simulator
/// fixture. Every write refuses a profile containing anything else.
@main
enum ArchiveSimulatorLocalChat {
    static func main() throws {
        guard CommandLine.arguments.count == 3,
              ["--inspect", "--check", "--reset-test-send", "--archive", "--restore"].contains(CommandLine.arguments[2]) else {
            fatalError("usage: archive-simulator-localchat APP_DATA_CONTAINER --inspect|--check|--reset-test-send|--archive|--restore")
        }
        let container = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
        guard container.path.contains("/CoreSimulator/Devices/"),
              container.path.contains("/Containers/Data/Application/") else {
            fatalError("only a simulator app data container may be inspected")
        }
        let support = container.appendingPathComponent("Library/Application Support")
        let key = FileSecretKeyStore(url: support.appendingPathComponent("camellia-credentials/credential.key"))
        let store = try LocalChatStore(directory: support.appendingPathComponent("camellia-localchat"), keys: key)
        let providers = store.config()["providers"] as? [[String: Any]] ?? []
        let conversations = store.conversations()
        if CommandLine.arguments[2] == "--inspect" {
            print("workspaces=\(store.workspaces().count) providers=\(providers.count) conversations=\(conversations.count)")
            for provider in providers {
                print("provider name=\(provider["name"] as? String ?? "") host=\(URL(string: provider["baseUrl"] as? String ?? "")?.host ?? "") keyCount=\((provider["keys"] as? [Any])?.count ?? 0) modelCount=\((provider["models"] as? [Any])?.count ?? 0)")
            }
            for conversation in conversations {
                print("conversation title=\(conversation["title"] as? String ?? "") draftLength=\((conversation["draft"] as? String ?? "").count) messages=\((conversation["messages"] as? [Any])?.count ?? 0) archived=\(conversation["archived"] as? Bool ?? false)")
            }
            return
        }
        guard store.workspaces().isEmpty,
              providers.count == 1,
              let provider = providers.first,
              provider["name"] as? String == "UI Archive Test",
              provider["baseUrl"] as? String == "https://example.invalid/v1",
              let keys = provider["keys"] as? [[String: Any]], keys.count == 1,
              keys[0]["key"] as? String == "q",
              let models = provider["models"] as? [[String: Any]], models.count == 1,
              models[0]["id"] as? String == "Q",
              conversations.count == 1,
              let conversation = conversations.first,
              let id = conversation["id"] as? String else {
            fatalError("refusing to touch a profile with non-fixture local chat data")
        }
        let messages = (conversation["messages"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
        let empty = messages.isEmpty
            && (conversation["title"] as? String ?? "").isEmpty
            && (conversation["draft"] as? String ?? "").isEmpty
        let testSend = messages.count == 2
            && messages[0]["role"] as? String == "user"
            && messages[0]["content"] as? String == "UI-only draft line 1"
            && messages[1]["role"] as? String == "assistant"
            && (messages[1]["content"] as? String ?? "").isEmpty
            && messages[1]["state"] as? String == "interrupted"
            && conversation["title"] as? String == "UI-only draft line 1"
            && ["", "line 2"].contains(conversation["draft"] as? String ?? "")
        guard empty || testSend else {
            fatalError("refusing to touch a conversation with non-fixture content")
        }
        switch CommandLine.arguments[2] {
        case "--check":
            print("fixture=\(empty ? "empty" : "test-send") archived=\(conversation["archived"] as? Bool ?? false)")
        case "--reset-test-send":
            guard testSend else { fatalError("only the exact test send can be reset") }
            try store.update(id) { entry in
                entry["title"] = ""
                entry["messages"] = [Any]()
                entry["draft"] = ""
                entry["thinking"] = ""
            }
            print("reset only the exact test send")
        case "--archive":
            guard empty else { fatalError("reset the test send first") }
            try store.archiveConversation(id, archived: true)
            print("archived the empty fixture")
        case "--restore":
            guard empty else { fatalError("reset the test send first") }
            try store.archiveConversation(id, archived: false)
            print("restored the empty fixture")
        default:
            fatalError("unreachable")
        }
    }
}
