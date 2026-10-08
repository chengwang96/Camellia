import SwiftUI

/// A titled panel, so the three tabs share one visual language.
struct SectionCard<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundColor(.secondary)
                .textCase(.uppercase)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }
}

/// A label beside a value, with the value selectable so it can be copied out.
struct DetailRow: View {
    let label: String
    let value: String
    var monospaced = false
    var tint: Color?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(label)
                .foregroundColor(.secondary)
                .frame(width: 76, alignment: .leading)
            Text(value.isEmpty ? "—" : value)
                .font(monospaced ? .system(.footnote, design: .monospaced) : .subheadline)
                .foregroundColor(tint ?? .primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.subheadline)
    }
}

/// A state chip, coloured by whether the state is the one wanted.
struct StatusPill: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(tint.opacity(0.16), in: Capsule())
            .foregroundColor(tint)
    }
}

/// The body text of a response, shown as a scrollable monospaced block.
struct CodeBlock: View {
    let text: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            Text(text)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .padding(10)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(maxHeight: 260)
        .background(Color(uiColor: .tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
    }
}
