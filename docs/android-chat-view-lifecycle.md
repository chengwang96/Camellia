# Android chat page lifecycle

Local chats, remote conversations and discussions release their page bindings when the Activity replaces the page or is destroyed. Returning to a list no longer leaves an input bar, message container, attachment tray or member roster holding the previous chat hierarchy through its parent links.

## Ownership and cleanup

Each chat Activity uses a single `releasePageViews()` entry point from its page builder and destruction path. It disposes streaming Markdown bindings, closes the status component where present, dismisses and releases page popups, and clears page-specific and shared View fields. The existing message binding maps are emptied as part of the same path.

Short-lived View work uses an Activity-owned `viewHandler`. Page replacement removes its queued scroll, focus and approval-notification callbacks. Network delivery and local database completion keep their existing handlers and ownership checks, so clearing a page does not discard a save completion or an unconfirmed remote command.

Remote conversations explicitly remove their pending pre-draw scroll listener and clear its ScrollView owner. The scroll revision advances when that work is cleared. Discussions use their existing scroll-listener cleanup, and streaming Markdown disposal closes its scroll anchor in all three chat modes.

Local configuration and rename dialogs bind their save callback to the submitting dialog. A completed save can update the page while that dialog still owns it. After navigation, the save finishes without rebuilding the new page or trying to use a released dialog field.

## Drafts, transitions and backgrounding

Navigation saves the old conversation's text, attachments and edit target before changing its identifier. Discussions also preserve the selected respondents and reply mode. Local draft writes already capture their data before entering the background writer. UI cleanup does not remove saved conversation records, native model context, pending command receipts or the bounded preview cache.

`PageTransitions` continues to own the outgoing hierarchy until it captures a bitmap and detaches the old root. Releasing Activity fields and renderer bindings leaves the outgoing children intact for that capture. The existing transition completion, interruption and detach paths clear the bitmap and animation references.

Ordinary `onStop()` retains the current chat page so it can resume. Existing request behavior still applies: local requests stop on backgrounding, while remote requests follow their connection lifecycle. The View cleanup runs when a page is replaced and in `onDestroy()`.

## Verification

`ChatViewReleaseTest` exercises real page exits in all three Activities. It checks that no Activity View field refers to an outgoing root or one of its descendants, message renderers are disposed, pre-draw scroll ownership is cleared, and queued View work cannot run after replacement.

The suite also covers draft text, image attachments, edit targets, discussion respondents and mode, pending commands, background retention, a delayed local rename completion after exit, and a Markdown parser completion arriving after its page has been released.

Its collection test performs eight chat/list cycles per mode with long Markdown history and an image draft. It keeps the Activities alive, records 24 old roots through weak references, and checks their collection after controlled test-only GC. Weak-reference inspection runs in a separate method so the inspecting test frame does not keep the last dereferenced root alive. An Android heap snapshot is written to the test app's cache for inspection; neither forced GC nor heap dumping runs in production.

Run the native tests only on a disposable emulator because the fixtures replace its local chat and credential data. Related regression suites include `PageTransitionsTest`, `LocalChatTest`, `RemoteFeedbackTest`, `RemoteDiscussionsTest`, `StreamingMarkdownTest`, composer and image tests, and prefetch viewport tests.
