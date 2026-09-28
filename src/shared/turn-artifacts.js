'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaArtifacts = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const VISIBLE_ARTIFACT_LIMIT = 4;

  function documentFormat(file) {
    const extension = String(file.extension || (file.name || file.path || '').split('.').pop()).replace(/^\./, '').toLowerCase();
    if (['md', 'markdown'].includes(extension)) return 'markdown';
    if (['html', 'htm'].includes(extension)) return 'html';
    return '';
  }

  function sortArtifacts(files) {
    const priority = file => file.kind === 'package' ? 0
      : ['image', 'video', 'presentation'].includes(file.kind) || documentFormat(file) ? 1
        : ['pdf', 'word', 'spreadsheet', 'document', 'audio'].includes(file.kind)
          || /\.(?:txt|csv|tsv|rst|tex)$/i.test(file.name || file.path || '') ? 2 : 3;
    return [...files].sort((first, second) => priority(first) - priority(second));
  }

  function textPaths(text) {
    const paths = [];
    const source = String(text || '').replace(/```[\s\S]*?(?:```|$)/g, '');
    for (const match of source.matchAll(/!?\[[^\]\n]*\]\(<?((?:[^()\n]|\([^()\n]*\))+?)>?\)|`([^`\n]+)`/g)) {
      const value = (match[1] || match[2]).replace(/\s+"[^"]*"$/, '').trim();
      if (!/^(?:https?|data|javascript|mailto):/i.test(value)) paths.push(value);
    }
    return [...new Set(paths)].slice(0, 100);
  }

  function toolPaths(name, input) {
    if (!/(write|edit|create|save|output|export|patch|filechange|file_change)/i.test(name || '')) return [];
    if (typeof input === 'string') return [...input.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map(match => match[1].trim());
    if (!input || typeof input !== 'object') return [];
    const paths = ['file_path', 'path', 'output_path', 'destination', 'filename'].map(key => input[key]).filter(value => typeof value === 'string');
    for (const change of Array.isArray(input.changes) ? input.changes : []) if (change.kind !== 'delete' && change.kind?.type !== 'delete' && change.path) paths.push(change.path);
    if (typeof input.patch === 'string') paths.push(...toolPaths('patch', input.patch));
    if (typeof input.input === 'string') paths.push(...toolPaths('patch', input.input));
    return paths;
  }

  // The directory a command actually ran in. A turn can work outside the
  // conversation workspace, so relative paths in its reply need these roots.
  function toolRoots(input) {
    if (!input || typeof input !== 'object') return [];
    return ['cwd', 'workdir', 'working_directory'].map(key => input[key])
      .filter(value => typeof value === 'string' && value.trim());
  }

  // A command often reads or inspects a folder outside the workspace (a Desktop
  // scan, an import from another project), and the reply then names that folder
  // and lists its files relatively. The absolute paths in the turn's own tool
  // inputs are the only record of those folders, so they become resolution bases
  // too. A recorded command quotes its paths in whatever dialect its shell
  // needed, so the runs of path characters after a drive letter are read
  // directly rather than by unquoting, and escaping that doubled the separators
  // collapses back to one. Each run is offered both whole and as its parent,
  // because a run that names a file still points at the folder the reply lists
  // files from, while one that names a folder is already the base. Only a plain
  // drive path qualifies; a UNC or device path is skipped because resolving one
  // can block on a network lookup, and the caller drops candidates that are not
  // real directories before they cost a reference a failed lookup.
  function toolDirectories(input) {
    const values = typeof input === 'string' ? [input]
      : input && typeof input === 'object' ? ['command', 'input', 'script'].map(key => input[key]).filter(value => typeof value === 'string')
        : [];
    const directories = [];
    const add = value => { if (value && directories.length < 100 && !directories.includes(value)) directories.push(value); };
    for (const value of values) {
      // A quoted span is taken whole, so a folder whose name contains a space
      // survives; the bare runs cover paths a shell left unquoted.
      const literals = [];
      for (const match of value.matchAll(/"([^"\r\n]{1,400})"|'([^'\r\n]{1,400})'|`([^`\r\n]{1,400})`/g)) literals.push(match[1] ?? match[2] ?? match[3]);
      for (const match of value.matchAll(/[a-z]:[\\/][^\\/\s"'`;|<>*?:$]*(?:[\\/][^\\/\s"'`;|<>*?:$]*)*/gi)) literals.push(match[0]);
      for (const raw of literals) {
        const literal = raw.replace(/[\\/]+/g, match => match[0]).replace(/[\\/]+$/, '').trim();
        // A drive-relative path such as `C:file`, and a bare `C:` or `C:\`, name
        // no folder; a parent is only usable if it keeps the same shape.
        if (!/^[a-z]:[\\/][^\\/]/i.test(literal)) continue;
        add(literal);
        const parent = literal.slice(0, Math.max(literal.lastIndexOf('\\'), literal.lastIndexOf('/')));
        if (/^[a-z]:[\\/][^\\/]/i.test(parent)) add(parent);
      }
    }
    return directories;
  }

  function collector() {
    const tools = new Map(), paths = new Set(), roots = new Set();
    const finish = (id, failed) => {
      if (!failed) for (const file of tools.get(id) || []) paths.add(file);
      tools.delete(id);
    };
    return {
      paths, roots,
      capture(event) {
        if (event.type === 'assistant') for (const part of Array.isArray(event.message?.content) ? event.message.content : []) {
          if (part.type !== 'tool_use') continue;
          tools.set(part.id, toolPaths(part.name, part.input));
          for (const root of toolRoots(part.input)) roots.add(root);
          for (const directory of toolDirectories(part.input)) roots.add(directory);
        }
        if (event.type === 'gui:tool') {
          if (event.input !== undefined) {
            tools.set(event.id, toolPaths(event.name, event.input));
            for (const root of toolRoots(event.input)) roots.add(root);
            for (const directory of toolDirectories(event.input)) roots.add(directory);
          }
          if (['completed', 'failed', 'cancelled'].includes(event.status)) finish(event.id, event.is_error || event.status !== 'completed');
        }
        if (event.type === 'user' && Array.isArray(event.message?.content)) for (const part of event.message.content) {
          if (part.type === 'tool_result') finish(part.tool_use_id, part.is_error);
        }
      },
    };
  }
  return { textPaths, toolPaths, toolRoots, toolDirectories, collector, documentFormat, sortArtifacts, VISIBLE_ARTIFACT_LIMIT };
});
