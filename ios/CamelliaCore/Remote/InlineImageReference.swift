import Foundation

public enum InlineImageReference {
    public static let maximumBytes: Int64 = 32 * 1024 * 1024
    private static let extensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico"]

    public static func remoteURL(_ reference: String) -> URL? {
        guard let components = URLComponents(string: reference),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              components.host != nil, components.user == nil, components.password == nil
        else { return nil }
        return components.url
    }

    public static func isSupported(_ reference: String) -> Bool {
        guard !reference.isEmpty, reference.utf8.count <= 4096,
              !reference.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
        else { return false }
        let path: String
        if let remote = remoteURL(reference) {
            path = remote.path
        } else {
            if let colon = reference.firstIndex(of: ":") {
                let scheme = String(reference[..<colon])
                let suffix = reference[reference.index(after: colon)...]
                let windowsDrive = scheme.count == 1 && scheme.unicodeScalars.allSatisfy(CharacterSet.letters.contains)
                    && (suffix.hasPrefix("/") || suffix.hasPrefix("\\"))
                guard windowsDrive || scheme.lowercased() == "file" || !isScheme(scheme) else { return false }
            }
            path = reference
        }
        let clean = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        let withoutAnchor = clean.split(separator: "#", maxSplits: 1).first.map(String.init) ?? clean
        return extensions.contains((withoutAnchor as NSString).pathExtension.lowercased())
    }

    private static func isScheme(_ value: String) -> Bool {
        guard let first = value.unicodeScalars.first, CharacterSet.letters.contains(first) else { return false }
        return value.unicodeScalars.allSatisfy {
            CharacterSet.letters.contains($0) || CharacterSet.decimalDigits.contains($0) || $0 == "+" || $0 == "-" || $0 == "."
        }
    }
}
