# Android private attachment cleanup

Phone attachments are AES-GCM encrypted files in `noBackupFilesDir/chat-attachments`. Images can have a `.thumb` companion; extracted text can have encrypted length metadata in `.meta` and an interrupted `.meta.new` publication. All companions follow the same ownership policy. Binary and extracted-text references share the same physical UUID namespace. Downloads outside this directory and attachments stored on the desktop are outside the collector's scope.

## Ownership and release

`AttachmentMaintenance` owns one background queue for regular remote chats, discussions and local chats. Its retained set includes:

- All paired-computer profiles, ordinary-chat drafts and pending commands in `remote-private`.
- Drafts and pending commands in every profile in `remote-discussions-private`.
- The verified local SQLite `refs` index, plus legacy `local-chat-private` references before migration finishes.
- Process-owned leases for attachment imports, visible selections, the current discussion profile (including unsaved state), active HTTP requests, and queued or failed local writes.

The collector compares physical UUIDs, so a `camellia-text:` reference protects the same file as the corresponding `camellia-blob:` reference. Protocol data URLs containing private references are included in upload leases.

Credential stores publish removed references only after a successful commit. Local transactions retain their durable `garbage` records until a background pass has processed them. Cleanup never deletes a file while another owner retains it. Failed or unconfirmed sends keep their original request IDs and attachments for retry; a discussion receipt with an unknown state does not drop the pending request.

A completed send releases the original command's attachments even if its page is no longer open. A newer draft with different attachments remains intact. Confirmed conversation/group deletion drops its saved drafts. Forgetting a computer also removes its discussion profiles while retaining other computers' drafts.

Discussion receipts commit the new state before clearing the composer; a failed commit leaves the original pending request and selection available for retry. A page merges only its current profile into the latest stored discussion state, so an open page for another computer cannot restore a forgotten profile from a stale cache.

## Recovery and scheduling

Entering any chat activity schedules a full sweep when the last successful sweep is at least 24 hours old. The latest modification of an unreferenced file and its companions must be at least 24 hours old for this recovery sweep. Files with live references have no age-based expiry. Known released files can be collected promptly without waiting for the grace period.

Directory enumeration and reference reads run on the collector's worker. It reads reference metadata instead of decrypting attachment bodies or loading local message history. Unsupported/unverified local database schemas and unreadable credential stores abort the pass; they are never interpreted as empty ownership.

State writes and lease changes advance a process revision. The collector checks that revision before deleting each attachment and its companions. A concurrent change defers the remaining work and coalesces a new pass. The coordination gate does not cover encryption, preference commits, database transactions or directory scans. Failed file deletions remain candidates for a later foreground pass; reference-read failures retry after a subsequent foreground entry or release.

The 24-hour sweep runs when the application is used, not while its process is absent. A process crash between file creation and metadata publication can therefore leave a temporary orphan until the next eligible foreground sweep.

## Verification

`AttachmentMaintenanceTest` exercises persisted owners, shared aliases, age-based recovery, thumbnail-only orphans, import handoff, protocol upload leases, concurrent state writes, unreadable ownership, migration guards, failed local writes, computer removal, switched-group receipts, failed discussion saves and newer ordinary-chat drafts. `LocalChatStorageTest` also verifies that local deletion waits for the last committed owner before reclaiming a file.
