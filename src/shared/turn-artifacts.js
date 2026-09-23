'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaArtifacts = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const VISIBLE_ARTIFACT_LIMIT = 4;

  function documentFormat(file) {
    const extension = String(file.extension || (file.name || file.path || '').split('.').pop()).toLowerCase();
    if (['md', 'markdown'].includes(extension)) return 'markdown';
    if (['html', 'htm'].includes(extension)) return 'html';
    return '';
  }

  function sortArtifacts(files) {
    const priority = file => file.kind === 'package' ? 0
      : ['image', 'video', 'presentation'].includes(file.kind) || documentFormat(file) ? 1
        : ['pdf', 'word', 'spreadsheet', 'audio'].includes(file.kind)
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

  function collector() {
    const tools = new Map(), paths = new Set();
    const finish = (id, failed) => {
      if (!failed) for (const file of tools.get(id) || []) paths.add(file);
      tools.delete(id);
    };
    return {
      paths,
      capture(event) {
        if (event.type === 'assistant') for (const part of Array.isArray(event.message?.content) ? event.message.content : []) {
          if (part.type === 'tool_use') tools.set(part.id, toolPaths(part.name, part.input));
        }
        if (event.type === 'gui:tool') {
          if (event.input !== undefined) tools.set(event.id, toolPaths(event.name, event.input));
          if (['completed', 'failed', 'cancelled'].includes(event.status)) finish(event.id, event.is_error || event.status !== 'completed');
        }
        if (event.type === 'user' && Array.isArray(event.message?.content)) for (const part of event.message.content) {
          if (part.type === 'tool_result') finish(part.tool_use_id, part.is_error);
        }
      },
    };
  }
  return { textPaths, toolPaths, collector, documentFormat, sortArtifacts, VISIBLE_ARTIFACT_LIMIT };
});
