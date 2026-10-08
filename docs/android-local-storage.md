# Android local chat storage

The local chat store uses `local-chat-v2.db` in the app's no-backup directory. Provider configuration, workspace data, conversation metadata, drafts, and individual messages are separate AES-GCM encrypted records. The record type, owner, and message position are authenticated with the ciphertext. Attachment contents remain in the existing encrypted attachment files; migration retains their references and Android Keystore key.

## Reads and writes

`LocalChatWriter` owns one database connection and one serial executor for the application process. Serialization, encryption, SQLite access, quota checks, attachment cleanup, and WAL checkpoints run there. Activities receive results on the main thread. The writer survives Activity destruction.

The UI retains the conversation index and the open conversation's history. It releases that history on returning to the list. Message payloads larger than Android's `CursorWindow` are read in bounded encrypted slices.

Typing queues a detached draft snapshot at a 350 ms cadence. Only the latest pending snapshot for a record is retained. A send commits the user message, initial reply, edited-history truncation, metadata, and cleared draft together before starting the API request. Request construction also runs on the storage worker. A stale history length rejects the send instead of overwriting newer messages.

Text replies checkpoint at approximately three-second intervals. Tool updates coalesce for 750 ms; completed tool steps and final replies queue immediately. Each reply has a run token and increasing revision. An older checkpoint cannot overwrite a newer checkpoint, a completed reply, or a message position reused by another run.

Stopping, leaving the app, and normal close flush pending records. Normal close waits asynchronously for persistence. If the page closes before a send has committed, its callback cancels the unstarted request, marks the reply interrupted, and restores an editable draft.

Failed coalesced writes keep their latest detached record for retry and release UI callbacks. Provider configuration also retains its edited snapshot after failure. Errors remain visible; explicit retry and flush attempt persistence again. The existing logical quota of `8 * 1024 * 1024` JSON characters is tracked by per-record deltas, without serializing the entire library.

A pending save failure does not prevent opening the conversation index to delete old chats and free space. Reopening a conversation restores its failed draft and matching reply snapshots in memory. Startup recovery runs once per process and waits for pending reply saves to succeed, so it cannot replace a retryable final reply with an older interruption marker.

## Migration and cleanup

On first open, the storage worker decrypts `local-chat-private`, partitions its state into records, then reads and compares every imported record inside the same transaction. The completion flag commits with the records. Only after that verified commit does the worker clear the old encrypted preference copy. A decryption, schema, quota, or import failure preserves the old ciphertext and rolls back imported rows. The UI offers a read retry.

If a previous run committed migration but did not remove the old copy, the next open uses the completion flag and retries cleanup without importing stale data over the database. The Android Keystore key and unrelated credential stores are retained. Older APKs that only understand the preference format cannot display the v2 database.

Each record's attachment references update in its transaction. Removed references enter a persistent cleanup queue. Files are deleted only after commit and only when no saved record references them; failed removals remain queued. Failed transactions therefore cannot delete retained attachments. Deleting conversations also runs incremental database vacuuming and a WAL checkpoint. The store initializes incremental vacuuming before using its schema and consumes the vacuum result until completion. Post-commit maintenance errors do not report an already committed send as failed.

## Validation

`LocalChatStorageTest` covers verified migration and retry, failed migration rollback, large histories with unchanged older ciphertext, large Unicode records, revision and run-token guards, coalesced immutable drafts, quota and injected write failures, shared attachment deletion, interrupted-run recovery, closing before send commit, database file shrinking after history deletion, and main-thread disk access during autosave and normal close.

The Android instrumentation fixtures retain a full-snapshot setup interface for existing tests only. That helper is part of `androidTest` and is not shipped in the application.
