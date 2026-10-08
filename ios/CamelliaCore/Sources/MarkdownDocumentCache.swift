import Foundation

/// Confined to the serial Markdown worker. Keys are hashed there, never in
/// View.body. Only completed versions enter this byte- and entry-bounded cache.
final class MarkdownDocumentCache: @unchecked Sendable {
    private struct Entry { let document: MarkdownDocument; let bytes: Int }
    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    private let maximumBytes: Int
    private let maximumEntries: Int
    private(set) var bytes = 0
    var count: Int { entries.count }

    init(maximumBytes: Int = 4 * 1024 * 1024, maximumEntries: Int = 64) {
        self.maximumBytes = maximumBytes
        self.maximumEntries = maximumEntries
    }

    func document(for source: String) -> MarkdownDocument? {
        guard let entry = entries[source] else { return nil }
        order.removeAll { $0 == source }; order.append(source)
        return entry.document
    }

    func insert(_ document: MarkdownDocument) {
        let source = document.source
        let cost = 128 + source.utf8.count * 2 + document.blocks.reduce(0) { $0 + Self.cost($1) }
        if let old = entries.removeValue(forKey: source) { bytes -= old.bytes }
        order.removeAll { $0 == source }
        guard cost <= maximumBytes, maximumEntries > 0 else { return }
        while bytes + cost > maximumBytes || entries.count >= maximumEntries {
            guard !order.isEmpty else { break }
            let key = order.removeFirst()
            if let old = entries.removeValue(forKey: key) { bytes -= old.bytes }
        }
        entries[source] = Entry(document: document, bytes: cost)
        order.append(source)
        bytes += cost
    }

    private static func cost(_ block: MarkdownBlock) -> Int {
        let extra: Int
        switch block {
        case .paragraph(let nodes), .heading(_, let nodes): extra = nodes.reduce(0) { $0 + cost($1) }
        case .code(let language, let text): extra = (language.utf8.count + text.utf8.count) * 2
        case .list(_, _, let items): extra = items.reduce(0) { $0 + $1.reduce(0) { $0 + cost($1) } }
        case .quote(let blocks): extra = blocks.reduce(0) { $0 + cost($1) }
        case .table(let rows):
            extra = rows.reduce(0) { $0 + $1.reduce(0) { $0 + MemoryLayout<MarkdownCell>.stride + $1.inline.reduce(0) { $0 + cost($1) } } }
        case .divider: extra = 0
        }
        return MemoryLayout<MarkdownBlock>.stride * 2 + extra + 32
    }

    private static func cost(_ node: MarkdownInline) -> Int {
        let extra: Int
        switch node {
        case .text(let value), .code(let value): extra = value.utf8.count * 2
        case .strong(let nodes), .emphasis(let nodes), .strikethrough(let nodes): extra = nodes.reduce(0) { $0 + cost($1) }
        case .link(let destination, let nodes), .image(let nodes, let destination):
            extra = destination.utf8.count * 2 + nodes.reduce(0) { $0 + cost($1) }
        case .lineBreak: extra = 0
        }
        return MemoryLayout<MarkdownInline>.stride * 2 + extra + 32
    }
}
