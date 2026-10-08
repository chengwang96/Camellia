import SwiftUI

/// Draws one block of a parsed document.
///
/// The reading lives in `CamelliaCore` where it is tested; this is only the
/// layout, so the two halves can be read separately.
struct MarkdownView: View {
    let document: MarkdownDocument

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(document.displayed.enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct BlockView: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case .heading(let level, let inline):
            Text(MarkdownAttributed.build(inline))
                .font(.system(size: level <= 2 ? 21 : level == 3 ? 18 : 16, weight: .semibold))
                .foregroundColor(Palette.ink)
                .padding(.top, 4)
        case .paragraph(let inline):
            Text(MarkdownAttributed.build(inline))
                .font(.body)
                .foregroundColor(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
        case .code(let language, let text):
            CodeBlock(language: language, text: text)
        case .list(let ordered, let start, let items):
            ListView(ordered: ordered, start: start, items: items)
        case .quote(let blocks):
            QuoteView(blocks: blocks)
        case .divider:
            Divider().padding(.vertical, 4)
        case .table(let rows):
            TableView(rows: rows)
        }
    }
}

// MARK: - Inline

enum MarkdownAttributed {
    /// Turns inline markup into one attributed string.
    ///
    /// A link only becomes a link when `MarkdownLink.isSafe` agrees, so a
    /// `javascript:` destination in a model's reply is drawn as plain text
    /// instead of being handed to the system to open.
    static func build(_ nodes: [MarkdownInline]) -> AttributedString {
        var result = AttributedString()
        for node in nodes {
            switch node {
            case .text(let value):
                result.append(AttributedString(value))
            case .code(let value):
                var container = AttributeContainer()
                container.font = .system(.body, design: .monospaced)
                container.backgroundColor = Palette.surface
                var piece = AttributedString(value)
                piece.mergeAttributes(container)
                result.append(piece)
            case .strong(let children):
                var piece = build(children)
                piece.inlinePresentationIntent = .stronglyEmphasized
                result.append(piece)
            case .emphasis(let children):
                var piece = build(children)
                piece.inlinePresentationIntent = .emphasized
                result.append(piece)
            case .strikethrough(let children):
                var piece = build(children)
                piece.inlinePresentationIntent = .strikethrough
                result.append(piece)
            case .link(let destination, let children):
                var piece = build(children)
                if MarkdownLink.isSafe(destination), let url = URL(string: destination) {
                    piece.link = url
                    piece.foregroundColor = Palette.accent
                }
                result.append(piece)
            case .image(let alt, _):
                // Images are not fetched: a reply would otherwise make requests
                // to hosts the user never chose. The alt text is shown instead,
                // which is what Android does too.
                result.append(AttributedString("["))
                result.append(build(alt))
                result.append(AttributedString("]"))
            case .lineBreak:
                result.append(AttributedString("\n"))
            }
        }
        return result
    }
}

// MARK: - Code

private struct CodeBlock: View {
    let language: String
    let text: String
    @State private var copied = false
    @State private var wrapped = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                Text(language.isEmpty ? "code" : language)
                    .font(.caption2)
                    .foregroundColor(Palette.muted)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Button {
                    wrapped.toggle()
                } label: {
                    Image(systemName: wrapped ? "text.append" : "arrow.left.and.right")
                        .font(.caption)
                        .foregroundColor(Palette.muted)
                }
                .buttonStyle(.plain)
                Button {
                    UIPasteboard.general.string = text
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                } label: {
                    Text(copied ? "已复制" : "复制")
                        .font(.caption)
                        .foregroundColor(Palette.accent)
                }
                .buttonStyle(.plain)
            }
            Group {
                if wrapped {
                    Text(text)
                        .font(.system(.footnote, design: .monospaced))
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(text)
                            .font(.system(.footnote, design: .monospaced))
                    }
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: Palette.smallRadius, style: .continuous).fill(Palette.surface))
    }
}

// MARK: - Lists

private struct ListView: View {
    let ordered: Bool
    let start: Int
    let items: [[MarkdownBlock]]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, blocks in
                HStack(alignment: .top, spacing: 8) {
                    Text(ordered ? "\(start + index)." : "•")
                        .font(.body)
                        .foregroundColor(Palette.muted)
                        .frame(width: 20, alignment: .trailing)
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                            BlockView(block: block)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

// MARK: - Quotes

private struct QuoteView: View {
    let blocks: [MarkdownBlock]

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Rectangle()
                .fill(Palette.accent)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                    BlockView(block: block)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Tables

private struct TableView: View {
    let rows: [[MarkdownCell]]
    private let columnWidth: CGFloat = 140

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    HStack(alignment: .top, spacing: 0) {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            Text(MarkdownAttributed.build(cell.inline))
                                .font(.footnote)
                                .foregroundColor(Palette.ink)
                                .frame(width: columnWidth, alignment: frameAlignment(cell.alignment))
                                .padding(8)
                                .background(cell.header ? Palette.surface : Color.clear)
                                .overlay(
                                    Rectangle().stroke(Palette.separator, lineWidth: 0.5)
                                )
                        }
                    }
                }
            }
        }
    }

    private func frameAlignment(_ value: MarkdownAlignment) -> Alignment {
        switch value {
        case .start: return .topLeading
        case .center: return .top
        case .end: return .topTrailing
        }
    }
}
