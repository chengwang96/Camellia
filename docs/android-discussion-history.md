# Android discussion history retention

The phone keeps a bounded presentation window for the selected discussion.
The computer continues to own the complete public history and each member's
native context. Phone eviction does not change host records, attachments or
model context. The presentation window is not persisted to disk.

`DiscussionHistory` retains completed history under both of these limits:

- 600 messages, including user and assistant messages.
- 4 MiB of estimated record weight, including text, tool details, attachment
  metadata and associated request/delivery records.

Weights count UTF-16 text and small structural costs when an incoming record is
inserted or replaced. Repeated snapshots replace previous weights rather than
adding to them. No full-history JSON serialization is used for accounting.
The estimate is a retention budget, not a measurement of peak heap usage;
native views, parser jobs and incoming network responses also use memory.

Messages are grouped by request in sequence order. When a limit is exceeded,
the oldest completed request is evicted with all of its retained messages,
deliveries and request metadata. Unreferenced delivery/request records are
removed during merging. The activity then disposes evicted Markdown jobs and
removes their view bindings. Group metadata retains participants, approvals and
current work rather than the original history arrays.

Current queued/preparing/running/stopping deliveries, pending approvals and
unresolved serial failures retain their associated records separately from the
completed-history budget. Protection comes from the latest live snapshot,
including the initiating messages already available in the window. Work whose
initiating message is outside the page still has a visible control panel.
Historical pages do not replace newer delivery/request state or restore absent
live work. Later live snapshots release protection and apply the normal budget.

Only one page request may be in flight. Loading controls are disabled until it
finishes; disconnecting or switching groups invalidates its result. Once the
window reaches a limit, earlier-history loading stops for that open discussion
and a notice points to the complete computer history. Switching away and back
starts a fresh window. A host-instance change also clears the previous window,
its weights and the limit flag.

Scroll restoration anchors to an existing visible message after layout. If that
message is evicted, the nearest remaining message is used. Latest replies follow
the bottom only when the reader was already near it; older pages preserve the
reader's position.

## Verification

`DiscussionHistoryTest` covers repeated paging and live updates, tool/attachment
weights, interleaved request replies, live/approval/serial protection, stale
pages, exact replacement accounting, clearing and oversized records. It also
rejects full-record serialization in the weight path.

`RemoteDiscussionsTest` checks the actual activity's bounded data/view window,
scroll anchoring, disposal, tool-heavy eviction, control retention and a blocked
fake network request used to verify single-flight paging and stale-result
invalidation. The existing streaming and draft/recovery tests remain applicable.
Tests use a disposable emulator and do not call a model.
