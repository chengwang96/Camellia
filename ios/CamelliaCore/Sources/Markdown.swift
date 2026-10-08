import Foundation

// A small block-and-inline Markdown reader.
//
// Android renders assistant prose with commonmark, which has no equivalent in
// the iOS SDK. `AttributedString(markdown:)` exists from iOS 15 but cannot
// produce the pieces the client actually needs: it has no notion of a table,
// and a fenced block comes back as styled text with no way to attach a copy
// button or a word-wrap toggle. So the markup is read here instead, into a
// value the views can lay out themselves.
//
// Nothing in this file touches UIKit or SwiftUI, which is the point: the same
// parser is compiled by `check-protocol.sh` against the host toolchain, so the
// awkward inputs get tested rather than discovered on a device.

/// One piece of text inside a line.
public enum MarkdownInline: Equatable, Sendable {
    case text(String)
    case code(String)
    case strong([MarkdownInline])
    case emphasis([MarkdownInline])
    case strikethrough([MarkdownInline])
    case link(destination: String, children: [MarkdownInline])
    case image(alt: [MarkdownInline], destination: String)
    case lineBreak

    /// The words as they should be read aloud or copied.
    public var plainText: String {
        switch self {
        case .text(let value), .code(let value): return value
        case .strong(let children), .emphasis(let children),
             .strikethrough(let children), .link(_, let children),
             .image(let children, _):
            return children.map(\.plainText).joined()
        case .lineBreak: return "\n"
        }
    }

    /// Whether the markup contributes nothing visible.
    public var isEmpty: Bool {
        if case .text(let value) = self, value.isEmpty { return true }
        if case .code(let value) = self, value.isEmpty { return true }
        return false
    }
}

/// Where the text inside a table cell sits.
public enum MarkdownAlignment: String, Equatable, Sendable {
    case start
    case center
    case end
}

public struct MarkdownCell: Equatable, Sendable {
    public var inline: [MarkdownInline]
    public var header: Bool
    public var alignment: MarkdownAlignment

    public init(inline: [MarkdownInline], header: Bool = false, alignment: MarkdownAlignment = .start) {
        self.inline = inline
        self.header = header
        self.alignment = alignment
    }
}

/// One block of a document.
public enum MarkdownBlock: Equatable, Sendable {
    case heading(level: Int, inline: [MarkdownInline])
    case paragraph([MarkdownInline])
    case code(language: String, text: String)
    /// `items` holds the blocks of each list item, so a paragraph inside a
    /// list item keeps its own shape.
    case list(ordered: Bool, start: Int, items: [[MarkdownBlock]])
    case quote([MarkdownBlock])
    case divider
    case table(rows: [[MarkdownCell]])
    public var plainText: String {
        switch self {
        case .heading(_, let inline), .paragraph(let inline):
            return inline.map(\.plainText).joined()
        case .code(_, let text): return text
        case .list(_, _, let items):
            return items.map { $0.map(\.plainText).joined(separator: " ") }.joined(separator: "\n")
        case .quote(let blocks): return blocks.map(\.plainText).joined(separator: "\n")
        case .divider: return ""
        case .table(let rows):
            return rows.map { row in row.map { $0.inline.map(\.plainText).joined() }.joined(separator: " | ") }
                .joined(separator: "\n")
        }
    }
}

/// A document, or the plain text it fell back to.
///
/// `truncated` mirrors what Android does when commonmark produces more nodes
/// than it is willing to lay out: the markup is abandoned and the source is
/// shown verbatim. A model that emits a pathological wall of markup therefore
/// degrades to something readable instead of hanging the thread.
public struct MarkdownDocument: Equatable, Sendable {
    public let blocks: [MarkdownBlock]
    public let truncated: Bool
    public let source: String

    public init(blocks: [MarkdownBlock], truncated: Bool = false, source: String = "") {
        self.blocks = blocks
        self.truncated = truncated
        self.source = source
    }

    /// What a view should draw: the parsed blocks, or the source as one
    /// paragraph when parsing was abandoned.
    public var displayed: [MarkdownBlock] {
        truncated ? [.paragraph([.text(source)])] : blocks
    }

    /// Everything as one string: what gets copied or read by a screen reader.
    public var plainText: String {
        truncated ? source : blocks.map(\.plainText).joined(separator: "\n\n")
    }

    public var isEmpty: Bool { blocks.isEmpty && !truncated }
}

public enum MarkdownParser {
    /// Guards that match Android's `RenderLimit`.
    static let blockLimit = 1200
    static let depthLimit = 24
    static let inlineDepthLimit = 64
    static let columnLimit = 32
    static let cellLimit = 1600
    static let inlineNodeLimit = 10_000
    public static let maximumSourceBytes = 1024 * 1024

    public static func parse(_ source: String, isCancelled: @escaping () -> Bool = { Task.isCancelled }) -> MarkdownDocument {
        guard source.utf8.count <= maximumSourceBytes, !isCancelled() else {
            return MarkdownDocument(blocks: [], truncated: true, source: source)
        }
        let context = MarkdownReadContext(isCancelled: isCancelled)
        var reader = BlockReader(source, context: context)
        do {
            let blocks = try reader.document()
            return MarkdownDocument(blocks: blocks, truncated: context.exhausted || isCancelled(), source: source)
        } catch {
            return MarkdownDocument(blocks: [], truncated: true, source: source)
        }
    }
}

/// Thrown when the input is larger than the layout will accept.
struct MarkdownLimit: Error {}

private final class MarkdownReadContext {
    let isCancelled: () -> Bool
    var nodes = 0
    var exhausted = false
    init(isCancelled: @escaping () -> Bool) { self.isCancelled = isCancelled }
    func available() -> Bool {
        if nodes >= MarkdownParser.inlineNodeLimit || isCancelled() { exhausted = true; return false }
        return true
    }
}

// MARK: - Blocks

private struct BlockReader {
    private let lines: [Substring]
    private var at = 0
    private var blocks = 0
    private let context: MarkdownReadContext
    private let depth: Int

    init(_ source: String, context: MarkdownReadContext, depth: Int = 0) {
        // Splitting once up front keeps every later step a slice lookup rather
        // than a scan for the next newline.
        lines = source.split(separator: "\n", omittingEmptySubsequences: false)
        self.context = context
        self.depth = depth
    }

    mutating func document() throws -> [MarkdownBlock] {
        guard depth <= MarkdownParser.depthLimit, context.available() else { throw MarkdownLimit() }
        var result: [MarkdownBlock] = []
        while at < lines.count {
            guard context.available() else { throw MarkdownLimit() }
            let line = lines[at]
            if line.trimmingCharacters(in: .whitespaces).isEmpty { at += 1; continue }
            result.append(contentsOf: try block())
        }
        return result
    }

    private mutating func count() throws {
        blocks += 1
        if blocks > MarkdownParser.blockLimit { throw MarkdownLimit() }
    }

    private mutating func block() throws -> [MarkdownBlock] {
        let line = lines[at]
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
            try count()
            return [try fenced(closer: String(trimmed.prefix(3)))]
        }
        if trimmed.hasPrefix("#") { try count(); return [heading(trimmed)] }
        if trimmed.hasPrefix(">") { try count(); return [try quote()] }
        if isDivider(trimmed) { try count(); at += 1; return [.divider] }
        if isTableStart() { try count(); return [try table()] }
        if listMarker(trimmed) != nil { try count(); return [try list()] }
        try count()
        return [.paragraph(paragraph())]
    }

    // MARK: Code

    private mutating func fenced(closer: String) throws -> MarkdownBlock {
        let info = String(lines[at].trimmingCharacters(in: .whitespaces).dropFirst(3))
        at += 1
        var body: [String] = []
        while at < lines.count {
            let line = lines[at]
            at += 1
            if line.trimmingCharacters(in: .whitespaces).hasPrefix(closer) { break }
            body.append(String(line))
        }
        let language = info.split(separator: " ", omittingEmptySubsequences: true).first.map(String.init) ?? ""
        return .code(language: language, text: body.joined(separator: "\n"))
    }

    // MARK: Heading

    private mutating func heading(_ trimmed: String) -> MarkdownBlock {
        var level = 0
        for character in trimmed {
            if character == "#" { level += 1 } else { break }
        }
        let body = trimmed.dropFirst(level)
        // A run of seven hashes is not a heading at all, which is commonmark's
        // rule and keeps "####### text" from becoming an invisible level.
        if level > 6 { at += 1; return .paragraph(MarkdownInlineReader.parse(stripClosingHashes(body), context: context)) }
        at += 1
        return .heading(level: level, inline: MarkdownInlineReader.parse(String(stripClosingHashes(body)), context: context))
    }

    private func stripClosingHashes(_ body: Substring) -> String {
        var text = String(body)
        while text.hasSuffix("#") { text.removeLast() }
        return text.trimmingCharacters(in: .whitespaces)
    }

    // MARK: Quote

    private mutating func quote() throws -> MarkdownBlock {
        var collected: [String] = []
        while at < lines.count {
            let line = lines[at]
            if !line.trimmingCharacters(in: .whitespaces).hasPrefix(">") { break }
            let body = line.drop(while: { $0 == " " || $0 == "\t" })
            collected.append(String(body.dropFirst().drop(while: { $0 == " " })))
            at += 1
            // A blank line ends the quote unless the next line keeps quoting.
            if at < lines.count,
               lines[at].trimmingCharacters(in: .whitespaces).isEmpty,
               at + 1 < lines.count,
               lines[at + 1].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                at += 1
            }
        }
        var inner = BlockReader(collected.joined(separator: "\n"), context: context, depth: depth + 1)
        return .quote(try inner.document())
    }

    // MARK: Dividers

    private func isDivider(_ trimmed: String) -> Bool {
        guard trimmed.count >= 3 else { return false }
        let allowed: Set<Character> = ["-", "*", "_", " "]
        guard trimmed.allSatisfy({ allowed.contains($0) }) else { return false }
        let marks = trimmed.filter { $0 != " " }
        guard marks.count >= 3, Set(marks).count == 1 else { return false }
        return true
    }

    // MARK: Lists

    /// Returns the marker if the line opens a list item, plus its indent.
    private func listMarker(_ line: String) -> (ordered: Bool, indent: Int, text: Substring)? {
        var index = line.startIndex
        var indent = 0
        while index < line.endIndex, line[index] == " " { indent += 1; index = line.index(after: index) }
        guard index < line.endIndex else { return nil }
        let rest = line[index...]
        if let first = rest.first, first == "-" || first == "*" || first == "+" {
            let after = rest.index(after: rest.startIndex)
            guard after < rest.endIndex, rest[after] == " " || after == rest.endIndex else { return nil }
            return (false, indent, rest.dropFirst(1))
        }
        var digits = 0
        var scan = index
        while scan < line.endIndex, line[scan].isNumber { digits += 1; scan = line.index(after: scan) }
        guard digits > 0, digits <= 9, scan < line.endIndex, line[scan] == "." || line[scan] == ")" else { return nil }
        let after = line.index(after: scan)
        guard after < line.endIndex, line[after] == " " else { return nil }
        return (true, indent, line[after...])
    }

    private mutating func list() throws -> MarkdownBlock {
        let first = lines[at]
        guard let marker = listMarker(String(first)) else {
            at += 1
            return .paragraph([])
        }
        let ordered = marker.ordered
        let start = ordered ? Int(String(first.trimmingCharacters(in: .whitespaces).prefix(while: \.isNumber))) ?? 1 : 0
        var items: [[MarkdownBlock]] = []
        var current: [String] = []

        func flush() throws {
            guard !current.isEmpty else { return }
            try count()
            var inner = BlockReader(current.joined(separator: "\n"), context: context, depth: depth + 1)
            items.append(try inner.document())
            current = []
        }

        while at < lines.count {
            let line = lines[at]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                // A blank line continues the item only if the next line is
                // indented under it, otherwise the list ends.
                if at + 1 < lines.count,
                   listMarker(String(lines[at + 1])) != nil || lines[at + 1].hasPrefix("  ") {
                    current.append("")
                    at += 1
                    continue
                }
                break
            }
            if let nested = listMarker(trimmed), nested.ordered == ordered {
                try flush()
                // The space after the marker is part of the marker, not of the
                // item: leaving it in would indent every row of the list.
                current.append(String(nested.text.drop(while: { $0 == " " || $0 == "\t" })))
                at += 1
                continue
            }
            if line.hasPrefix(" ") || line.hasPrefix("\t") {
                current.append(String(line.drop(while: { $0 == " " || $0 == "\t" })))
                at += 1
                continue
            }
            break
        }
        try flush()
        return .list(ordered: ordered, start: start, items: items)
    }

    // MARK: Tables

    private func isTableStart() -> Bool {
        guard at + 1 < lines.count else { return false }
        let head = lines[at]
        guard head.contains("|") else { return false }
        return isTableDivider(String(lines[at + 1]))
    }

    private func isTableDivider(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("|"), trimmed.contains("-") else { return false }
        let allowed: Set<Character> = ["|", "-", ":", " "]
        return trimmed.allSatisfy { allowed.contains($0) }
    }

    private mutating func table() throws -> MarkdownBlock {
        let header = cells(String(lines[at]))
        at += 1
        let alignments = cells(String(lines[at])).map(alignment)
        at += 1
        var rows: [[MarkdownCell]] = []
        rows.append(zip(header, alignments).map { MarkdownCell(inline: MarkdownInlineReader.parse($0, context: context), header: true, alignment: $1) })
        var cells_ = header.count
        while at < lines.count {
            let line = lines[at]
            if line.trimmingCharacters(in: .whitespaces).isEmpty { break }
            guard line.contains("|") else { break }
            let values = cells(String(line))
            try count()
            cells_ += values.count
            if cells_ > MarkdownParser.cellLimit || header.count > MarkdownParser.columnLimit { throw MarkdownLimit() }
            let row = zip(values, alignments).map { MarkdownCell(inline: MarkdownInlineReader.parse($0, context: context), alignment: $1) }
            rows.append(row)
            at += 1
        }
        return .table(rows: rows)
    }

    private func cells(_ line: String) -> [String] {
        var text = line.trimmingCharacters(in: .whitespaces)
        // A leading and trailing pipe is decoration, not an empty column.
        if text.hasPrefix("|") { text.removeFirst() }
        if text.hasSuffix("|") { text.removeLast() }
        return text.split(separator: "|", omittingEmptySubsequences: false).map { String($0).trimmingCharacters(in: .whitespaces) }
    }

    private func alignment(_ spec: String) -> MarkdownAlignment {
        let trimmed = spec.trimmingCharacters(in: .whitespaces)
        let left = trimmed.hasPrefix(":")
        let right = trimmed.hasSuffix(":")
        if left && right { return .center }
        if right { return .end }
        return .start
    }

    // MARK: Paragraphs

    private mutating func paragraph() -> [MarkdownInline] {
        var collected: [String] = []
        while at < lines.count {
            let line = lines[at]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { break }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") || trimmed.hasPrefix("#")
                || trimmed.hasPrefix(">") || isDivider(trimmed) || listMarker(trimmed) != nil || isTableStart() {
                break
            }
            collected.append(String(line))
            at += 1
        }
        return MarkdownInlineReader.parse(collected.joined(separator: "\n"), context: context)
    }
}

// MARK: - Inline

/// Runs are indexed once. Width queries use a range maximum tree; looking for
/// a delimiter never revisits a long suffix for each unmatched opening mark.
private struct MarkdownDelimiterRuns {
    struct Run { let start: Int; let width: Int }
    let runs: [Run]
    private let size: Int
    private let maximums: [Int]

    init(_ runs: [Run]) {
        self.runs = runs
        var size = 1
        while size < runs.count { size *= 2 }
        self.size = size
        var tree = Array(repeating: 0, count: size * 2)
        for (i, run) in runs.enumerated() { tree[size + i] = run.width }
        if size > 1 {
            for i in stride(from: size - 1, through: 1, by: -1) { tree[i] = max(tree[i * 2], tree[i * 2 + 1]) }
        }
        maximums = tree
    }

    private func lowerBound(_ value: Int) -> Int {
        var low = 0, high = runs.count
        while low < high {
            let middle = (low + high) / 2
            if runs[middle].start < value { low = middle + 1 } else { high = middle }
        }
        return low
    }

    private func maxWidth(_ low: Int, _ high: Int) -> Int {
        var low = low + size, high = high + size, best = 0
        while low < high {
            if low & 1 == 1 { best = max(best, maximums[low]); low += 1 }
            if high & 1 == 1 { high -= 1; best = max(best, maximums[high]) }
            low /= 2; high /= 2
        }
        return best
    }

    private func firstIndex(width: Int, low: Int, high: Int, node: Int = 1, start: Int = 0, end: Int? = nil) -> Int? {
        let end = end ?? size
        guard start < high, end > low, maximums[node] >= width else { return nil }
        if end - start == 1 { return start < runs.count ? start : nil }
        let middle = (start + end) / 2
        return firstIndex(width: width, low: low, high: high, node: node * 2, start: start, end: middle)
            ?? firstIndex(width: width, low: low, high: high, node: node * 2 + 1, start: middle, end: end)
    }

    func first(width: Int, from: Int, to: Int) -> Run? {
        let low = lowerBound(from), high = lowerBound(to)
        guard let index = firstIndex(width: width, low: low, high: high), runs[index].start + width <= to else { return nil }
        return runs[index]
    }

    func maximum(from: Int, to: Int) -> Run? {
        let low = lowerBound(from), high = lowerBound(to)
        guard low < high else { return nil }
        let last = runs[high - 1]
        let partial = last.start + last.width > to
        let fullHigh = partial ? high - 1 : high
        let width = maxWidth(low, fullHigh)
        let partialWidth = partial ? to - last.start : 0
        if partialWidth > width { return Run(start: last.start, width: partialWidth) }
        guard width > 0, let index = firstIndex(width: width, low: low, high: fullHigh) else { return nil }
        return runs[index]
    }
}

private final class MarkdownDelimiters {
    var strong: [Character: MarkdownDelimiterRuns] = [:]
    var escaped: [Character: MarkdownDelimiterRuns] = [:]
    var brackets: [Int] = []
    var parentheses: [Int: Int] = [:]

    init(_ characters: [Character], context: MarkdownReadContext) {
        var runs: [Character: [MarkdownDelimiterRuns.Run]] = [:]
        var at = 0
        let markers: Set<Character> = ["*", "_", "~", "`"]
        while at < characters.count {
            if at & 1023 == 0, !context.available() { return }
            let character = characters[at]
            if character == "]", at == 0 || characters[at - 1] != "\\" { brackets.append(at) }
            if markers.contains(character) {
                let start = at
                while at < characters.count, characters[at] == character {
                    if at & 1023 == 0, !context.available() { return }
                    at += 1
                }
                runs[character, default: []].append(.init(start: start, width: at - start))
            } else { at += 1 }
        }
        for (character, values) in runs {
            strong[character] = MarkdownDelimiterRuns(values)
            let unescaped = values.compactMap { run -> MarkdownDelimiterRuns.Run? in
                let skip = run.start > 0 && characters[run.start - 1] == "\\" ? 1 : 0
                return run.width > skip ? .init(start: run.start + skip, width: run.width - skip) : nil
            }
            escaped[character] = MarkdownDelimiterRuns(unescaped)
        }
        var stack: [Int] = []
        at = 0
        while at < characters.count {
            if at & 1023 == 0, !context.available() { return }
            if characters[at] == "\\" { at += 2; continue }
            if characters[at] == "(" { stack.append(at) }
            if characters[at] == ")", let open = stack.popLast() { parentheses[open] = at }
            at += 1
        }
    }

    static func lowerBound(_ values: [Int], _ value: Int) -> Int {
        var low = 0, high = values.count
        while low < high {
            let middle = (low + high) / 2
            if values[middle] < value { low = middle + 1 } else { high = middle }
        }
        return low
    }
}

private struct MarkdownInlineReader {
    static func parse(_ text: String, context: MarkdownReadContext) -> [MarkdownInline] {
        let characters = Array(text)
        let index = MarkdownDelimiters(characters, context: context)
        var reader = MarkdownInlineReader(characters, start: 0, end: characters.count, index: index, context: context)
        return reader.run(depth: 0)
    }

    private let characters: [Character]
    private var at: Int
    private let end: Int
    private let index: MarkdownDelimiters
    private let context: MarkdownReadContext

    private init(_ characters: [Character], start: Int, end: Int, index: MarkdownDelimiters, context: MarkdownReadContext) {
        self.characters = characters
        self.at = start
        self.end = end
        self.index = index
        self.context = context
    }

    private mutating func run(depth: Int) -> [MarkdownInline] {
        if depth > MarkdownParser.inlineDepthLimit { return [.text(String(characters[at..<end]))] }
        var result: [MarkdownInline] = []
        var plain = ""

        func flush() {
            guard !plain.isEmpty else { return }
            context.nodes += 1
            result.append(.text(plain))
            plain = ""
        }

        while at < end {
            guard context.available() else { break }
            let character = characters[at]

            if character == "\\", at + 1 < end, isPunctuation(characters[at + 1]) {
                plain.append(characters[at + 1])
                at += 2
                continue
            }

            if character == "`" {
                let tick = runLength { $0 == "`" }
                guard let close = find(String(repeating: "`", count: tick), from: at + tick) else {
                    plain.append(String(repeating: "`", count: tick))
                    at += tick
                    continue
                }
                flush()
                let body = String(characters[(at + tick)..<close])
                context.nodes += 1
                result.append(.code(body))
                at = close + tick
                continue
            }

            if character == "~" {
                let weight = runLength { $0 == "~" }
                guard weight >= 2 else { plain.append(character); at += 1; continue }
                flush()
                let marker = String(repeating: "~", count: weight)
                let start = at
                let inner = readDelimited(marker, depth: depth)
                if inner.isEmpty {
                    // An unclosed marker is ordinary text. The scan has to move
                    // past it here, or it never moves past it at all.
                    at = start + weight
                    plain.append(marker)
                } else {
                    context.nodes += 1
                    result.append(.strikethrough(inner))
                }
                continue
            }

            if character == "*" || character == "_" {
                let weight = runLength { $0 == character }
                flush()
                let marker = String(repeating: String(character), count: weight)
                let start = at
                let inner = weight >= 2 ? readStrong(marker, depth: depth) : readDelimited(marker, depth: depth)
                if inner.isEmpty {
                    // Same rule as the tildes above: an unmatched run of
                    // asterisks is text, and the scan must step over it.
                    at = start + weight
                    plain.append(marker)
                } else if weight >= 2 {
                    context.nodes += 1
                    result.append(.strong(inner))
                } else {
                    context.nodes += 1
                    result.append(.emphasis(inner))
                }
                continue
            }

            if character == "!" || character == "[" {
                let isImage = character == "!"
                let skip = isImage ? 1 : 0
                guard at + skip < end, characters[at + skip] == "[" else { plain.append(character); at += 1; continue }
                guard let close = find("]", from: at + skip) else { plain.append(character); at += 1; continue }
                var destination = ""
                var after = close + 1
                if after < end, characters[after] == "(" {
                    if let close = closingParen(from: after + 1) {
                        destination = String(characters[(after + 1)..<close])
                        after = close + 1
                    } else {
                        plain.append(character)
                        at += 1
                        continue
                    }
                }
                flush()
                var label = MarkdownInlineReader(characters, start: at + skip + 1, end: close, index: index, context: context)
                let children = label.run(depth: depth + 1)
                if isImage {
                    context.nodes += 1
                    result.append(.image(alt: children, destination: destination))
                } else {
                    context.nodes += 1
                    result.append(.link(destination: destination, children: children))
                }
                at = after
                continue
            }

            if character == "\n" {
                flush()
                context.nodes += 1
                result.append(.lineBreak)
                at += 1
                continue
            }

            plain.append(character)
            at += 1
        }
        flush()
        return result.filter { !$0.isEmpty }
    }

    /// Reads until `marker` appears again, and parses what was inside.
    private mutating func readDelimited(_ marker: String, depth: Int) -> [MarkdownInline] {
        guard let close = find(marker, from: at + marker.count) else { return [] }
        let start = at + marker.count
        if String(characters[start..<close]).trimmingCharacters(in: .whitespaces).isEmpty { return [] }
        at = close + marker.count
        var inner = MarkdownInlineReader(characters, start: start, end: close, index: index, context: context)
        return inner.run(depth: depth + 1)
    }

    /// Strong emphasis may hold emphasis, so the closing run is allowed to be
    /// shorter than the opening one.
    private mutating func readStrong(_ marker: String, depth: Int) -> [MarkdownInline] {
        let opening = marker.count
        guard let best = index.strong[characters[at]]?.maximum(from: at + opening, to: end) else { return [] }
        let start = at + opening
        let close = best.start
        if String(characters[start..<close]).trimmingCharacters(in: .whitespaces).isEmpty { return [] }
        at = close + min(best.width, opening)
        var inner = MarkdownInlineReader(characters, start: start, end: close, index: index, context: context)
        return inner.run(depth: depth + 1)
    }

    private mutating func runLength(_ match: (Character) -> Bool) -> Int {
        var count = 0
        var scan = at
        while scan < end, match(characters[scan]) { count += 1; scan += 1 }
        return count
    }

    /// Preindexed delimiters avoid scanning the same suffix for every opener.
    private func closingParen(from: Int) -> Int? {
        guard let close = index.parentheses[from - 1], close < end else { return nil }
        return close
    }

    private func find(_ needle: String, from: Int) -> Int? {
        guard let character = needle.first else { return nil }
        if character == "]" {
            let position = MarkdownDelimiters.lowerBound(index.brackets, from)
            guard position < index.brackets.count, index.brackets[position] < end else { return nil }
            return index.brackets[position]
        }
        return index.escaped[character]?.first(width: needle.count, from: from, to: end)?.start
    }

    private func isPunctuation(_ character: Character) -> Bool {
        "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".contains(character)
    }
}

// MARK: - Links

public enum MarkdownLink {
    /// Only http and https with a host are openable, which is the same rule
    /// Android applies before handing a URL to the browser. Anything else —
    /// `javascript:`, `file:`, a credentialed URL — is shown as text.
    public static func isSafe(_ destination: String) -> Bool {
        guard let components = URLComponents(string: destination),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return false }
        guard let host = components.host, !host.isEmpty else { return false }
        return components.user == nil && components.password == nil
    }
}
