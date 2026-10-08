# Android attachment request bodies

Local provider requests, ordinary remote HTTP requests and the embedded Tailnet client use the same `AttachmentJson.Body`. Request metadata and history retain private file references until a transport reads the body. JSON is walked lazily, with bounded UTF-8 quoting and Base64 buffers. The embedded bridge pulls chunks of at most 32 KiB instead of receiving a fully expanded Java JSON string. It needs no upload worker or unbounded queue.

## Length and compatibility

Requests keep an exact `Content-Length`. A binary attachment's plaintext size is the encrypted file size minus its existing 12-byte IV and 16-byte GCM tag. Its Base64 size is `4 * ceil(size / 3)`. Preparing a body does not open or decrypt binary attachments. Each actual occurrence in the wire JSON opens its file once. A retry opens fresh streams; it does not retain expanded payloads. Protocol fields, data URL prefixes, model content and request IDs are unchanged.

New extracted-text files have a 56-byte encrypted `.meta` companion containing the serializer version, encrypted file size, modification time and quoted UTF-8 byte length. Its AAD binds it to the physical UUID. An old text file is scanned once to create this optional cache. A missing, corrupt or stale cache is rebuilt from the authenticated source; it is never treated as empty text. Length metadata holds no document content. Metadata publication uses `.meta.new` followed by an atomic replacement. Both companions follow the existing reference and 24-hour orphan cleanup policy.

Ordinary strings and extracted text are quoted as streams, including control characters, split surrogate pairs and malformed UTF-8 replacement. Tests compare quoting bytes with Android's `JSONObject.quote`.

## Encryption and memory boundary

The encrypted attachment format and Android Keystore key are unchanged. `AuthenticatedInputStream` reads ciphertext in 64 KiB blocks, verifies the complete AES-GCM tag and declared length, then exposes the authenticated plaintext. It avoids the legacy cipher wrapper's growing output scratch arrays on small reads and reuses the provider's final output when possible. Providers that emit early output use one bounded collection buffer before authentication.

This is not a constant-memory decryption format: the current AES-GCM file can require a complete plaintext buffer, plus provider allocations, for one attachment. Individual files remain capped at 10 MiB (images at 4 MiB through the selection policy). JSON and JNI serialization do not allocate a whole request. No plaintext request or Base64 spool is written to disk. Memory measurements distinguish serialization, one-file decryption, Java heap, process PSS and the Go heap.

## Cancellation and ownership

Upload leases protect referenced files throughout preparation, sending and receipt reading. The Go request closes its Java source on completion, preparation failure, cancellation, header timeout and node shutdown. Source closing does not take the body reader's lock; UTF-8 reader closure interrupts the underlying file first. Partial bodies fail instead of completing JSON after an authentication or length error. Failed and unconfirmed commands retain their existing pending state for explicit retry.

## Verification

`JsonStreamsTest` covers standard Base64 compatibility, short reads, padding, Unicode, exact byte counts, reopening, bounded reads and cancellation. `AuthenticatedInputStreamTest` verifies existing GCM bytes, authentication before plaintext, corrupted tags, changed sizes and blocked-read closure. The Go upload tests check actual HTTP framing, declared lengths, EOF/error handling, prepared cancellation, node closure, deadlines, retries and a 32 MiB expanded transfer.

`AttachmentStreamingTest` checks Android quoting compatibility, file-open counts, new and legacy text metadata, metadata-only orphans, corruption, cancellation, native bridge lifecycle, OpenAI/Anthropic payloads, API-key retries and remote upload leases against a local HTTP fixture. It also measures a 32 MiB mixed-file request and compares the existing cipher wrapper with the new reader on the same 10 MiB file. The local fixture redirects only its own endpoint; production Tailnet target restrictions remain enabled.
