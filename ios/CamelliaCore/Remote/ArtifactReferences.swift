import Foundation

/// What kind of file an artifact name looks like, for the icon and the label.
///
/// The desktop lists artifacts with an extension but no type, so the phone
/// classifies by extension — the same table `ArtifactMessageView.java` uses.
public enum ArtifactKind: String, Sendable {
    case package
    case pdf
    case word
    case spreadsheet
    case presentation
    case image
    case video
    case audio
    case text
    case document

    /// The category as it is written under a file name.
    public var label: String {
        switch self {
        case .package: return "安装包"
        case .spreadsheet: return "表格"
        case .presentation: return "演示文稿"
        case .image: return "图片"
        case .video: return "视频"
        case .audio: return "音频"
        case .text: return "文本"
        case .document, .pdf, .word: return "文档"
        }
    }

    /// A colour name the view maps to the palette. Kept as a name rather than a
    /// colour so the classification stays free of UIKit and testable on a host.
    public var tint: String {
        switch self {
        case .pdf: return "pdf"
        case .spreadsheet: return "spreadsheet"
        case .presentation: return "presentation"
        case .package: return "package"
        default: return "accent"
        }
    }

}

/// Finds the files an answer is talking about.
///
/// Ported from `ArtifactReferences.java`. The desktop does not tell the phone
/// which files a message produced, so the phone reads them out of the prose:
/// a backtick-quoted path or the target of a markdown link, kept only when it
/// ends in an extension worth downloading. Keep the full reference for opening
/// a particular file; the basename alone cannot distinguish two build folders.
public struct ArtifactSelection: Sendable, Hashable {
    public let seq: Int64
    public let reference: String

    public init(seq: Int64, reference: String) { self.seq = seq; self.reference = reference }

    public func path(conversationId: String, offset: Int64 = 0) -> String {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._*-")
        let encoded = reference.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
        return "/v1/conversations/\(conversationId)/artifacts?offset=\(offset)&seq=\(seq)&reference=\(encoded)"
    }
}

public enum ArtifactReferences {
    /// `\`path\`` or `[text](path)` / `![alt](path)`, with or without the
    /// angle brackets markdown allows around a target.
    private static let referencePattern = #"!?\[[^\]\n]*\]\(<?((?:[^()\n]|\([^()\n]*\))+?)>?\)|`([^`\n]+)`"#
    /// Fenced code is stripped first: a path inside a code block is being shown
    /// as an example far more often than it is a file the answer made.
    private static let fencePattern = "```.*?(?:```|$)"
    private static let extensions = "(?i).+\\.(apk|exe|msi|dmg|deb|rpm|pdf|docx?|pptx?|xlsx?|csv|tsv|txt|md|html?|png|jpe?g|gif|webp|svg|mp4|webm|mp3|wav)$"
    private static let schemes = "(?i)^(https?|data|javascript|mailto):.*"

    private static let reference = try? NSRegularExpression(pattern: referencePattern)
    private static let fence = try? NSRegularExpression(pattern: fencePattern, options: [.dotMatchesLineSeparators])
    private static let extension_ = try? NSRegularExpression(pattern: extensions)
    private static let scheme = try? NSRegularExpression(pattern: schemes)

    /// The distinct file names a message mentions, in the order they appear.
    ///
    /// Bounded at a hundred the way Android bounds it: a message that mentions
    /// a thousand paths is a message whose list is not worth building.
    public static func names(from text: String, limit: Int = 100) -> [String] {
        var seen = Set<String>()
        return paths(from: text, limit: limit).map { Self.name(of: $0) }.filter { seen.insert($0).inserted }
    }

    public static func name(of path: String) -> String {
        let decoded = path.removingPercentEncoding ?? path
        return decoded.replacingOccurrences(of: "\\", with: "/").components(separatedBy: "/").last ?? ""
    }

    public static func paths(from text: String, limit: Int = 100) -> [String] {
        let body = stripFences(text)
        guard let expression = reference else { return [] }
        let full = NSRange(body.startIndex..<body.endIndex, in: body)
        var seen = Set<String>()
        var result: [String] = []

        expression.enumerateMatches(in: body, options: [], range: full) { match, _, stop in
            guard let match else { return }
            // Either capture group can be the empty one; exactly one is set per
            // match, which is how the two alternatives share a pass.
            let quoted = capture(match, 1, in: body) ?? capture(match, 2, in: body)
            guard let quoted else { return }
            let path = quoted.replacingOccurrences(of: #"\s+"[^"]*"$"#, with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !path.isEmpty else { return }
            guard !matches(scheme, path) else { return }
            guard matches(extension_, path) else { return }
            // A Windows path arrives with backslashes and is still a path.
            let name = Self.name(of: path)
            guard !name.isEmpty, name.count <= 200 else { return }
            guard seen.insert(path).inserted else { return }
            result.append(path)
            if result.count >= limit { stop.pointee = true }
        }
        return result
    }

    /// Classifies a file name by its extension.
    public static func kind(of name: String) -> ArtifactKind {
        switch fileExtension(of: name) {
        case "APK", "EXE", "MSI", "DMG", "DEB", "RPM": return .package
        case "PDF": return .pdf
        case "DOC", "DOCX": return .word
        case "XLS", "XLSX", "CSV", "TSV": return .spreadsheet
        case "PPT", "PPTX": return .presentation
        case "PNG", "JPG", "JPEG", "GIF", "WEBP", "SVG": return .image
        case "MP4", "WEBM": return .video
        case "MP3", "WAV": return .audio
        default: return .text
        }
    }

    /// The uppercased extension, which is what the file chip shows.
    ///
    /// Named `fileExtension` rather than `extension` because the latter is a
    /// declaration keyword and cannot be a method name without backticks.
    public static func fileExtension(of name: String) -> String {
        guard let dot = name.lastIndex(of: "."), dot < name.index(before: name.endIndex) else { return "?" }
        return String(name[name.index(after: dot)...]).uppercased()
    }

    /// Orders names the way the artifact card shows them: by kind priority,
    /// keeping the message's own order within a priority.
    ///
    /// The tie-break is explicit because Swift's sort is not stable and Java's
    /// is, so relying on the input order surviving a plain sort would order the
    /// card differently from Android's on the same message.
    public static func sorted(_ names: [String]) -> [String] {
        names.enumerated()
            .sorted { left, right in
                let a = priority(of: left.element), b = priority(of: right.element)
                return a == b ? left.offset < right.offset : a < b
            }
            .map(\.element)
    }

    /// Which files float to the top of a message's artifact list.
    ///
    /// Packages first, then the kinds a person is most likely to want to look
    /// at, then everything else. Note that markdown and HTML are promoted by
    /// *extension* rather than by kind, because they classify as plain text —
    /// reading only the kind would bury the one readable file under the paths
    /// an answer merely mentioned.
    public static func priority(of name: String) -> Int {
        let kind = kind(of: name)
        if kind == .package { return 0 }
        if [.image, .video, .presentation].contains(kind) { return 1 }
        if ["MD", "HTML", "HTM"].contains(fileExtension(of: name)) { return 1 }
        return 2
    }

    // MARK: - Details

    private static func stripFences(_ text: String) -> String {
        guard let fence else { return text }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return fence.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: "")
    }

    private static func capture(_ match: NSTextCheckingResult, _ index: Int, in text: String) -> String? {
        guard index < match.numberOfRanges else { return nil }
        let range = match.range(at: index)
        guard range.location != NSNotFound, let swiftRange = Range(range, in: text) else { return nil }
        return String(text[swiftRange])
    }

    private static func matches(_ expression: NSRegularExpression?, _ text: String) -> Bool {
        guard let expression else { return false }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = expression.firstMatch(in: text, options: [], range: range) else { return false }
        return match.range == range
    }
}
