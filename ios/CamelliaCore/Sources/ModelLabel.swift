import Foundation

/// The short name a model is drawn with.
///
/// A port of Android's `ModelLabel.compact`, which exists because the id the
/// desktop reports — `kimi-code/k3.1-pro`, `deepseek-v4.1-flash` — is far
/// longer than the one line the composer's tool row has. Only the families
/// whose short forms are known are shortened; anything else is returned trimmed
/// rather than guessed at, because a label that invents a name is worse than a
/// long one that is right.
public enum ModelLabel {
    public static func compact(_ name: String) -> String {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        // Account models arrive as `kimi-code/k3.1-pro`; shared routes use the
        // bare family (`deepseek-v4.1-flash:1017`). Drop the Kimi provider
        // prefix first, before the registry tag, so `moonshot:kimi-k2.5`
        // becomes `K2.5` rather than the provider name.
        var bare = value
        if let range = bare.range(of: #"^(?:kimi-code|moonshot)[/:]"#,
                                  options: [.regularExpression, .caseInsensitive]) {
            bare = String(bare[range.upperBound...])
        }
        if let colon = bare.firstIndex(of: ":"), colon != bare.startIndex {
            bare = String(bare[bare.startIndex..<colon]).trimmingCharacters(in: .whitespaces)
        }
        if let parts = firstMatch(#"^(?:kimi[- ]+)?(k\d+(?:\.\d+)*)(?:[- ]+(pro[- ]+highspeed|pro|highspeed|thinking|preview|\d+k))?$"#, in: bare) {
            return parts[0].uppercased() + suffix(parts, at: 1)
        }
        if firstMatch(#"^gpt-(?:6-astra|5\.6-(?:sol|terra|luna))$"#, in: bare) != nil {
            guard let dash = bare.range(of: "-", options: .backwards) else { return bare }
            return title(String(bare[dash.upperBound...]))
        }
        if let parts = firstMatch(#"^deepseek[- ]+([vr]\d+(?:\.\d+)*)(?:[- ]+(pro|flash|lite))?$"#, in: bare) {
            return parts[0].uppercased() + suffix(parts, at: 1)
        }
        if let parts = firstMatch(#"^mimo[- ]+v?(\d+(?:\.\d+)*)(?:[- ]+(pro|flash|base))?$"#, in: bare) {
            return "MiMo " + parts[0] + suffix(parts, at: 1)
        }
        if bare.lowercased() == "deepseek-chat" { return "DS Chat" }
        if bare.lowercased() == "deepseek-reasoner" { return "DS Reasoner" }
        return bare
    }

    /// The ` · tier` tail, present only when the optional group matched.
    private static func suffix(_ parts: [String], at index: Int) -> String {
        guard index < parts.count, !parts[index].isEmpty else { return "" }
        return " " + tier(parts[index])
    }

    /// `pro-highspeed` becomes `Pro Highspeed`; a `256k` context tag keeps its
    /// upper-cased suffix the way the picker writes it.
    private static func tier(_ value: String) -> String {
        value.split(whereSeparator: { $0 == "-" || $0 == " " }).map { word in
            let text = String(word)
            return firstMatch(#"^\d+k$"#, in: text) == nil ? title(text) : text.uppercased()
        }.joined(separator: " ")
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
