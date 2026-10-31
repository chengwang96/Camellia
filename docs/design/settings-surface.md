# Settings surface

Camellia's settings use the design language of the user's DeepSeek Harness screenshots: a continuous neutral surface, an unfilled navigation rail with soft selected rows, generous setting spacing, outlined cards and three icon-over-label appearance choices. The desktop settings window is a frameless rounded panel over a dimmed workbench, with a custom close button; see [window-chrome.md](window-chrome.md) for its window lifecycle and validation.

The public repository includes both the Electron desktop shell (`apps/desktop`) and the shared settings UI. Inspected revision: `ce7073d51254c26cd63b22a60835b8f948deb447` (2026-10-31).

Reference sources (MIT):

- https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/client/ui-settings-general/src/client/SettingsRoot.module.css
- https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/client/ui-theme/src/client/AppearanceRow.module.css
- https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/client/ui-settings-models/src/client/ModelsSection.module.css

This is an adaptation to Camellia's existing HTML and shared theme tokens, not an import of DeepSeek's React components. It preserves the current topic groups, account controls and autosave behavior. `settings-surface.css` owns the final settings-only material and layout rules. Appearance buttons use the existing theme select and save path; selected state is synchronized when preferences load. Narrow windows keep the existing icon rail; all new controls retain keyboard focus indicators and translated labels.

Validation: `tests/settings-page-smoke.py`, `tests/api-settings-ui.py`, `tests/settings-language-ui.py` and `tests/engine-settings-ui.py` passed. Appearance choices were checked against saved preference payloads and selected state; screenshots cover English/Chinese, light/dark, and widths 320, 390, 850 and 1180. API tests additionally exercise real settings persistence, provider import, model verification, chart interactions and responsive layouts through 1840px. Local preview images are generated under `dist/engine-settings-qa/settings-*.png`.

Divider spacing is owned by `settings-groups.css`: topic groups have 20px of space above and below their contents; edge rows shed duplicate padding, including inside section wrappers and around hidden status elements. Structural groups around nested topic lists add no extra space. Setting descriptions use a 4px title gap with no trailing paragraph margin. Space cleanup and connectivity testing use the same text-and-action row as other controls, so their buttons are centered against the complete title and description. The old storage-heading margin and conflicting surface overrides were removed.

Spacing QA on 2026-10-31 inspected six pages across Chinese/English, light/dark, and widths 320, 390, 700, 900 and 1180 (120 layouts, no page errors or horizontal overflow). Data and Network groups measured 20px at both content edges. Previews and measurements are in `dist/ui-preview/settings-spacing/`. Existing settings-page, data-migration, web-tools and engine-settings UI checks passed after the change.
