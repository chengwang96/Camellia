import Foundation

/// Adds one UI-only computer to a fresh simulator app container. It has no
/// token, so it cannot send a request or impersonate a paired device. The
/// purpose is to exercise the computer list and its management dialogs without
/// a desktop. `--remove` clears only this token-free fixture after the UI check.
@main
enum SeedSimulatorComputer {
    static func main() throws {
        guard (2...3).contains(CommandLine.arguments.count),
              CommandLine.arguments.count == 2 || CommandLine.arguments[2] == "--remove" else {
            fatalError("usage: seed-simulator-computer APP_DATA_CONTAINER [--remove]")
        }
        let container = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
        guard container.path.contains("/CoreSimulator/Devices/"),
              container.path.contains("/Containers/Data/Application/") else {
            fatalError("only a simulator app data container may be seeded")
        }
        let directory = container.appendingPathComponent("Library/Application Support")
            .appendingPathComponent("camellia-credentials")
        let credential = directory.appendingPathComponent("credential.json")
        let key = FileSecretKeyStore(url: directory.appendingPathComponent("credential.key"))
        let store = ComputerStore(vault: SealedCredentialVault(url: credential, keys: key))
        let address = "http://100.64.0.1:43127"
        if CommandLine.arguments.count == 3 {
            guard let fixture = try store.all().first(where: { $0.address == address }),
                  fixture.deviceId == "ui-only", fixture.token == nil else {
                fatalError("refusing to remove a non-fixture computer")
            }
            try store.remove(address)
            print("removed the token-free simulator fixture")
            return
        }
        guard try store.all().isEmpty, try store.current().address.isEmpty else {
            fatalError("refusing to seed a container that already holds a computer or pairing")
        }
        try store.save(PairedComputer(address: address,
                                      name: "UI test", computerName: "UI Test Computer",
                                      deviceId: "ui-only"))
        print("seeded a token-free computer at \(credential.path)")
    }
}
