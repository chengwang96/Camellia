import Foundation

/// The one threshold the desktop, Android and iOS composers share.
///
/// A pasted block at least this long becomes a `.txt` attachment instead of a
/// very large prompt, because engines truncate or reject those. The desktop
/// value is 5000 UTF-16 code units; Android compares `CharSequence.length()`
/// and iOS compares `String.utf16.count`, so all three agree at the boundary.
public enum LongPaste {
    public static let minLength = 5000

    public static func shouldAttach(_ text: String) -> Bool {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return false
        }
        return text.utf16.count >= minLength
    }

    /// The name the tray shows for a pasted block.
    public static func fileName(at date: Date = Date()) -> String {
        let millis = Int64((date.timeIntervalSince1970 * 1000).rounded())
        return "pasted-text-\(millis)-\(UUID().uuidString.lowercased()).txt"
    }
}
