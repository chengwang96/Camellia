import Foundation

/// The running record of what the diagnostics app did.
///
/// A test build is only as good as its evidence. A real device has no console
/// to read, and the interesting failures — the node refusing to start, a
/// request that never gets an answer, a stream that ends badly — all happen off
/// the main thread, so every step worth knowing about is appended here and
/// shown on the log tab where it can be copied out.
final class DiagnosticsLog: ObservableObject {
    static let shared = DiagnosticsLog()

    struct Line: Identifiable {
        enum Level {
            /// A step that happened.
            case plain
            /// The outcome wanted.
            case good
            /// An outcome that needs reading.
            case bad
        }

        let id = UUID()
        let at: Date
        let level: Level
        let text: String
    }

    /// Bounded, because the node retries in a loop while it waits for a sign-in
    /// and a session left open overnight would otherwise grow without limit.
    private static let limit = 500

    @Published private(set) var lines: [Line] = []

    private init() {}

    /// Appends a line. Callable from any thread: the node's worker threads log
    /// from off the main queue, so the array itself is only ever touched there.
    func note(_ text: String, _ level: Line.Level = .plain) {
        // Mirrored to the console as well as the log tab. On a device the
        // system log is where these land; on the simulator `simctl launch
        // --console` shows them, which is how a run is checked without a phone
        // in hand. Written to stderr rather than through `print`, because
        // stdout is block-buffered when it is not a terminal and a run would
        // otherwise show nothing until the app exits.
        FileHandle.standardError.write(Data("[camellia] \(text)\n".utf8))
        let line = Line(at: Date(), level: level, text: text)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.lines.append(line)
            if self.lines.count > Self.limit {
                self.lines.removeFirst(self.lines.count - Self.limit)
            }
        }
    }

    func clear() {
        DispatchQueue.main.async { [weak self] in self?.lines = [] }
    }

    /// The whole log as text, for pasting into a message.
    func transcript() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return lines.map { "\(formatter.string(from: $0.at))  \($0.text)" }.joined(separator: "\n")
    }
}
