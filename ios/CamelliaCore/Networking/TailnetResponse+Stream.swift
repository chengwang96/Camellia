import Foundation
import Tailnet

/// Reading an embedded response to its end.
///
/// The generated binding makes a clean end of stream indistinguishable from a
/// failed read, and this extension is where that is repaired once so every
/// caller does not have to.
///
/// `bridge.go` ends a stream by returning a zero-length chunk with no error.
/// gomobile's `fromSlice` collapses *any* zero-length slice — nil or not — into
/// a NULL pointer, `go_seq_to_objc_bytearray` turns that into a NULL `NSData`,
/// and Swift imports `readChunk` as returning a non-optional `Data`, so the NULL
/// cannot come back as a value and arrives as a thrown `_GenericObjCError`
/// instead. Read naively, every stream that ends normally looks like a failure.
///
/// `Finished()` on the Go side is what settles it: it is set only when the body
/// was drained, not when a read timed out or the connection dropped.
extension TailnetResponse {
    /// The next chunk, or `nil` once the stream has ended.
    ///
    /// A genuinely failed read still throws, so a timeout or a dropped
    /// connection is not silently mistaken for a finished stream.
    public func nextChunk() throws -> Data? {
        do {
            let chunk = try readChunk()
            return chunk.isEmpty ? nil : chunk
        } catch {
            if finished() { return nil }
            throw error
        }
    }

    /// Reads until the stream ends, stopping at `limit` bytes.
    ///
    /// The bound matters: an SSE snapshot is replaced wholesale on every event,
    /// and a caller that reads without one can be made to buffer without limit.
    public func readAll(limit: Int = 8 << 20) throws -> Data {
        var body = Data()
        while let chunk = try nextChunk() {
            body.append(chunk)
            if body.count >= limit { break }
        }
        return body
    }
}
