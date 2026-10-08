import Foundation

/// The short name a model is drawn with.
///
/// A port of Android's `ModelLabel.compact`, which exists because the id the
/// desktop reports — `moonshot:kimi-k2.5-thinking`, `deepseek-v4.1-flash` — is
/// far longer than the one line the composer's tool row has. Only the families
/// whose short forms are known are shortened; anything else is returned trimmed
/// rather than guessed at, because a label that invents a name is worse than a
/// long one that is right.
public enum ModelLabel {
    public static func compact(_ name: String) -> String {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        // A `provider:model` id keeps either side depending on where the
        // provider prefix sits; Android drops the prefix before a colon and so
        // does this, which is what turns `moonshot:kimi-k2.5` into `K2.5`.
        var trimmed = value
        if let colon = value.firstIndex(of: ":"), colon != value.startIndex {
            trimmed = String(value[value.startIndex..<colon]).trimmingCharacters(in: .whitespaces)
        }
        if let parts = firstMatch(#"^kimi[- ]+(k\d+(?:\.\d+)*)(?:[- ]+(thinking|preview))?$"#, in: trimmed) {
            return parts[0].uppercased() + suffix(parts, at: 1)
        }
        if firstMatch(#"^gpt-(?:6-astra|5\.6-(?:sol|terra|luna))$"#, in: trimmed) != nil {
            guard let dash = trimmed.range(of: "-", options: .backwards) else { return value }
            return title(String(trimmed[dash.upperBound...]))
        }
        if let parts = firstMatch(#"^deepseek[- ]+([vr]\d+(?:\.\d+)*)(?:[- ]+(pro|flash|lite))?$"#, in: trimmed) {
            return parts[0].uppercased() + suffix(parts, at: 1)
        }
        if let parts = firstMatch(#"^mimo[- ]+v?(\d+(?:\.\d+)*)(?:[- ]+(pro|flash|base))?$"#, in: trimmed) {
            return "MiMo " + parts[0] + suffix(parts, at: 1)
        }
        if trimmed.lowercased() == "deepseek-chat" { return "DS Chat" }
        if trimmed.lowercased() == "deepseek-reasoner" { return "DS Reasoner" }
        return value
    }

    /// The ` · thinking` tail, present only when the optional group matched.
    private static func suffix(_ parts: [String], at index: Int) -> String {
        guard index < parts.count, !parts[index].isEmpty else { return "" }
        return " " + title(parts[index])
    }

    private static func title(_ value: String) -> String {
        value.isEmpty ? value : value.prefix(1).uppercased() + value.dropFirst().lowercased()
    }

    /// The capture groups of the first match, with a non-participating group
    /// reported as empty — `NSRegularExpression` uses `NSNotFound` where Java's
    /// `Matcher.group` returns null, and the difference matters here because an
    /// optional `thinking`/`pro` tail is the common case.
    private static func firstMatch(_ pattern: String, in value: String) -> [String]? {
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = expression.firstMatch(in: value, options: [], range: range),
              match.range == range else { return nil }
        return (1..<match.numberOfRanges).map { index in
            let group = match.range(at: index)
            guard group.location != NSNotFound, let span = Range(group, in: value) else { return "" }
            return String(value[span])
        }
    }
}
