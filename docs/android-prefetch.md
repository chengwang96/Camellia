# Android conversation prefetch

Conversation-body prefetch is limited to the currently selected computer and the conversation list viewport. The computer-selection screen requests status only. Selecting a computer continues to display its persisted list cache and refresh its first list page through the regular list request.

## Selection and scheduling

After list layout or scrolling, MainActivity coalesces viewport updates within 50 ms. Conversation cards are recorded in their actual vertical display order, including workspace grouping, pinned order and search filtering. Binary searches locate the visible range in O(log n) geometry checks. Collapsed groups have no registered cards. At most four visible conversations are eligible immediately; at most two cards within the next screen below the viewport are eligible after two seconds without interaction.

Every viewport update replaces the previous selection. The worker retains at most six desired candidates, six pending candidates and one active request. Queue items contain address, token, conversation ID and version strings rather than whole credential or row JSON graphs. Unchanged candidates reuse their in-flight request. Replacing a candidate cancels its old request, and a late result cannot publish even after returning to the same conversation. The worker waits for the active request to finish before starting another.

There are no prefetch list-page requests or recursive pagination. “Load more” and user-requested search continue through the existing list-loading flow. Opening a conversation, switching computer, leaving the Activity or stopping the network clears the prefetch selection. A chat's first snapshot does not restart background downloads for other conversations.

Fresh entries with matching sequence, update time and activity skip requests for 60 seconds. A failed or uncached candidate is attempted once per unchanged selection, preventing repeated layout notifications from creating a retry loop. A new version or leaving and returning to the candidate allows another attempt. A 404 removes that conversation; 401/403 clear the affected computer's cache and pending work.

## Response and memory limits

Prefetch JSON responses are limited to 1 MiB while reading, before JSON parsing, through the shared reader used by HTTP and embedded-tailnet transports. Normal user-initiated JSON requests retain their existing 8 MiB limit. An oversized prefetch does not prevent opening the conversation normally.

The memory-only LRU retains at most eight conversation previews. Its string-storage estimate is limited to clamp(maxHeap / 32, 2 MiB, 8 MiB), with at most 1 MiB per entry. Accounting includes two bytes per UTF-16 code unit in payload, key and version plus a fixed entry allowance. This bounds retained cache strings; it is not a measurement or cap of the whole process's heap or temporary parsing objects. Oversized updates discard an older preview for that conversation.

Only conversation metadata and messages are cached. Permissions, live approvals and editable settings are obtained through normal current-server synchronization. Prefetch previews are not written to disk and do not contain model-native context.

## Verification

Unit tests cover large input lists, the idle deadline, bounded replacement, one active request, same-ID cancellation, computer and token isolation, version changes, revocation, deletion, failure attempts, LRU eviction, UTF-16 accounting, oversized previews and response-reading boundaries. Android tests additionally exercise actual list geometry, scrolling, collapsed groups, search, opening chats, explicit pagination, status-only computer checks, native JSON and HTTP response limits.
