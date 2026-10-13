import Foundation

/// Android's bounded older-history batch, independent of the visible window.
/// Process-only pages continue automatically, but never beyond eight requests.
public struct RemoteHistoryPage: Sendable {
    public static let maximumRows = 600
    public static let maximumBytes = 4 * 1024 * 1024
    public static let maximumPages = 8

    public enum Failure: LocalizedError {
        case invalidPage, oversizedRecord
        public var errorDescription: String? {
            switch self {
            case .invalidPage: return "电脑返回了无法继续的消息分页。"
            case .oversizedRecord: return "更早消息中的单条记录超过显示上限。"
            }
        }
    }

    private var known: Set<Int64>
    private var rows: [Int64: RemoteMessage] = [:]
    private var bytes = 0
    private var pages = 0
    private var visible = 0
    public private(set) var limited = false
    public private(set) var nextBefore: Int64?
    public var messages: [RemoteMessage] { rows.keys.sorted().compactMap { rows[$0] } }
    public var needsNext: Bool {
        visible == 0 && nextBefore != nil && !limited && pages < Self.maximumPages
    }

    public init(cached: Set<Int64>, before: Int64) {
        known = cached
        nextBefore = before
    }

    public mutating func append(_ snapshot: RemoteSnapshot, before: Int64) throws {
        guard snapshot.hasHistoryPage,
              snapshot.messages.allSatisfy({ $0.seq > 0 && $0.seq < before }) else {
            throw Failure.invalidPage
        }
        if let next = snapshot.nextBefore,
           next <= 0 || next >= before || snapshot.messages.isEmpty {
            throw Failure.invalidPage
        }
        for row in snapshot.messages.reversed() {
            if known.contains(row.seq) { continue }
            let weight = Self.weight(row)
            guard weight <= Self.maximumBytes else { throw Failure.oversizedRecord }
            if atLimit || bytes + weight > Self.maximumBytes { limited = true; break }
            known.insert(row.seq)
            rows[row.seq] = row
            bytes += weight
            if row.role != .tool { visible += 1 }
        }
        pages += 1
        // A partial terminal page still has unread rows. Resume at the oldest
        // admitted record instead of accepting the server's terminal cursor.
        nextBefore = limited ? rows.keys.min() : snapshot.nextBefore
        if nextBefore != nil && atLimit { limited = true }
    }

    private var atLimit: Bool { rows.count >= Self.maximumRows || bytes >= Self.maximumBytes }

    static func weight(_ row: RemoteMessage) -> Int {
        48 + row.text.utf16.count + row.process.reduce(0) {
            $0 + 32 + $1.text.utf16.count + $1.input.utf16.count
        }
    }
}
