'use strict';

// Keyboard shortcuts are defined once for the main process (Electron menu
// accelerators) and every renderer (matching and display). A stored empty
// string deliberately unbinds an action; a missing key keeps its default.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaShortcuts = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const ACTIONS = Object.freeze([
    { id: 'settings', label: 'Open Settings', default: 'CommandOrControl+,' },
    { id: 'home', label: 'Go to Home', default: 'CommandOrControl+Shift+H' },
    { id: 'goal', label: 'Toggle Goal mode', default: 'CommandOrControl+G' },
    { id: 'review', label: 'Open Review', default: 'CommandOrControl+Shift+R' },
    { id: 'zoomIn', label: 'Zoom in', default: 'CommandOrControl+=' },
    { id: 'zoomOut', label: 'Zoom out', default: 'CommandOrControl+-' },
    { id: 'zoomReset', label: 'Actual size', default: 'CommandOrControl+0' },
  ]);
  const MODIFIER_ORDER = ['CommandOrControl', 'Command', 'Control', 'Alt', 'Shift', 'Super', 'Meta'];
  const MODIFIERS = new Map([
    ['commandorcontrol', 'CommandOrControl'], ['commandorctrl', 'CommandOrControl'], ['cmdorctrl', 'CommandOrControl'],
    ['command', 'Command'], ['cmd', 'Command'], ['control', 'Control'], ['ctrl', 'Control'],
    ['alt', 'Alt'], ['option', 'Alt'], ['shift', 'Shift'], ['super', 'Super'], ['meta', 'Meta'],
  ]);
  const KEY_ALIASES = new Map([
    ['esc', 'Escape'], ['escape', 'Escape'], ['return', 'Enter'], ['enter', 'Enter'],
    ['space', 'Space'], ['spacebar', 'Space'], ['up', 'Up'], ['arrowup', 'Up'], ['down', 'Down'], ['arrowdown', 'Down'],
    ['left', 'Left'], ['arrowleft', 'Left'], ['right', 'Right'], ['arrowright', 'Right'],
    ['pageup', 'PageUp'], ['pagedown', 'PageDown'], ['home', 'Home'], ['end', 'End'],
    ['insert', 'Insert'], ['ins', 'Insert'], ['del', 'Delete'], ['delete', 'Delete'],
    ['backspace', 'Backspace'], ['tab', 'Tab'], ['plus', '='],
  ]);
  const PUNCTUATION = [',', '.', '/', ';', "'", '[', ']', '\\', '-', '='];
  const CODE_KEYS = {
    Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Escape', Backspace: 'Backspace',
    Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[',
    BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=',
  };
  const SHIFTED_KEYS = {
    '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
    '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
  };
  // Reload, developer tools and full-screen keep their native bindings. Binding
  // them to an app action would make the two competing handlers unpredictable.
  const RESERVED = new Set([
    'CommandOrControl+R', 'Command+R', 'Control+R',
    'CommandOrControl+Shift+I', 'Command+Shift+I', 'Control+Shift+I',
    'CommandOrControl+Q', 'Command+Q', 'Control+Q',
    'Alt+F4', 'F10', 'F11',
  ]);
  const DEFAULT_PLATFORM = typeof process === 'object' && process?.platform ? process.platform : 'linux';

  function normalizeKey(token) {
    const lower = token.toLowerCase();
    if (KEY_ALIASES.has(lower)) return KEY_ALIASES.get(lower);
    if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
    if (/^[0-9]$/.test(token)) return token;
    if (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
    if (PUNCTUATION.includes(token)) return token;
    return null;
  }

  // Returns a canonical accelerator, '' for an intentionally blank binding, or
  // null when the value cannot be a Camellia shortcut.
  function normalize(value) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw) return '';
    const tokens = raw.split('+').map(token => token.trim());
    if (tokens.some(token => !token)) return null;
    const modifiers = new Set();
    let key = null;
    for (const token of tokens) {
      const modifier = MODIFIERS.get(token.toLowerCase());
      if (modifier) {
        if (modifiers.has(modifier)) return null;
        modifiers.add(modifier);
        continue;
      }
      const normalized = normalizeKey(token);
      if (!normalized || key !== null) return null;
      key = normalized;
    }
    if (!key) return null;
    // One primary modifier, so matching is unambiguous on every platform.
    if (['CommandOrControl', 'Command', 'Control', 'Super', 'Meta'].filter(name => modifiers.has(name)).length > 1) return null;
    // A bare letter would hijack typing. Function keys are safe on their own.
    if (!modifiers.size && !/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key)) return null;
    return [...MODIFIER_ORDER.filter(name => modifiers.has(name)), key].join('+');
  }

  function resolve(values) {
    const saved = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
    const result = {};
    for (const action of ACTIONS) {
      const raw = Object.prototype.hasOwnProperty.call(saved, action.id) ? saved[action.id] : action.default;
      const normalized = normalize(raw);
      result[action.id] = normalized === null ? normalize(action.default) || '' : normalized;
    }
    return result;
  }

  function reserved(value) {
    const normalized = normalize(value);
    return Boolean(normalized) && RESERVED.has(normalized);
  }

  function equals(left, right) {
    const a = normalize(left), b = normalize(right);
    return a !== null && b !== null && a !== '' && a === b;
  }

  function platformOf(desktop) {
    if (desktop && typeof desktop.platform === 'string') return desktop.platform;
    if (typeof navigator === 'object' && navigator) {
      const value = String(navigator.platform || navigator.userAgent || '');
      if (/mac/i.test(value)) return 'darwin';
      if (/win/i.test(value)) return 'win32';
    }
    return DEFAULT_PLATFORM;
  }

  function semanticModifier(modifier, platform) {
    if (modifier === 'CommandOrControl') return 'primary';
    if (modifier === 'Command') return platform === 'darwin' ? 'primary' : 'super';
    if (modifier === 'Control') return platform === 'darwin' ? 'control' : 'primary';
    if (modifier === 'Alt') return 'alt';
    if (modifier === 'Shift') return 'shift';
    if (modifier === 'Super') return 'super';
    return platform === 'darwin' ? 'primary' : 'meta';
  }

  function eventModifiers(event, platform) {
    const modifiers = new Set();
    if (event.ctrlKey) modifiers.add(platform === 'darwin' ? 'control' : 'primary');
    if (event.metaKey) modifiers.add(platform === 'darwin' ? 'primary' : 'super');
    if (event.altKey) modifiers.add('alt');
    if (event.shiftKey) modifiers.add('shift');
    return modifiers;
  }

  function keyFromEvent(event) {
    const code = String(event.code || '');
    let match = /^Key([A-Z])$/.exec(code);
    if (match) return match[1];
    match = /^Digit([0-9])$/.exec(code);
    if (match) return match[1];
    match = /^F(?:[1-9]|1[0-9]|2[0-4])$/.exec(code);
    if (match) return code;
    if (CODE_KEYS[code]) return CODE_KEYS[code];
    const key = String(event.key || '');
    if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase();
    if (/^[0-9]$/.test(key)) return key;
    if (/^F(?:[1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
    if (PUNCTUATION.includes(key)) return key;
    if (SHIFTED_KEYS[key]) return SHIFTED_KEYS[key];
    const named = { ' ': 'Space', Escape: 'Escape', Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete',
      Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Tab: 'Tab',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }[key];
    return named || null;
  }

  // Builds a stored accelerator from a keydown event, or null for modifier-only
  // presses and keys Electron cannot express.
  function fromEvent(event, platform = DEFAULT_PLATFORM) {
    if (!event) return null;
    const key = keyFromEvent(event);
    if (!key) return null;
    const active = eventModifiers(event, platform);
    const parts = [];
    if (active.has('primary')) parts.push('CommandOrControl');
    if (active.has('control')) parts.push('Control');
    if (active.has('super')) parts.push('Super');
    if (active.has('alt')) parts.push('Alt');
    if (active.has('shift')) parts.push('Shift');
    if (!parts.length && !/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key)) return null;
    return normalize([...parts, key].join('+'));
  }

  function parse(value) {
    const normalized = normalize(value);
    if (!normalized) return null;
    const tokens = normalized.split('+');
    return { modifiers: tokens.slice(0, -1), key: tokens.at(-1), value: normalized };
  }

  function matches(event, value, platform = DEFAULT_PLATFORM) {
    const parsed = parse(value);
    if (!parsed || !event) return false;
    const required = new Set(parsed.modifiers.map(modifier => semanticModifier(modifier, platform)));
    const active = eventModifiers(event, platform);
    if (required.size !== active.size) return false;
    for (const modifier of required) if (!active.has(modifier)) return false;
    return keyFromEvent(event) === parsed.key;
  }

  const DISPLAY_MODIFIERS = {
    CommandOrControl: { darwin: '⌘', default: 'Ctrl' }, Command: { darwin: '⌘', default: 'Win' },
    Control: { darwin: '⌃', default: 'Ctrl' }, Alt: { darwin: '⌥', default: 'Alt' },
    Shift: { darwin: '⇧', default: 'Shift' }, Super: { darwin: '⌘', default: 'Win' }, Meta: { darwin: '⌘', default: 'Meta' },
  };
  const DISPLAY_KEYS = { Up: '↑', Down: '↓', Left: '←', Right: '→', Enter: '↵', Escape: 'Esc', Space: 'Space',
    PageUp: 'PgUp', PageDown: 'PgDn', Delete: 'Del', Backspace: '⌫', Insert: 'Ins', Tab: 'Tab' };

  function displayParts(value, platform = DEFAULT_PLATFORM) {
    const parsed = parse(value);
    if (!parsed) return [];
    return [
      ...parsed.modifiers.map(modifier => DISPLAY_MODIFIERS[modifier]?.[platform === 'darwin' ? 'darwin' : 'default'] || modifier),
      DISPLAY_KEYS[parsed.key] || parsed.key,
    ];
  }

  // Renderer helper: the current bindings follow the main process, so a
  // shortcut changed in Settings takes effect without reloading the chat page.
  function watchBindings(desktop) {
    let values = resolve();
    const apply = next => {
      if (next && typeof next === 'object' && !Array.isArray(next)) values = resolve(next);
    };
    try {
      const pending = desktop?.shortcutsGet?.();
      if (pending && typeof pending.then === 'function') pending.then(result => { if (result?.ok) apply(result.shortcuts); }).catch(() => {});
    } catch { /* matching still works with defaults */ }
    try { desktop?.onShortcutsChanged?.(apply); } catch { /* older surfaces keep defaults */ }
    return {
      values: () => ({ ...values }),
      matches: (event, id) => matches(event, values[id], platformOf(desktop)),
    };
  }

  return { ACTIONS, normalize, resolve, reserved, equals, matches, fromEvent, displayParts, watchBindings, platformOf };
});
