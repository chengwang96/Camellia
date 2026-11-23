# Web Surface

The Web surface embeds the official DeepSeek and Kimi web applications in the
desktop workbench. It does not proxy model requests or copy conversations back
into Camellia history.

## Interaction

- The header switch selects `Agent` or `Web` without changing the active native
  conversation.
- The selector changes to `DeepSeek Web` or `Kimi Web` while `Web` is active.
- Web provider selection uses a DOM listbox with the same panel, option height,
  selected-row treatment and trailing check as the harness select. Opening it
  captures the current page and hides the native view, so the frozen page
  remains visible behind the menu while the DOM options can paint above it.
  The trigger uses the same pill height, padding, border, typography and
  trailing chevron as the harness selector, with a stable minimum width so
  switching providers does not move the Agent/Web switch.
- New-conversation pages use the fixed header title `New web conversation`
  instead of the provider's marketing page title.
- Model Settings → Web pages can preload DeepSeek Web and Kimi Web in hidden
  views at launch. This is opt-in because it uses additional memory and
  network; when the user opens Web, the already-laid-out provider page can be
  shown immediately.
- The left sidebar changes to a separate web conversation list. Agent
  workspaces, discussions, drafts and scroll positions remain mounted and are
  restored when `Agent` is selected again.
- Web history is read from the signed-in official page. Camellia caches only
  titles and conversation URLs so the list can appear before the page finishes
  loading; the last open page is not restored automatically.
- Opening a provider for the first time after app launch always lands on that
  provider's new-conversation page. A previous conversation URL is not restored
  automatically; the user enters one from the independent Web list. Switching
  between Agent and Web during the same app session preserves the live page.
- The embedded view is held hidden during a full document load. It is revealed
  only after the layout CSS and Agent column width are applied and the first
  history extraction has settled, and the document has stopped loading. The
  first visible frame is therefore the finished layout; the provider's own
  loading skeleton and sidebar removal are never painted. A slow or signed-out
  page still reveals after a bounded wait, and browser error pages reveal
  immediately. Home pages use provider-specific rendered-composer selectors
  instead of the cached-history budget, so cached conversations do not make a
  new-conversation page wait several seconds before appearing.
- Extraction temporarily lays out the provider sidebar without painting it,
  then keeps only links with real visible boxes. Deleted conversations that the
  provider leaves behind as hidden DOM nodes are not retained in the Camellia
  list.
- A manual refresh is authoritative: it clears stale cached rows immediately
  instead of applying the empty-history grace period used during automatic SPA
  navigation.
- Opening a row loads that conversation in the embedded page. `New web
  conversation` navigates to the provider home page.
- Each web row has a context menu for rename, pin/unpin, share, multi-select and
  delete. Rename, pin and delete are executed through the provider's own row
  menu and confirmation controls, so Camellia does not maintain a competing
  conversation database. Share opens the provider's share flow.
- The menu uses the same `dsh-pop action-menu` surface, row height, focus ring,
  glass treatment, danger color and keyboard navigation as Agent conversation
  menus, with positioning constrained to the visible sidebar.
- Multi-select is handled in Camellia's sidebar. It provides a visible selection
  state and deletes selected rows sequentially through the official delete
  action after an explicit confirmation.

## Isolation

- Each provider uses a dedicated persistent Chromium partition:
  `persist:camellia-web-deepseek` or `persist:camellia-web-kimi`.
- The embedded pages have no Node integration, no Camellia preload bridge and
  no shared renderer session.
- Login, QR codes, cookies and site storage remain inside the provider
  partition. Camellia never reads or exports cookie values.
- Main-frame navigation is restricted to each provider and its authentication
  domains. Other links open in the system browser.
- Pop-ups share the provider partition and can only navigate to allowed hosts.
- Clearing a provider sign-in deletes that partition's site data and reloads
  the official page.
- Kimi Web applies Electron's `disable_non_proxied_udp` WebRTC IP-handling
  policy to its own view. Kimi's TrustDecision fingerprint script can therefore
  still run, but it cannot emit STUN DNS failures for `stun.qq.com` or
  `stun.miwifi.com`. DeepSeek keeps the default policy. This is scoped to the
  embedded Kimi view; direct WebRTC calling that requires non-proxied UDP is
  intentionally unavailable there.

## Layout Profiles

- Built-in profiles contain the provider start URL, history-link selector,
  session-ID pattern, site-sidebar selectors and promotional-element rules.
- Injected CSS hides the official site sidebar once the native Web list can
  navigate the same conversations. The site sidebar remains available as a
  fallback when extraction fails.
- The hide state lives on the page root, not only on the current sidebar node,
  so provider SPA navigation that replaces the sidebar cannot flash it back
  between history polls. A short empty-history grace period prevents transient
  DOM states from exposing the provider navigation. When Camellia already has
  cached conversations, repeated empty probes keep the site navigation hidden
  instead of revealing and hiding it again; only an explicit refresh or a
  sign-in/error fallback can restore the provider sidebar.
- A minimal sandboxed preload injects boot CSS through `webFrame` before the
  provider document renders. Provider navigation is hidden from the first
  frame and stays hidden until the layout runtime explicitly enables the
  site-sidebar fallback with `data-camellia-web-site-sidebar-visible`. A
  provider that later renders a replacement sidebar therefore cannot paint and
  then disappear while the application boots.
- Kimi uses its stable `data-testid` and BEM selectors. DeepSeek uses structural
  anchors and link-path patterns because most class names are build hashes.
- Kimi desktop-download promotions are covered by both the live
  `.desktop-download-entry` selector and short-label rules for
  `获取应用程序`, `下载桌面端`, `客户端限时优惠` and related English labels.
- Icon-only entries are matched through `aria-label` and `title` as well. The
  live `button.user-download-button[data-testid="sidebar-get-app"]` control is
  covered directly so icon buttons cannot bypass text-only filtering.
- Promotional controls for membership, discounts and referral rewards are
  hidden only in page chrome. Conversation content is never filtered by text.
- Layout profiles normalize both provider conversation columns to the Agent
  width at runtime. The renderer measures the Agent conversation column after
  the configured standard, wide or full setting and current window width are
  applied, then sends the exact numeric width to the embedded page. Provider
  CSS derives an outer column with 24px side padding from that value, and uses
  the same value for the composer with a 22px radius. Provider columns use
  border-box sizing so padding cannot widen them past the Agent column. Kimi's
  decorative outer inset and reserved scrollbar gutter are removed, and its
  message column starts at the same 24px top inset as the Agent conversation.
  Kimi's composer matches the Agent input card's 126px minimum height. Its home
  hero is offset by 123px at the real Web stage size so the provider composer
  and brand region share the Agent empty-state vertical rhythm while retaining
  Kimi's tool tray and footer. Kimi's redundant sidebar-toggle header is
  removed, and an empty landing header collapses to zero height. The light and
  dark page bases, dark composer surface, border and focus treatment follow the
  desktop workbench; the native view background switches with the app theme so
  loading never flashes the previous theme. Scrollbar and selection styling
  also follow the desktop workbench rather than each site theme.
- Closing a settings or layout overlay always re-show the Web view with the
  current Agent column width, including when the width preference changed
  while the embedded page was hidden.

## Layout Repair

The Web layout dialog offers two paths:

1. A local scanner groups same-origin links by path pattern and proposes a
   history selector.
2. If an API route is configured, the user can select one route model. Camellia
   sends only same-origin paths, class names, visibility sizes and link counts.
   Conversation text, input values, cookies and query strings are excluded.

Model output must contain only `historyAnchorSelector`, `titleSelector` and
optional CSS. CSS with remote resources, imports, scripts or expressions is
rejected. The profile is stored in the app user-data directory and can be reset
to the built-in version.

## Remote Access

The Web surface is desktop-only. Its sessions, controls, layout diagnostics and
model repair flow are not exposed through the mobile access protocol, remote
conversation commands or discussion APIs.

## Tests

- `node --test tests/web-providers.test.js`
- `node --test tests/web-surface-manager.test.js`
- `python tests/web-surface-ui.py`
- `python tests/web-layout-consistency-ui.py`
- `python tests/web-layout-dom-ui.py`
- `python tests/web-session-actions-ui.py`
- `node tests/web-view-preload-electron.cjs`
- `node tests/electron-smoke.cjs`
