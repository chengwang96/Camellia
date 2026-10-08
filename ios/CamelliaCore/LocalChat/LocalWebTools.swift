import Foundation

public enum LocalWebError: Error, Equatable, CustomStringConvertible {
    case invalidURL
    case insecureURL
    case nonPublicAddress
    case privateHost
    case unsupportedContent
    case pageTooLarge
    case noReadableText
    case searchUnavailable
    case noResults(String)
    case unsafeXML
    case unsafeRedirect

    public var description: String {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .insecureURL: return "Public HTTPS URL required"
        case .nonPublicAddress: return "Non-public address blocked"
        case .privateHost: return "Private host blocked"
        case .unsupportedContent: return "Unsupported web content"
        case .pageTooLarge: return "Page too large"
        case .noReadableText: return "Page has no readable text; use the search result snippet instead"
        case .searchUnavailable: return "Search providers unavailable"
        case .noResults(let detail): return detail
        case .unsafeXML: return "Unsafe XML declaration"
        case .unsafeRedirect: return "Unsafe or excessive web redirect"
        }
    }
}

/// The web half of the tool loop: which URLs may be reached, and how a result
/// page becomes text.
///
/// Ported from `LocalWebTools.java`. The model chooses the URL, and the model
/// reads attacker-controlled pages, so this file is the boundary: only public
/// HTTPS on the standard port, no credentials in the URL, nothing that resolves
/// into a private range, and no hostname that looks like it belongs to a local
/// network. It is the difference between "the model can look things up" and
/// "the model can probe the user's intranet".
///
/// The parsing is deliberately cruder than Android's jsoup. What matters for the
/// model is a title, a URL and a snippet; what matters for safety is that
/// nothing here trusts the page. Scripts, styles, embedded frames and navigation
/// are cut before the text is taken, and the result is always tagged
/// `untrusted`, which is what the rules tell the model to treat it as.
public enum LocalWebTools {
    public static let maxURLBytes = 2048
    public static let maxFetchBytes = 512 * 1024
    public static let maxSearchBytes = 2 * 1024 * 1024
    public static let maxFetchText = 12000
    public static let maxTitle = 200
    public static let maxSnippet = 1200
    public static let maxResults = 5
    public static let maxRedirects = 3

    /// Tags whose *contents* are dropped, not just the tags.
    private static let droppedElements = ["script", "style", "noscript", "iframe", "form", "svg", "nav", "footer"]

    private static var droppedPattern: NSRegularExpression? {
        let names = droppedElements.joined(separator: "|")
        return try? NSRegularExpression(pattern: "(?is)<(" + names + ")\\b[^>]*>.*?</\\1\\s*>", options: [])
    }

    // MARK: - URL policy

    /// Validates a URL the model asked for and returns it without its fragment.
    ///
    /// Pure, so it can be checked without a network. Hostname *resolution* is a
    /// separate step (`resolvesPubliclyOnly`), because that one needs a lookup.
    public static func publicURL(_ value: String) throws -> URL {
        guard value.utf16.count <= maxURLBytes else { throw LocalWebError.invalidURL }
        // Space is in the class on purpose: a space in a URL is how a second
        // token gets smuggled into whatever reads it next.
        if value.matches(#"(?s).*[\x00-\x20\x7f<>\\].*"#) { throw LocalWebError.invalidURL }
        guard let parsed = URL(string: value),
              let components = URLComponents(url: parsed, resolvingAgainstBaseURL: false),
              components.scheme == "https"
        else { throw LocalWebError.insecureURL }
        guard (components.port ?? 443) == 443 else { throw LocalWebError.insecureURL }
        guard components.user == nil, components.password == nil else { throw LocalWebError.insecureURL }
        guard let host = components.host, !host.isEmpty else { throw LocalWebError.insecureURL }

        let lowered = host.lowercased()
        if lowered.contains(":") || lowered.matches(#"^[0-9.]+$"#) {
            // A literal address has to be public. A dotted string that is not a
            // valid address at all is treated the same way as a private one:
            // there is nothing useful it can be.
            guard let isPublic = addressIsPublic(lowered), isPublic else {
                throw LocalWebError.nonPublicAddress
            }
            // An address carries no name, so the hostname rules below do not
            // apply to it — and the dotted-name requirement would reject every
            // IPv6 literal.
        } else {
            for suffix in [".local", ".localhost", ".internal", ".home", ".lan"] {
                if lowered.hasSuffix(suffix) { throw LocalWebError.privateHost }
            }
            // A dotted name is required, which rules out bare hostnames like
            // "router" and any single-label name a search domain might expand.
            guard lowered.contains("."), !lowered.hasSuffix(".") else { throw LocalWebError.privateHost }
        }

        var canonical = components
        canonical.fragment = nil
        // Android's `HttpUrl` drops the default port when it re-serialises, and
        // so two spellings of one URL are one source in the list.
        if canonical.port == 443 { canonical.port = nil }
        guard let url = canonical.url else { throw LocalWebError.invalidURL }
        return url
    }

    /// Whether a dotted-quad or IPv6 literal names a public address.
    ///
    /// Returns nil when the value is not a parseable address. The rules are
    /// Android's: the unspecified, loopback, link-local, site-local, multicast
    /// and carrier-NAT ranges, plus the documentation and benchmarking blocks,
    /// are all refused.
    public static func addressIsPublic(_ host: String) -> Bool? {
        guard host.contains(":") else {
            guard let octets = ipv4Bytes(host) else { return nil }
            return ipv4IsPublic(octets)
        }
        guard let bytes = ipv6Bytes(host), bytes.count == 16 else { return nil }
        // Java's `InetAddress` unwraps an IPv4-mapped address into an
        // `Inet4Address`, so `::ffff:8.8.8.8` is judged by the IPv4 rules.
        if bytes[0..<10].allSatisfy({ $0 == 0 }), bytes[10] == 0xff, bytes[11] == 0xff {
            return ipv4IsPublic(Array(bytes[12..<16]))
        }
        let first = Int(bytes[0]), second = Int(bytes[1])
        let third = Int(bytes[2]), fourth = Int(bytes[3])
        return (first & 0xe0) == 0x20
            && !(first == 0x20 && second == 0x02)
            && !(first == 0x20 && second == 0x01
                 && (third < 2 || (third == 0x0d && fourth == 0xb8)))
    }

    private static func ipv4IsPublic(_ bytes: [UInt8]) -> Bool {
        let first = Int(bytes[0]), second = Int(bytes[1])
        return first != 0 && first != 10 && first != 127 && first < 224
            && !(first == 100 && second >= 64 && second <= 127)
            && !(first == 169 && second == 254)
            && !(first == 172 && second >= 16 && second <= 31)
            && !(first == 192 && (second == 168 || second == 0 || second == 2))
            && !(first == 198 && (second == 18 || second == 19 || second == 51))
            && !(first == 203 && second == 0)
    }

    /// Whether every address a hostname resolves to is public.
    ///
    /// A second line behind `publicURL`: a name that looks harmless but points
    /// at `10.0.0.5` is the classic way through a URL check. `nil` means the
    /// lookup itself failed. iOS cannot pin the address the connection then
    /// uses, so a name whose answer changes between this check and the request
    /// is a gap Android's OkHttp DNS hook does not have.
    public static func resolvesPubliclyOnly(_ host: String) -> Bool? {
        if let literal = addressIsPublic(host) { return literal }
        guard let addresses = resolvedAddresses(host), !addresses.isEmpty else { return nil }
        return addresses.allSatisfy { addressIsPublic($0) == true }
    }

    /// The numeric addresses a host resolves to, or nil if it does not resolve.
    static func resolvedAddresses(_ host: String) -> [String]? {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_STREAM
        var result: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, nil, &hints, &result) == 0, let head = result else { return nil }
        defer { freeaddrinfo(head) }
        var found: [String] = []
        var node: UnsafeMutablePointer<addrinfo>? = head
        while let current = node {
            if let address = current.pointee.ai_addr {
                var text = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(address, current.pointee.ai_addrlen, &text, socklen_t(text.count),
                               nil, 0, NI_NUMERICHOST) == 0 {
                    let name = String(cString: text)
                    if !name.isEmpty { found.append(name) }
                }
            }
            node = current.pointee.ai_next
        }
        return found
    }

    /// Parses an IPv6 literal, including `::` compression, into sixteen bytes.
    private static func ipv6Bytes(_ value: String) -> [UInt8]? {
        var text = value
        if text.hasPrefix("[") && text.hasSuffix("]") { text = String(text.dropFirst().dropLast()) }
        // A zone index ("fe80::1%en0") is not part of the address.
        if let percent = text.firstIndex(of: "%") { text = String(text[..<percent]) }
        guard !text.isEmpty, text.contains(":") else { return nil }

        guard let compression = text.range(of: "::") else {
            let pieces = text.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
            guard let groups = ipv6Groups(pieces), groups.count == 8 else { return nil }
            return ipv6Bytes(groups)
        }
        let headText = String(text[text.startIndex..<compression.lowerBound])
        let tailText = String(text[compression.upperBound...])
        let headPieces = headText.isEmpty ? [] : headText.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        let tailPieces = tailText.isEmpty ? [] : tailText.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard let head = ipv6Groups(headPieces), let tail = ipv6Groups(tailPieces) else { return nil }
        // `::` stands for at least one all-zero group.
        let fill = 8 - head.count - tail.count
        guard fill >= 1 else { return nil }
        return ipv6Bytes(head + [UInt16](repeating: 0, count: fill) + tail)
    }

    /// One group per piece, except that a trailing embedded IPv4 takes two.
    private static func ipv6Groups(_ pieces: [String]) -> [UInt16]? {
        var groups: [UInt16] = []
        for (index, piece) in pieces.enumerated() {
            if piece.contains(".") {
                guard index == pieces.count - 1, let octets = ipv4Bytes(piece) else { return nil }
                groups.append(UInt16(octets[0]) << 8 | UInt16(octets[1]))
                groups.append(UInt16(octets[2]) << 8 | UInt16(octets[3]))
                continue
            }
            guard !piece.isEmpty, piece.count <= 4, let group = UInt16(piece, radix: 16) else { return nil }
            groups.append(group)
        }
        return groups
    }

    private static func ipv6Bytes(_ groups: [UInt16]) -> [UInt8] {
        var bytes: [UInt8] = []
        for group in groups {
            bytes.append(UInt8(group >> 8))
            bytes.append(UInt8(group & 0xff))
        }
        return bytes
    }

    private static func ipv4Bytes(_ value: String) -> [UInt8]? {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var bytes: [UInt8] = []
        for part in parts {
            guard !part.isEmpty, part.count <= 3, let octet = UInt8(part) else { return nil }
            bytes.append(octet)
        }
        return bytes
    }

    // MARK: - Text extraction

    /// The visible text of an HTML document.
    ///
    /// Not a browser's rendering and not meant to be: scripts and the page
    /// furniture are removed, tags become whitespace, entities are decoded, and
    /// runs of whitespace collapse. What is left is what the model can read.
    public static func text(fromHTML html: String) -> String {
        // Only the body: a page's `<head>` holds meta text and its title, none
        // of which a reader would see, and sending it to the model invites it to
        // treat keywords as content.
        var working = html
        if let body = try? NSRegularExpression(pattern: "(?is)<body\\b[^>]*>(.*?)</body>", options: []),
           let match = body.firstMatch(in: html, options: [],
                                       range: NSRange(html.startIndex..<html.endIndex, in: html)),
           match.numberOfRanges > 1,
           let range = Range(match.range(at: 1), in: html) {
            working = String(html[range])
        }
        if let comments = try? NSRegularExpression(pattern: "(?s)<!--.*?-->", options: []) {
            working = comments.stringByReplacingMatches(in: working, options: [],
                                                        range: NSRange(working.startIndex..<working.endIndex, in: working),
                                                        withTemplate: " ")
        }
        if let dropped = droppedPattern {
            working = dropped.stringByReplacingMatches(in: working, options: [],
                                                       range: NSRange(working.startIndex..<working.endIndex, in: working),
                                                       withTemplate: " ")
        }
        if let tags = try? NSRegularExpression(pattern: "(?s)<[^>]*>", options: []) {
            working = tags.stringByReplacingMatches(in: working, options: [],
                                                    range: NSRange(working.startIndex..<working.endIndex, in: working),
                                                    withTemplate: " ")
        }
        return decodeEntities(working).collapsingWhitespace()
    }

    /// The `<title>`, trimmed and capped.
    public static func title(fromHTML html: String) -> String {
        guard let expression = try? NSRegularExpression(pattern: "(?is)<title[^>]*>(.*?)</title>", options: []),
              let match = expression.firstMatch(in: html, options: [],
                                                range: NSRange(html.startIndex..<html.endIndex, in: html)),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: html)
        else { return "" }
        return clip(decodeEntities(String(html[range])).collapsingWhitespace(), maxTitle)
    }

    /// Decodes the entities that actually appear in page text.
    private static func decodeEntities(_ value: String) -> String {
        var text = value
        for (entity, replacement) in namedEntities {
            text = text.replacingOccurrences(of: entity, with: replacement)
        }
        guard text.contains("&#") else { return text }
        guard let expression = try? NSRegularExpression(pattern: "&#(x?)([0-9a-fA-F]+);", options: []) else { return text }
        let matches = expression.matches(in: text, options: [], range: NSRange(text.startIndex..<text.endIndex, in: text))
        for match in matches.reversed() {
            guard let whole = Range(match.range, in: text),
                  let flagRange = Range(match.range(at: 1), in: text),
                  let valueRange = Range(match.range(at: 2), in: text),
                  let scalarValue = UInt32(text[valueRange], radix: text[flagRange].isEmpty ? 10 : 16),
                  let scalar = Unicode.Scalar(scalarValue)
            else { continue }
            text.replaceSubrange(whole, with: String(Character(scalar)))
        }
        return text
    }

    private static let namedEntities: [(String, String)] = [
        ("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
        ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&mdash;", "—"),
        ("&ndash;", "–"), ("&hellip;", "…"), ("&middot;", "·"), ("&laquo;", "«"),
        ("&raquo;", "»"), ("&copy;", "©"), ("&reg;", "®"), ("&trade;", "™"),
    ]

    // MARK: - Results

    /// The shape `web_fetch` returns.
    public static func fetchResult(url: String, html: String) throws -> [String: Any] {
        let text = text(fromHTML: html)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw LocalWebError.noReadableText
        }
        let sources: [[String: Any]] = [["url": url, "title": title(fromHTML: html)]]
        return ["untrusted": true,
                "sources": sources,
                "text": clip(text, maxFetchText),
                "truncated": text.count > maxFetchText]
    }

    /// Wraps a list of results as the `web_search` return shape.
    public static func searchResult(_ sources: [[String: Any]]) -> [String: Any] {
        ["untrusted": true, "sources": sources]
    }

    /// Reads Bing's RSS search feed.
    ///
    /// The feed is the reliable half of the search path: it is XML with one
    /// `<item>` per result, where the HTML providers are a moving target.
    public static func rssResults(xml: String, baseURL: String) throws -> [[String: Any]] {
        let lowered = xml.lowercased()
        guard !lowered.contains("<!doctype"), !lowered.contains("<!entity") else {
            throw LocalWebError.unsafeXML
        }
        let parser = RSSParser()
        guard let data = xml.data(using: .utf8) else { throw LocalWebError.noResults("RSS search returned no readable results: " + baseURL) }
        let xmlParser = XMLParser(data: data)
        xmlParser.delegate = parser
        xmlParser.shouldResolveExternalEntities = false
        xmlParser.parse()

        var sources: [[String: Any]] = []
        var seen = Set<String>()
        for item in parser.items {
            guard sources.count < maxResults else { break }
            guard let url = try? publicURL(item.link), !item.title.isEmpty else { continue }
            let canonical = url.absoluteString
            guard seen.insert(canonical).inserted else { continue }
            sources.append(["url": canonical,
                            "title": clip(item.title, maxTitle),
                            "snippet": clip(text(fromHTML: item.description), maxSnippet)])
        }
        guard !sources.isEmpty else {
            throw LocalWebError.noResults("RSS search returned no readable results: " + baseURL)
        }
        return sources
    }

    /// Reads a Baidu-style HTML result page.
    ///
    /// A regex approximation of Android's selectors: the document is cut at
    /// each `<h3>`, and each segment contributes the first anchor that resolves
    /// to a public URL plus, if one is present, a snippet container. A missing
    /// snippet is not an error — the URL and title still let the model decide
    /// whether to fetch.
    public static func searchResults(html: String, baseURL: String) throws -> [[String: Any]] {
        var sources: [[String: Any]] = []
        var seen = Set<String>()
        let segments = html.components(separatedBy: "<h3").dropFirst()
        for segment in segments {
            guard sources.count < maxResults else { break }
            guard let anchor = firstAnchor(in: segment) else { continue }
            let rawTarget = anchor.rlLinkHref ?? anchor.dataLogTarget ?? anchor.href
            guard !rawTarget.isEmpty, let url = try? publicURL(resolve(rawTarget, against: baseURL)) else { continue }
            let canonical = url.absoluteString
            guard seen.insert(canonical).inserted, !anchor.text.isEmpty else { continue }
            sources.append(["url": canonical,
                            "title": clip(anchor.text, maxTitle),
                            "snippet": clip(snippet(in: segment), maxSnippet)])
        }
        guard !sources.isEmpty else { throw LocalWebError.noResults("Search returned no readable results") }
        return sources
    }

    /// An absolute URL for a possibly relative reference.
    static func resolve(_ value: String, against base: String) -> String {
        if value.hasPrefix("//") { return "https:" + value }
        if let url = URL(string: value), url.scheme != nil { return value }
        guard let base = URL(string: base) else { return value }
        return URL(string: value, relativeTo: base)?.absoluteString ?? value
    }

    private struct Anchor {
        let href: String
        let rlLinkHref: String?
        let dataLogTarget: String?
        let text: String
    }

    private static func firstAnchor(in segment: String) -> Anchor? {
        guard let expression = try? NSRegularExpression(pattern: "(?is)<a\\b([^>]*)>(.*?)</a>", options: []),
              let match = expression.firstMatch(in: segment, options: [],
                                                range: NSRange(segment.startIndex..<segment.endIndex, in: segment)),
              match.numberOfRanges > 2,
              let attributeRange = Range(match.range(at: 1), in: segment),
              let textRange = Range(match.range(at: 2), in: segment)
        else { return nil }
        let attributes = String(segment[attributeRange])
        let text = text(fromHTML: String(segment[textRange]))
        return Anchor(href: attribute(attributes, "href") ?? "",
                      rlLinkHref: attribute(attributes, "rl-link-href"),
                      dataLogTarget: dataLogTarget(attribute(attributes, "data-log")),
                      text: text)
    }

    private static func snippet(in segment: String) -> String {
        let pattern = "(?is)<(?:div|span|p)[^>]*class=\"[^\"]*(?:c-abstract|result__snippet|b_caption|c-span-last|content-right)[^\"]*\"[^>]*>(.*?)</(?:div|span|p)>"
        guard let expression = try? NSRegularExpression(pattern: pattern, options: []),
              let match = expression.firstMatch(in: segment, options: [],
                                                range: NSRange(segment.startIndex..<segment.endIndex, in: segment)),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: segment)
        else { return "" }
        return text(fromHTML: String(segment[range]))
    }

    private static func attribute(_ attributes: String, _ name: String) -> String? {
        guard let expression = try? NSRegularExpression(pattern: "(?is)\\b" + name + "\\s*=\\s*\"([^\"]*)\"", options: []),
              let match = expression.firstMatch(in: attributes, options: [],
                                                range: NSRange(attributes.startIndex..<attributes.endIndex, in: attributes)),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: attributes)
        else { return nil }
        return decodeEntities(String(attributes[range]))
    }

    /// Baidu hides the real target in `data-log`'s `mu` field.
    private static func dataLogTarget(_ value: String?) -> String? {
        guard let value, !value.isEmpty,
              let data = value.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let target = object["mu"] as? String, !target.isEmpty
        else { return nil }
        return target
    }

    public static func clip(_ value: String, _ length: Int) -> String {
        value.count <= length ? value : String(value.prefix(length))
    }
}

extension String {
    /// Collapses every run of whitespace into one space and trims the ends.
    ///
    /// This is what turns marked-up page source into something close to the
    /// text a reader would see, and it is also what keeps the model from being
    /// handed pages of layout padding.
    func collapsingWhitespace() -> String {
        guard let expression = try? NSRegularExpression(pattern: "\\s+", options: []) else { return self }
        let collapsed = expression.stringByReplacingMatches(
            in: self, options: [], range: NSRange(startIndex..<endIndex, in: self), withTemplate: " ")
        return collapsed.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Collects `<item>` entries from an RSS feed.
///
/// Hand-written rather than using a mapping library because the feed is only
/// ever asked for four fields, and because `shouldResolveExternalEntities` being
/// off is the whole point — a feed is untrusted input.
final class RSSParser: NSObject, XMLParserDelegate {
    struct Item { var title = ""; var link = ""; var description = "" }
    private(set) var items: [Item] = []
    private var current: Item?
    private var field: String?

    func parser(_ parser: XMLParser, didStartElement elementName: String,
                namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        switch elementName.lowercased() {
        case "item": current = Item()
        case "title", "link", "description":
            if current != nil { field = elementName.lowercased() }
        default: break
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        guard let field, current != nil else { return }
        switch field {
        case "title": current?.title += string
        case "link": current?.link += string
        case "description": current?.description += string
        default: break
        }
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String,
                namespaceURI: String?, qualifiedName: String?) {
        switch elementName.lowercased() {
        case "title", "link", "description": field = nil
        case "item":
            if let item = current { items.append(item) }
            current = nil
        default: break
        }
    }
}
