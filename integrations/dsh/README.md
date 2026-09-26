# DSH settings integration

This directory owns the editable settings shell in `settings-root.js`. The shell
uses DSH's public settings slots, retaining the upstream General, Plugins and
Agent Presets sections. The Models section opens the workbench's shared provider
and Key settings. The ordinary DSH sidebar opens the same workbench settings window.

`patch.cjs` installs the shell into the pinned client plugin when dependencies are
prepared. The original module is retained beside it; running the patch again uses
that original, so changes are repeatable rather than cumulative. The version and
registration markers are checked before modifying the module.

- CLI package: `@deepseek-ai/dsh@0.1.5-rc.1`.
- Settings plugin: `@deepseek-ai/dsh-client-ui-settings-general@0.1.5-rc.2`.
- Client module host: `@deepseek-ai/dsh-client-modules@0.1.5-rc.2`.
- Locale plugin: `@deepseek-ai/dsh-client-locale@0.1.5-rc.2`; the embedded panel follows **Settings → General → Language** in Camellia. Its duplicate language control is hidden. Standalone DSH retains its native preference; new profiles default to English independently of the operating system language.
- The complete dependency graph is pinned in `runtimes/dsh/package-lock.json`.
- Upstream: <https://github.com/deepseek-ai/deepseek-harness>, MIT (`UPSTREAM-LICENSE`).

The desktop renders the native panel in an Electron `WebContentsView` inside the
settings window. This keeps DSH's HttpOnly, SameSite=Strict authentication intact;
a cross-site iframe would not carry that cookie. No external browser is opened.
The child view is hidden on page changes and destroyed with the settings window.
The embedded shell uses DSH's settings-modal layer (`1000`), below native portaled
menus (`1100`), so dropdown options remain visible and clickable.

`client-performance.cjs` also patches the client module host's startup hot path:
line counting uses `indexOf`, and unchanged single-plugin combo artifacts reuse
their existing buffers between graph compositions. Cache entries follow the
record lifetime through a `WeakMap` and are invalidated when bundle bytes, map
snapshots or revisions change. Scripts, revision URLs and debug maps stay byte
identical to the upstream implementation. The patch is reapplied from the original
module during runtime preparation; original copies are excluded from distribution.

`node --test tests/dsh-client-performance.test.js` compares the patched artifacts
with the pinned upstream, including missing maps, Unicode and HMR updates.

To edit: change the shell, then run `npm start`. To update upstream: explicitly
update the runtime lock, inspect the settings slot contract, update this adapter,
and run `node tests/native-settings-electron.cjs` and the regular tests. This is a
source-owned settings integration over the official runtime, not a whole-monorepo
source build; additional frontend modules can be integrated at the same boundary.
