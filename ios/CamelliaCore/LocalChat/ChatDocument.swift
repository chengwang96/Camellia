import Compression
import Foundation

public enum LocalChatDocumentError: Error, Equatable, CustomStringConvertible, LocalizedError {
    case unsupportedLocal
    case unsupportedRemote
    case tooLarge
    case empty
    case invalidPDF
    case noText
    case tooMuchText
    case notText
    case invalidOffice
    case officeTooComplex
    case noOfficeText
    case invalidSharedString
    case dtd
    case fileTooLarge

    public var description: String {
        switch self {
        case .unsupportedLocal:
            return "本机支持 PDF、DOCX、XLSX、PPTX 和文本；其他办公文档请先转换 / Local chat supports PDF, DOCX, XLSX, PPTX and text; convert other office documents first"
        case .unsupportedRemote:
            return "支持 PDF、Word、Excel、PPT、RTF、OpenDocument 和文本文件 / Choose a PDF, Word, Excel, PowerPoint, RTF, OpenDocument or text file"
        case .tooLarge: return "单个文档不能超过 10 MiB / Document exceeds 10 MiB"
        case .empty: return "文档为空 / Document is empty"
        case .invalidPDF: return "PDF 文件无效 / Invalid PDF"
        case .noText: return "未读到文档文字，请转换为 PDF / No document text found; convert it to PDF"
        case .tooMuchText: return "文档文字过多，请拆分文件 / Too much document text; split the file"
        case .notText: return "文档不是文本或文字过多 / Document is not text or contains too much text"
        case .invalidOffice: return "Office 文件无效 / Invalid Office document"
        case .officeTooComplex: return "Office 文件过于复杂 / Office document has too many entries"
        case .noOfficeText: return "Office 文档无可读取的文字 / No readable Office document text"
        case .invalidSharedString: return "Invalid spreadsheet shared string"
        case .dtd: return "Document DTD is not supported"
        case .fileTooLarge: return "文件超过大小限制 / File exceeds size limit"
        }
    }

    public var errorDescription: String? { description }
}

/// A picked document, read once and ready to become an attachment.
///
/// `text` is the extracted plain text for everything that has to be inlined,
/// and nil for a PDF, which the provider can read as a document in its own
/// right. Keeping the bytes beside the text lets the caller decide what to seal
/// on disk: both, in the case of a spreadsheet.
public struct LocalChatDocument: Equatable, Sendable {
    public let name: String
    public let bytes: Data
    public let text: String?
    public let isPDF: Bool

    public init(name: String, bytes: Data, text: String?, isPDF: Bool) {
        self.name = name
        self.bytes = bytes
        self.text = text
        self.isPDF = isPDF
    }

    public var mimeType: String { isPDF ? "application/pdf" : "text/plain" }
    public var size: Int { bytes.count }
}

/// Reading a picked document as text, locally.
///
/// Ported from `ChatDocument.java`. A remote chat can hand the original bytes to
/// the computer, which has real document tooling. The phone cannot, so for local
/// chat it has to read the document itself — plain text directly, and the modern
/// Office formats by unzipping them and pulling the text out of the XML inside.
/// Old binary `.doc`, `.rtf` and OpenDocument are out of reach here and are
/// rejected with a message that says so.
public enum ChatDocument {
    public static let maxText = 2_000_000
    public static let maxExpanded = 32 * 1024 * 1024
    public static let maxEntries = 4096

    /// Extensions read as text as-is.
    public static let textExtensions: Set<String> = [
        "txt", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml", "log", "html", "htm",
    ]
    /// Extensions a remote chat may forward untouched, for the computer to read.
    public static let remoteDocuments: Set<String> = ["doc", "xls", "ppt", "rtf", "odt", "ods", "odp"]
    /// Extensions this client can read itself.
    public static let readableExtensions: Set<String> = ["pdf", "docx", "xlsx", "pptx"]

    // MARK: - Reading

    /// Reads a document, extracting text when this side has to send it.
    ///
    /// `local` is the difference between the two chat modes: a remote chat keeps
    /// the bytes and sends them, a local chat has to produce the text here.
    public static func read(name rawName: String?, data: Data, local: Bool) throws -> LocalChatDocument {
        let name = safeName(rawName)
        let ext = fileExtension(name)
        guard textExtensions.contains(ext)
            || readableExtensions.contains(ext)
            || (!local && remoteDocuments.contains(ext))
        else { throw local ? LocalChatDocumentError.unsupportedLocal : LocalChatDocumentError.unsupportedRemote }
        guard data.count <= AttachmentLimits.documentMaxBytes else { throw LocalChatDocumentError.tooLarge }
        guard !data.isEmpty else { throw LocalChatDocumentError.empty }

        var text: String?
        if ext == "pdf" {
            // A PDF is forwarded as bytes, so the only thing to check is that it
            // actually is one — a mislabelled file would be rejected upstream
            // with a far less useful message.
            guard data.count >= 5, String(decoding: data.prefix(5), as: UTF8.self) == "%PDF-" else {
                throw LocalChatDocumentError.invalidPDF
            }
        } else if local {
            text = textExtensions.contains(ext) ? try decodeText(data) : try officeText(extension: ext, data: data)
        }
        if let text, ComposerText.androidTrim(text).isEmpty {
            throw LocalChatDocumentError.noText
        }
        if let text, text.utf16.count > maxText { throw LocalChatDocumentError.tooMuchText }
        return LocalChatDocument(name: name, bytes: data, text: text, isPDF: ext == "pdf")
    }

    /// The file name as it will be shown and sent.
    ///
    /// Path separators, control characters and the bidi overrides become
    /// underscores: a name is echoed into a request body and into the
    /// transcript, and a right-to-left override in a name is how a file
    /// pretends to be a different file.
    public static func safeName(_ value: String?) -> String {
        let cleaned = (value ?? "document.txt").replacingOccurrences(
            of: #"[\\/\p{Cntrl}\u007f-\u009f\u202a-\u202e\u2066-\u2069]"#,
            with: "_", options: .regularExpression)
        let trimmed = ComposerText.androidTrim(cleaned)
        var name = trimmed
        if name.isEmpty || name == "." || name == ".." { name = "document.txt" }
        if name.utf16.count > 180 {
            let dot = name.lastIndex(of: ".")
            let suffix = (dot != nil && name[dot!...].utf16.count < 16)
                ? String(name[dot!...]) : ""
            name = ComposerText.limited(name, to: 180 - suffix.utf16.count) + suffix
        }
        return name
    }

    public static func fileExtension(_ name: String) -> String {
        guard let dot = name.lastIndex(of: ".") else { return "" }
        return String(name[name.index(after: dot)...]).lowercased()
    }

    /// Caps a byte buffer, refusing anything over the limit outright.
    public static func bounded(_ data: Data, limit: Int) throws -> Data {
        guard data.count <= limit else { throw LocalChatDocumentError.fileTooLarge }
        return data
    }

    /// Reads a Files-provider copy without materializing an unbounded file.
    /// The size metadata is only an early rejection; the stream enforces the
    /// same cap even when a provider omits or misstates that metadata.
    public static func readFile(at url: URL, limit: Int) throws -> Data {
        if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
           size > limit { throw LocalChatDocumentError.fileTooLarge }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var data = Data()
        while let chunk = try handle.read(upToCount: min(32 * 1024, limit - data.count + 1)),
              !chunk.isEmpty {
            guard data.count + chunk.count <= limit else { throw LocalChatDocumentError.fileTooLarge }
            data.append(chunk)
        }
        return data
    }

    // MARK: - Text decoding

    /// Decodes bytes as UTF-16 with a byte-order mark, else strict UTF-8, else
    /// GB18030.
    ///
    /// Strict, not lenient: silently replacing bad bytes would turn a binary
    /// file into a plausible-looking document. Falling back to GB18030 is what
    /// makes a text file saved by a Chinese Windows editor readable, which is
    /// the common case this has to survive.
    public static func decodeText(_ bytes: Data) throws -> String {
        if bytes.count >= 2 {
            if bytes[bytes.startIndex] == 0xff, bytes[bytes.startIndex + 1] == 0xfe,
               let text = String(data: bytes, encoding: .utf16LittleEndian) {
                return try checked(text)
            }
            if bytes[bytes.startIndex] == 0xfe, bytes[bytes.startIndex + 1] == 0xff,
               let text = String(data: bytes, encoding: .utf16BigEndian) {
                return try checked(text)
            }
        }
        if let text = String(data: bytes, encoding: .utf8) { return try checked(text) }
        let encoding = CFStringConvertEncodingToNSStringEncoding(
            CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue))
        if let text = String(data: bytes, encoding: String.Encoding(rawValue: encoding)) {
            return try checked(text)
        }
        throw LocalChatDocumentError.notText
    }

    private static func checked(_ text: String) throws -> String {
        var value = text
        if value.hasPrefix("\u{feff}") { value.removeFirst() }
        if value.unicodeScalars.contains(where: { $0.value == 0 }) || value.utf16.count > maxText {
            throw LocalChatDocumentError.notText
        }
        return value
    }

    // MARK: - Office documents

    /// Pulls the text out of a DOCX, XLSX or PPTX.
    public static func officeText(extension ext: String, data: Data) throws -> String {
        let archive = try ZipArchive(data)
        guard archive.entries.count <= maxEntries else { throw LocalChatDocumentError.officeTooComplex }
        let expanded = archive.entries.reduce(0) { $0 + $1.uncompressedSize }
        guard expanded <= maxExpanded else { throw LocalChatDocumentError.officeTooComplex }

        var wanted: [String: Data] = [:]
        for entry in archive.entries {
            guard isWantedPart(entry.name) else { continue }
            wanted[entry.name] = try archive.data(for: entry)
        }

        let output = OfficeOutput()
        switch ext {
        case "docx":
            try appendWordText(output: output, xml: try required(wanted, "word/document.xml"))
        case "pptx":
            for name in ordered(wanted.keys, prefix: "ppt/slides/slide") {
                output.append("\n[" + name + "]\n")
                try appendWordText(output: output, xml: try required(wanted, name))
            }
        case "xlsx":
            let strings = try sharedStrings(wanted["xl/sharedStrings.xml"])
            for name in ordered(wanted.keys, prefix: "xl/worksheets/sheet") {
                output.append("\n[" + name + "]\n")
                try appendSheetText(output: output, xml: try required(wanted, name), strings: strings)
            }
        default:
            throw LocalChatDocumentError.invalidOffice
        }
        guard !ComposerText.androidTrim(output.text).isEmpty else {
            throw LocalChatDocumentError.noOfficeText
        }
        return output.text
    }

    private static func isWantedPart(_ name: String) -> Bool {
        name == "word/document.xml" || name == "xl/sharedStrings.xml"
            || name.matches(#"^xl/worksheets/sheet[0-9]+\.xml$"#)
            || name.matches(#"^ppt/slides/slide[0-9]+\.xml$"#)
    }

    private static func required(_ entries: [String: Data], _ name: String) throws -> Data {
        guard let data = entries[name] else { throw LocalChatDocumentError.invalidOffice }
        return data
    }

    /// Part names sorted by their numeric suffix, so slide 10 follows slide 9.
    static func ordered(_ names: some Sequence<String>, prefix: String) -> [String] {
        names.filter { $0.hasPrefix(prefix) }
            .sorted { left, right in
                let a = Int(left.dropFirst(prefix.count).dropLast(4)) ?? 0
                let b = Int(right.dropFirst(prefix.count).dropLast(4)) ?? 0
                return a < b
            }
    }

    private static func appendWordText(output: OfficeOutput, xml: Data) throws {
        let parser = WordTextParser(output: output)
        try runParser(xml, delegate: parser)
    }

    private static func appendSheetText(output: OfficeOutput, xml: Data, strings: [String]) throws {
        let parser = SheetTextParser(output: output, strings: strings)
        try runParser(xml, delegate: parser)
    }

    static func sharedStrings(_ data: Data?) throws -> [String] {
        guard let data else { return [] }
        let parser = SharedStringsParser()
        try runParser(data, delegate: parser)
        return parser.strings
    }

    /// Runs a parser over document XML.
    ///
    /// A DTD is refused before parsing starts. Documents are untrusted, and an
    /// entity declaration is the classic way to make an XML parser read a local
    /// file or expand into gigabytes.
    private static func runParser(_ data: Data, delegate: XMLParserDelegate) throws {
        if let text = String(data: data, encoding: .utf8), text.uppercased().contains("<!DOCTYPE") {
            throw LocalChatDocumentError.dtd
        }
        let parser = XMLParser(data: data)
        parser.delegate = delegate
        parser.shouldProcessNamespaces = true
        parser.shouldResolveExternalEntities = false
        parser.parse()
        if let failure = (delegate as? OfficeXMLDelegate)?.failure { throw failure }
    }
}

/// The accumulating text plus its cap, shared by the XML delegates.
///
/// `XMLParser` cannot throw from a delegate, so a failure is recorded and the
/// parse is aborted; the caller rethrows it once `parse()` returns.
final class OfficeOutput {
    private(set) var text = ""
    private var units = 0
    var failure: LocalChatDocumentError?

    func append(_ value: String) {
        guard failure == nil else { return }
        let added = value.utf16.count
        if units + added > ChatDocument.maxText {
            failure = .tooMuchText
            return
        }
        text += value
        units += added
    }
}

class OfficeXMLDelegate: NSObject, XMLParserDelegate {
    var failure: LocalChatDocumentError?
    /// Aborts the parse once a limit is hit, so a hostile document cannot make
    /// the parser work through megabytes it will then throw away.
    func abort(_ parser: XMLParser, _ error: LocalChatDocumentError) {
        failure = error
        parser.abortParsing()
    }
}

/// Reads `<w:t>` runs out of a Word document or a slide.
final class WordTextParser: OfficeXMLDelegate {
    private let output: OfficeOutput
    private var collecting = false

    init(output: OfficeOutput) { self.output = output }

    func parser(_ parser: XMLParser, didStartElement elementName: String,
                namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        switch elementName {
        case "t": collecting = true
        case "tab": output.append("\t")
        default: break
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        if collecting { output.append(string) }
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String,
                namespaceURI: String?, qualifiedName: String?) {
        switch elementName {
        case "t": collecting = false
        case "p", "br": output.append("\n")
        default: break
        }
        if output.failure != nil { abort(parser, output.failure!) }
    }
}

/// Reads the shared string table of a spreadsheet.
final class SharedStringsParser: OfficeXMLDelegate {
    private(set) var strings: [String] = []
    private var current: String?
    private var currentUnits = 0
    private var collecting = false

    func parser(_ parser: XMLParser, didStartElement elementName: String,
                namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        switch elementName {
        case "si": current = ""; currentUnits = 0
        case "t": if current != nil { collecting = true }
        default: break
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        guard collecting, let current else { return }
        let added = string.utf16.count
        if currentUnits + added > ChatDocument.maxText {
            abort(parser, .tooMuchText)
            return
        }
        self.current = current + string
        currentUnits += added
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String,
                namespaceURI: String?, qualifiedName: String?) {
        switch elementName {
        case "t": collecting = false
        case "si":
            strings.append(current ?? "")
            current = nil
        default: break
        }
    }
}

/// Reads a worksheet: each cell as `A1=value`, cells tab-separated, rows by line.
final class SheetTextParser: OfficeXMLDelegate {
    private let output: OfficeOutput
    private let strings: [String]
    private var type = ""
    private var collecting = false
    private var value = ""

    init(output: OfficeOutput, strings: [String]) {
        self.output = output
        self.strings = strings
    }

    func parser(_ parser: XMLParser, didStartElement elementName: String,
                namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        switch elementName {
        case "c":
            type = attributes["t"] ?? ""
            if let reference = attributes["r"] { output.append(reference + "=") }
        case "v", "t":
            collecting = true
            value = ""
        default: break
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        if collecting { value += string }
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String,
                namespaceURI: String?, qualifiedName: String?) {
        switch elementName {
        case "v", "t":
            collecting = false
            var text = value
            if type == "s" {
                guard let index = Int(text), index >= 0, index < strings.count else {
                    abort(parser, .invalidSharedString)
                    return
                }
                text = strings[index]
            }
            output.append(text)
        case "c": output.append("\t")
        case "row": output.append("\n")
        default: break
        }
        if output.failure != nil { abort(parser, output.failure!) }
    }
}

/// The smallest ZIP reader that can open an Office document.
///
/// Office files are ZIP containers, and Foundation has no public reader. Rather
/// than link a library, this reads the central directory — the authoritative
/// one, so an entry whose sizes were hidden behind a streaming data descriptor
/// still reports them — and inflates each part with the system's raw DEFLATE
/// decoder. Entries are only decompressed on demand, so the wanted part is the
/// only part that costs anything.
struct ZipArchive {
    struct Entry {
        let name: String
        let method: UInt16
        let compressedSize: Int
        let uncompressedSize: Int
        let localOffset: Int
    }

    private let data: Data
    private(set) var entries: [Entry] = []

    init(_ data: Data) throws {
        self.data = data
        let endOfDirectory = try Self.endOfCentralDirectory(in: data)
        let count = Int(Self.u16(data, endOfDirectory + 10))
        var offset = Int(Self.u32(data, endOfDirectory + 16))
        guard count != 0xffff, offset != 0xffff_ffff else {
            // ZIP64: an Office document this large would have been refused on
            // size long before now.
            throw LocalChatDocumentError.invalidOffice
        }
        guard offset >= 0, offset < data.count else { throw LocalChatDocumentError.invalidOffice }
        for _ in 0..<count {
            guard offset + 46 <= data.count, Self.u32(data, offset) == 0x02014b50 else {
                throw LocalChatDocumentError.invalidOffice
            }
            let nameLength = Int(Self.u16(data, offset + 28))
            let extraLength = Int(Self.u16(data, offset + 30))
            let commentLength = Int(Self.u16(data, offset + 32))
            guard offset + 46 + nameLength <= data.count else { throw LocalChatDocumentError.invalidOffice }
            let name = String(decoding: data[(offset + 46)..<(offset + 46 + nameLength)], as: UTF8.self)
            entries.append(Entry(
                name: name,
                method: Self.u16(data, offset + 10),
                compressedSize: Int(Self.u32(data, offset + 20)),
                uncompressedSize: Int(Self.u32(data, offset + 24)),
                localOffset: Int(Self.u32(data, offset + 42))))
            offset += 46 + nameLength + extraLength + commentLength
        }
    }

    func data(for entry: Entry) throws -> Data {
        let base = entry.localOffset
        guard base >= 0, base + 30 <= data.count, Self.u32(data, base) == 0x04034b50 else {
            throw LocalChatDocumentError.invalidOffice
        }
        let nameLength = Int(Self.u16(data, base + 26))
        let extraLength = Int(Self.u16(data, base + 28))
        let start = base + 30 + nameLength + extraLength
        guard start >= 0, start + entry.compressedSize <= data.count else {
            throw LocalChatDocumentError.invalidOffice
        }
        let payload = Data(data[start..<(start + entry.compressedSize)])
        switch entry.method {
        case 0: return payload
        case 8: return try Self.inflate(payload, expected: entry.uncompressedSize)
        default: throw LocalChatDocumentError.invalidOffice
        }
    }

    /// Finds the end-of-central-directory record, which sits at the very end
    /// unless a comment was appended after it.
    private static func endOfCentralDirectory(in data: Data) throws -> Int {
        let minimum = 22
        guard data.count >= minimum else { throw LocalChatDocumentError.invalidOffice }
        let lowest = max(0, data.count - (0xffff + minimum))
        var index = data.count - minimum
        while index >= lowest {
            if u32(data, index) == 0x06054b50 { return index }
            index -= 1
        }
        throw LocalChatDocumentError.invalidOffice
    }

    private static func u16(_ data: Data, _ offset: Int) -> UInt16 {
        guard offset >= 0, offset + 2 <= data.count else { return 0 }
        return UInt16(data[offset]) | UInt16(data[offset + 1]) << 8
    }

    private static func u32(_ data: Data, _ offset: Int) -> UInt32 {
        guard offset >= 0, offset + 4 <= data.count else { return 0 }
        return UInt32(data[offset])
            | UInt32(data[offset + 1]) << 8
            | UInt32(data[offset + 2]) << 16
            | UInt32(data[offset + 3]) << 24
    }

    /// Inflates a raw DEFLATE stream.
    ///
    /// `COMPRESSION_ZLIB` is Apple's name for exactly what a ZIP entry holds —
    /// DEFLATE as described by RFC 1951, without the zlib wrapper that the name
    /// suggests.
    static func inflate(_ input: Data, expected: Int) throws -> Data {
        guard expected > 0 else { return Data() }
        var output = Data(count: expected)
        let written = output.withUnsafeMutableBytes { destination -> Int in
            guard let base = destination.bindMemory(to: UInt8.self).baseAddress else { return 0 }
            return input.withUnsafeBytes { source -> Int in
                guard let bytes = source.bindMemory(to: UInt8.self).baseAddress else { return 0 }
                return compression_decode_buffer(base, expected, bytes, input.count, nil, COMPRESSION_ZLIB)
            }
        }
        // A short result means the stream was truncated or the declared size was
        // a lie; either way the part cannot be trusted.
        guard written == expected else { throw LocalChatDocumentError.invalidOffice }
        return output
    }
}
