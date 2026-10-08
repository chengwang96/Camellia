import Foundation

/// Redaction for anything that came off the wire before it reaches a log, an
/// error banner or the screen.
///
/// Ported from `RemoteApi.clean`. The order matters: the token shapes are
/// replaced first, then whitespace is collapsed, then the result is capped.
public enum Redaction {
    public static let maximumLength = 4096

    public static func clean(_ value: String?) -> String {
        guard let value else { return "" }
        var text = value
        text = replacing(text, #"(?i)Bearer\s+[^\s"',;]+"#, with: "Bearer [redacted]")
        text = replacing(text, #"(?i)\bsk-[A-Za-z0-9_-]+"#, with: "[redacted]")
        text = replacing(text, #"\b[A-Za-z0-9_-]{43}\b"#, with: "[redacted]")
        text = replacing(text, #"\s+"#, with: " ")
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count > maximumLength else { return text }
        return String(text.prefix(maximumLength)) + "…"
    }

    private static func replacing(_ text: String, _ pattern: String, with replacement: String) -> String {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return expression.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: replacement)
    }
}
