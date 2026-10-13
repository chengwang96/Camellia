import Foundation

/// Persistent Files-folder access, equivalent to Android's SAF directory grant.
/// https://developer.apple.com/documentation/uikit/providing-access-to-directories
public enum DownloadDirectory {
    public enum Failure: Error, CustomStringConvertible {
        case invalidFolder, expiredAccess

        public var description: String {
            switch self {
            case .invalidFolder: return "请选择可写入的文件夹 / Select a writable folder"
            case .expiredAccess: return "下载目录访问已失效，请重新选择文件夹 / Folder access has expired; select the folder again"
            }
        }
    }

    public static func bookmark(for folder: URL) throws -> Data {
        guard folder.isFileURL else { throw Failure.invalidFolder }
        let scoped = folder.startAccessingSecurityScopedResource()
        defer { if scoped { folder.stopAccessingSecurityScopedResource() } }
        guard try folder.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else {
            throw Failure.invalidFolder
        }
        // A successful write verifies provider access before replacing a saved grant.
        let probe = folder.appendingPathComponent(".camellia-access-\(UUID().uuidString)")
        try Data().write(to: probe, options: .withoutOverwriting)
        try FileManager.default.removeItem(at: probe)
        return try folder.bookmarkData(options: .minimalBookmark,
                                       includingResourceValuesForKeys: nil, relativeTo: nil)
    }

    public static func resolve(_ bookmark: Data) throws -> (url: URL, refreshed: Data?) {
        var stale = false
        let url: URL
        do {
            url = try URL(resolvingBookmarkData: bookmark, options: .withoutUI,
                          relativeTo: nil, bookmarkDataIsStale: &stale)
        } catch { throw Failure.expiredAccess }
        guard url.isFileURL else { throw Failure.invalidFolder }
        return (url, stale ? try self.bookmark(for: url) : nil)
    }

    public static func filename(_ name: String) -> String {
        let safe = name.map { character -> Character in
            character == "/" || character == "\\" || character.unicodeScalars.contains(where: {
                CharacterSet.controlCharacters.contains($0)
            }) ? "_" : character
        }
        let result = ComposerText.androidTrim(String(safe))
        return result.isEmpty || result == "." || result == ".." ? "download" : result
    }

    /// Copies from the bounded-memory download file; never overwrites a user's file.
    public static func save(_ source: URL, named name: String, in folder: URL) throws -> URL {
        let scoped = folder.startAccessingSecurityScopedResource()
        defer { if scoped { folder.stopAccessingSecurityScopedResource() } }
        guard try folder.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else {
            throw Failure.invalidFolder
        }
        var coordinationError: NSError?
        var outcome: Result<URL, Error>?
        NSFileCoordinator().coordinate(writingItemAt: folder, options: .forMerging,
                                      error: &coordinationError) { directory in
            outcome = Result {
                let safe = filename(name)
                let ext = (safe as NSString).pathExtension
                let stem = ext.isEmpty ? safe : String(safe.dropLast(ext.count + 1))
                for number in 0..<10_000 {
                    let candidate = number == 0 ? safe
                        : stem + " (\(number))" + (ext.isEmpty ? "" : "." + ext)
                    let target = directory.appendingPathComponent(candidate, isDirectory: false)
                    if FileManager.default.fileExists(atPath: target.path) { continue }
                    do {
                        try FileManager.default.copyItem(at: source, to: target)
                        return target
                    } catch let error as CocoaError where error.code == .fileWriteFileExists { continue }
                }
                throw Failure.invalidFolder
            }
        }
        if let coordinationError { throw coordinationError }
        guard let outcome else { throw Failure.expiredAccess }
        return try outcome.get()
    }
}
