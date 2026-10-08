# Camellia for Android

Camellia's Android client is a native Java/View application for Android 8.0 (API 26) and newer. It has local provider chat and a separate remote-control view for paired desktop conversations. The current release is `1.0.0` (`versionCode` 86). The signed phone package is `dist/Camellia-Android-1.0.0.apk` (ARM64), also exported as `dist/Camellia-Android-1.0.0-arm64-v8a.apk`. Use `dist/Camellia-Android-1.0.0-x86_64.apk` for x86_64 emulators or devices; packages ending in `-debug.apk` are development builds.

## Local chat

Local conversations call the selected provider directly from the phone. They do not need a paired computer and may consume provider quota. Provider keys, conversation history, drafts, and imported attachments are encrypted with Android Keystore in the app's private storage. The Android app does not execute desktop tools or workspace commands for a local chat. Moving the app to the background stops an active local request; an interrupted request is not silently resent.

The local composer accepts text, images, and supported documents. Its status footer remains visible, showing Ready while idle and the current sending, reply, attachment or editing state. It shares the remote composer's font, spacing and single-line height. Modern Office and text files are extracted locally; PDF uses native document input when the selected provider and model support it. Legacy Office, RTF, and OpenDocument files should be converted to a supported format for local chat. The app supports system/light/dark themes and English/Simplified Chinese interface languages.

Local and remote lists show a centered welcome only when there are no workspaces or conversations in the visible scope. It offers explicit standalone-chat and workspace creation actions, subject to remote permissions; existing discussion groups remain visible. The completely empty local welcome hides the unused search dock. Empty workspaces stay in the normal list with a compact hint and their own creation button. Search results, remote synchronization and load failures have separate empty states. Short screens scroll the welcome within the available viewport. A new chat shows a short welcome above the composer without a duplicate message-entry button.

Local chat storage uses encrypted SQLite records with a process-owned background writer. Opening the list reads metadata; opening a conversation reads its history. Draft updates are coalesced, streamed replies use periodic checkpoints, and normal close waits for pending writes. Existing encrypted preference data is migrated in a verified transaction before its old copy is removed. See [local storage details](../docs/android-local-storage.md) for the format and recovery behavior.

Local chat, remote chat and discussions share an incremental native Markdown renderer. Streaming replies retain completed views, update the unfinished suffix on background parser threads, and reconcile final formatting once on completion. See [streaming Markdown details](../docs/android-streaming-markdown.md) for the update rules and verification limits.

## Remote desktop conversations

1. On the computer, enable **Settings → Mobile access**, sign in to its embedded Tailscale node, and generate a pairing code. See the [desktop remote access guide](../docs/remote-access.md).
2. On Android, sign in to the embedded network on the same Tailnet. Scan the desktop QR code or enter its Tailnet IPv4 address, port (default `43127`), and one-time code.
3. Approve the named phone on the desktop. The phone can then select among its paired computers and the conversations each computer authorizes.

The embedded network uses a bundled Go/JNI `tsnet` helper; it is a user-space connection for Camellia, not a system VPN for other apps. An external Tailscale mode is also available. The client only accepts explicit Tailnet IPv4 endpoints for desktop control, never follows redirects, and does not put device tokens in URLs. If network or authorization is lost, local chat remains available. The remote view reconnects and reloads snapshots after returning to the foreground; it does not automatically replay an unconfirmed send, stop, or approval.

Node startup, shutdown, mode persistence and identity removal share one background lifecycle queue. Main-thread page and download hooks only update short-lived state; concurrent connections share initialization, and stale startup results are closed before replacement. See [embedded network lifecycle](../docs/android-network-lifecycle.md).

Remote conversations support model and reasoning selection, a permission level, queueing, current-run stop, one-time tool approvals, questions, file finding, artifact downloads, and Goal/scheduled-task controls when the desktop advertises those capabilities. During a run, supported model, reasoning, and Codex Fast changes apply to the next turn; connection and permission changes wait for an idle conversation. The list's header search button opens a search field above the conversations; closing it or going back clears the filter. Create conversations with the buttons beside their workspace or the independent-conversation section. Long-press a list row to rename, pin, archive, select, or delete when the host supports the action. Deleting a conversation does not delete its workspace files.

On capable Windows hosts, **Agent discussions (beta)** appear in the same navigation list. A group can have up to four members and can route a message to selected members in parallel or serial order. The phone can view member verification, tool activity, approvals, answers, and referenced artifacts. A host that does not advertise discussions leaves the entry unavailable; Linux server discussion support is not enabled by this Android feature.

The phone retains at most 600 completed discussion messages and 4 MiB of estimated associated record weight, while preserving current reply and approval controls. Earlier-history loading stops when this window is full; the complete history and member contexts remain on the computer. See [discussion history retention](../docs/android-discussion-history.md) for accounting, paging and cleanup behavior.

Remote conversation lists share a process-owned cache writer. Updates are combined within a fixed 250 ms window, and slow saves retain only the latest pending state. Leaving the screen asynchronously flushes that state; reopening it uses the same in-memory cache. See [list cache persistence](../docs/android-list-cache.md).

Conversation prefetch follows the selected computer's visible list: up to four visible previews and two nearby previews after idle time. It does not walk later list pages or continue downloading other chats while a conversation is open. The preview cache and response reads have fixed limits. See [conversation prefetch](../docs/android-prefetch.md).

Leaving a local chat, remote conversation or discussion releases its View bindings and pending scroll work after preserving its draft. Backgrounding the app retains the current page for resume. See [chat page lifecycle](../docs/android-chat-view-lifecycle.md).

### Attachments and downloads

Local and remote messages can combine up to 20 image and document attachments. Images are resized to at most 3072 px on their long edge and encoded as JPEG at no more than 4 MiB each; individual documents are limited to 10 MiB. Remote transmission has an additional 32 MiB aggregate limit. Discussion sends use the host's smaller 16-attachment limit. A newer host advertises `expanded-attachments` and allows the larger remote transfer; older hosts may cap a send at nine files and 8 MiB, or support images only. The UI reports an unsupported limit instead of silently dropping files.

Uploads and drafts remain encrypted on the phone. A foreground artifact download continues as an Android `dataSync` foreground service if the app leaves the screen, with a notification and cancel control. A lost network or killed process requires a manual retry; a download is not automatically restarted.

Attachment requests are encoded as bounded chunks across local-provider, ordinary HTTP and embedded-network sends. Binary files are read once per wire occurrence; text files cache only their encoded length. The existing AES-GCM format still requires authentication of one whole file before exposing its plaintext. See [attachment request streaming](../docs/android-attachment-streaming.md) for memory boundaries and verification.

Local Office imports open only the required ZIP entries and parse XML as a stream. Shared strings and extracted output have cumulative budgets. A compressed original temporarily occupies at most 10 MiB in the private Office cache and is removed when the import finishes; process startup and daily maintenance reclaim interrupted imports. See [Office import limits and ownership](../docs/android-office-import.md).

Private attachment files are reclaimed after their last saved or active reference is released. A foreground sweep also removes unreferenced files older than 24 hours, at most once per day after a successful sweep. Pending sends and local history remain protected. See [private attachment cleanup](../docs/android-attachment-cleanup.md).

### Device and permission boundaries

The phone stores device tokens and pending command IDs using Android Keystore AES-GCM. Pairing grants access only after desktop approval. A desktop revocation closes live streams and denies subsequent requests. Approved devices can see secrets that a user or model included in an authorized conversation's text or referenced artifact, so pair only trusted devices. Importing the desktop's API-route bundle is a separate, confirmed action under **Settings → Providers & Keys → Configuration migration**; it replaces the phone's provider settings but keeps local chat history and does not change the desktop.

When a remote operation has no confirmed receipt, inspect its status and retry with the **same request ID**. A timeout does not prove the host never executed it. An approval is tied to the host instance, conversation/group, run, request ID, and content fingerprint; a stale approval cannot authorize a later run.

## Build and test

### Signed release APK

On Windows, create a signing key once and build the release APK from the repository root:

```powershell
.\scripts\create-android-release-key.ps1
.\scripts\build-android-release.ps1
```

The build script rebuilds the Tailnet library, runs `assembleRelease` with ABI splitting, verifies each APK's signature, non-debuggable manifest, native-library alignment and ZIP contents, and exports both architecture packages with SHA-256 checksums and size reports to `dist/`. Release builds enable R8 and resource shrinking; the corresponding obfuscation mapping is retained in `dist/`. The default phone filename is a copy of the ARM64 package. Native libraries stay uncompressed so Android can load them directly from the APK. See [package size and Release verification](../docs/android-package-size.md) for measurements and testing. Later releases must use the **same signing key**. The key and its Windows user-encrypted password are kept in `%USERPROFILE%\.camellia\android-signing\`, outside the repository. Back up the keystore and its password in a secure place: the encrypted password file can only be opened by the current Windows user. To recover the password for backup, run the following locally and store its output in a password manager:

```powershell
Get-Content "$env:USERPROFILE\.camellia\android-signing\password.dpapi" -Raw |
  ConvertTo-SecureString |
  ForEach-Object { [System.Net.NetworkCredential]::new('', $_).Password }
```

For a different build machine, provide `CAMELLIA_ANDROID_KEYSTORE`, `CAMELLIA_ANDROID_KEYSTORE_PASSWORD`, `CAMELLIA_ANDROID_KEY_ALIAS`, and `CAMELLIA_ANDROID_KEY_PASSWORD` as environment variables. An installed debug build uses a different signing key and cannot be upgraded in place to the release build; back up its local data before replacing it.

### Debug build and tests

On Windows, prepare the pinned Tailnet JNI dependency before Gradle:

```powershell
cd android
.\build-tailnet.ps1
.\gradlew.bat assembleDebug testDebugUnitTest lintDebug assembleDebugAndroidTest
```

On Linux, use `bash android/build-tailnet.sh` from the repository root, then the Gradle wrapper in `android/`. The APK produced by Gradle is `android/app/build/outputs/apk/debug/app-debug.apk`. Installing over an existing build requires the same signing key; do not clear application data for an upgrade test.

```powershell
adb devices -l
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n app.camellia.mobile/.MainActivity
```

Instrumentation tests can clear the app's own data and should run on a disposable emulator, not a personal phone. Select it explicitly with `ADB` and `ANDROID_SERIAL` before running the pairing, gateway, or discussion smoke scripts in `tests/`. The GitHub Android workflow builds JNI libraries, the APK, unit tests, Lint, and emulator UI integration tests. Emulator loopback checks do not establish physical-device Tailnet behavior; verify real pairing, Wi-Fi/cellular changes, background recovery, and download continuity on a phone before a release.
