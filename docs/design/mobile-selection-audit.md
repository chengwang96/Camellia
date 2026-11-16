# Mobile selection and context-menu audit

Date: 2026-11-16. Scope: Android and iOS native clients, including all callers of shared selectors and action menus. Desktop menus and operating-system pickers are outside the replacement scope.

## Findings and changes

| Finding | Change | Platforms |
| --- | --- | --- |
| Workspace actions still opened a bottom panel | Reuse the anchored context-menu family; retain rename editing and chat-preserving removal | Android, iOS source |
| Discussion navigation and group actions still opened list dialogs | Anchor actions to the header or group row; retain the separate delete confirmation; omit group management when no group is selected | Android; no equivalent iOS discussion UI |
| Discussion safety levels differed from regular chat | Reuse `RemoteSettingsPopup`, including descriptions and the selected level; preserve connection, current-group and busy guards | Android |
| Full-width selector rows unnecessarily widened short menus | Determine dropdown width from option labels, bounded by the viewport | Android, iOS source |
| Long action labels could wrap inside a fixed-height menu | Use one line, ellipsis and full-label help/tooltips | Android, iOS source |
| Removing an open selector could leave its layout callback registered on the old tree | Store the exact view-tree observers used for registration, then unregister from those instances on dismissal | Android |

The action-menu refactor preserves existing conversation operations. Removing a workspace still keeps its chats. A group deletion remains a separate confirmation, and changing the safety level still submits the existing remote operation rather than changing local authorization state optimistically.

## Inventory and intentional exceptions

| Family | Presentation and review result |
| --- | --- |
| Usage computer, period, type, account/key and model | Anchored selectors; account/model search retains original option indices, supports empty results and adapts to the keyboard |
| Language, chat size, execution-process preference, API protocol and discussion reply mode | Shared anchored single-selection component; current-choice reselection does not reapply |
| Chat computer, local/remote models, thinking levels and permissions | Existing custom anchored menu families; retain grouped models and permission explanations |
| Conversation, workspace and discussion actions | Anchored action menus; destructive operations retain their existing confirmation semantics |
| Filter expansion, workspace disclosure and appearance choices | Remain inline controls, not dropdowns |
| Enter-key preferences | Retain the panel because options contain longer behavior descriptions |
| Configuration import source | Retain its selection and explicit import/overwrite workflow |
| Add-discussion-member harness, connection and model steps | Retain the bounded, scrolling configuration panels; selecting a binding leads to nickname/identity editing |
| Approval/questions, consent, rename, delete and import/export confirmation | Retain forms/confirmation panels; these are not simple selectors |
| Files, photos, camera and download-folder authorization | Retain system pickers |

Source searches cover `SettingsChoiceDialog`, `SettingsChoicePanel`, `setItems`, single-choice builders, native spinner/popup APIs, custom popup constructors, SwiftUI menus/pickers/context menus and explicit action-list panels. No native Android `Spinner`, `PopupMenu`, `RadioGroup` or `AutoCompleteTextView` selector construction remains. Accessibility class-name strings for custom radio/check controls are intentional.

The two remaining Android `SettingsChoiceDialog` callers are the enter-key preference and configuration-import source. The three remaining `setItems` callers are stages of discussion-member configuration. iOS retains the corresponding enter-key/import panels and system/approval confirmations. Its reading-preferences and discussion UI remain existing parity gaps.

## Source isolation and validation

Build 155 uses `build/selection-audit155-source`, preserving the prior mobile changes and this audit's fixes while excluding parallel networking edits. The snapshot's `source-manifest.json` records the base commit, excluded paths and SHA-256 hashes. Workspace networking edits were not reverted or overwritten.

Validation includes unit tests and focused emulator scenarios for search/index mapping, empty results, keyboard bounds, short-menu sizing, repeated anchor removal, selected state, cancellation, persistence, editor drafts, workspace retention, delete confirmation, busy permissions, conversation actions, popup coordinates and power-mode cleanup. Primary geometry is 1080×2400, at 360dp/font 1.0 and 320dp/font 1.3, with Chinese/light and English/dark coverage.

The final snapshot passed all 270 unit tests, with lint reporting 0 errors and 21 warnings. All 33 focused instrumentation cases passed in one uninterrupted normal-screen run, and the same 33 passed in one uninterrupted narrow-screen run. Screenshots from both geometries were inspected for menu bounds, selection styling, search/keyboard clearance and long labels. The new discussion tests wait for anchors and intervening layouts, matching real interaction between menus.

Earlier runs were interrupted by native Windows QEMU access violations (`0xc0000005`) using software rendering. Both the SDK emulator 37.1.11 and an isolated official stable 37.2.13 download encountered this. Final runs used the isolated 37.2.13 emulator with host rendering; the installed SDK and other active emulators were unchanged. Interrupted runs are not counted toward the final 33 + 33 results. The disposable audit emulator was stopped after screenshots were collected.

The signed ARM64 audit package is `dist/selection-audit-build155/Camellia-Android-1.1.2-arm64-v8a.apk`, version 1.1.2/build 155, 22,501,409 bytes, SHA-256 `766ab34b7c230275ab669830c0ac051bf0675ddd063614ea48ba4fa981da770a`. Signature, ABI, non-debuggable manifest and alignment checks passed; embedded Tailnet was unchanged. Release evidence and source/tool manifests accompany the package. The separately produced higher-version Workbench release is not replaced by this isolated audit package.

iOS changes have source review only on this Windows host; Swift/Xcode, simulator and physical-device acceptance remain pending. Android physical-device acceptance is also pending.
