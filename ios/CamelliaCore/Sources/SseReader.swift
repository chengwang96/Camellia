import Foundation

public enum SseError: Error, Equatable, CustomStringConvertible {
    case eventTooLarge(String)

    public var description: String {
        switch self {
        case .eventTooLarge(let what): return "Event exceeds the size limit (\(what))"
        }
    }
}

/// Incremental Server-Sent Events reader for the snapshot stream.
///
/// Ported from `SseReader.java`. The gateway sends whole snapshots rather than
/// deltas, and the desktop wraps each one as `event: snapshot` with a single
/// `data:` line, so this reader:
///
/// * splits lines on `LF` and tolerates a trailing `CR`
/// * strips at most one leading space after `event:` and `data:`
/// * ignores every event type except `snapshot`
/// * joins multiple `data:` lines with `LF` and drops the final one
/// * refuses to emit a trailing line that never received a newline, which keeps
///   a truncated stream from being mistaken for a complete snapshot
/// * caps a single line and a single event at 8,388,608 UTF-16 units
///
/// It consumes raw bytes rather than decoded text. Splitting on `0x0A` before
/// decoding is safe because UTF-8 is self-synchronising, so a multi-byte
/// character can never be cut in half, and it matches how `URLSession` hands
/// over `AsyncBytes`. Invalid sequences are replaced rather than thrown, which
/// is what Java's default `InputStreamReader` does on the Android side.
public struct SseReader: Sendable {
    public static let limit = 8 * 1024 * 1024

    private var line: [UInt8] = []
    private var data = ""
    private var dataLength = 0
    private var type = ""

    public init() {}

    /// Feeds the next chunk and returns any snapshots it completed.
    public mutating func consume(_ bytes: some Sequence<UInt8>) throws -> [String] {
        var snapshots: [String] = []
        for byte in bytes {
            guard byte == 0x0A else {
                line.append(byte)
                // A UTF-8 scalar uses at most four bytes; keep a raw memory
                // bound without rejecting multi-byte text before decoding.
                if line.count > Self.limit * 4 { throw SseError.eventTooLarge("line") }
                continue
            }
            var value = String(decoding: line, as: UTF8.self)
            line.removeAll(keepingCapacity: true)
            if value.utf16.count > Self.limit { throw SseError.eventTooLarge("line") }
            if value.hasSuffix("\r") { value.removeLast() }

            if value.isEmpty {
                if type == "snapshot", !data.isEmpty {
                    snapshots.append(String(data.dropLast()))
                }
                data = ""
                dataLength = 0
                type = ""
            } else if value.hasPrefix("event:") {
                type = Self.field(String(value.dropFirst(6)))
            } else if value.hasPrefix("data:") {
                let field = Self.field(String(value.dropFirst(5)))
                data += field
                data.append("\n")
                dataLength += field.utf16.count + 1
                if dataLength > Self.limit { throw SseError.eventTooLarge("event") }
            }
        }
        return snapshots
    }

    /// Strips at most one leading space, as the event-stream grammar requires.
    private static func field(_ value: String) -> String {
        value.hasPrefix(" ") ? String(value.dropFirst()) : value
    }
}
