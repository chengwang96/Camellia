'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CamelliaArtifacts = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  const VISIBLE_ARTIFACT_LIMIT = 4;

  function artifactPath(value, platform) {
    if (typeof value !== 'string') return '';
    return platform === 'win32' ? value.replace(/\\/g, '/').toLowerCase() : value;
  }

  // A file keeps its identity when a later resolution adds a canonical path
  // or an edit replaces the file. Keep both path spellings as aliases, and
  // replace the row's metadata with the latest observation.
  function artifactStore() {
    const entries = new Set(), aliases = new Map();
    return {
      get size() { return entries.size; },
      *values() { for (const entry of entries) yield entry.file; },
      clear() { entries.clear(); aliases.clear(); },
      set(file, platform) {
        const keys = [...new Set([file?.path, file?.canonicalPath].map(value => artifactPath(value, platform)).filter(Boolean))];
        if (!keys.length) return;
        const matches = new Set(keys.map(key => aliases.get(key)).filter(Boolean));
        const entry = matches.values().next().value || { keys: new Set() };
        for (const match of matches) if (match !== entry) {
          for (const key of match.keys) { entry.keys.add(key); aliases.set(key, entry); }
          entries.delete(match);
        }
        for (const key of keys) { entry.keys.add(key); aliases.set(key, entry); }
        entry.file = file;
        entries.add(entry);
      },
    };
  }

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

  // Search results and stored explicit deliveries need a final-answer reference.
  // Matching both path aliases also keeps bare-name and relative references useful.
  function referencedArtifacts(files, text, platform) {
    const references = textPaths(text).filter(candidate => !/(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)$/.test(candidate)).map(candidate => {
      let value = candidate;
      try { value = decodeURIComponent(value); } catch {}
      return artifactPath(value, platform).replace(/^(?:\.\/)+/, '');
    }).filter(Boolean);
    return files.filter(file => {
      const paths = typeof file === 'string' ? [file] : [file?.path, file?.canonicalPath];
      return paths.some(value => {
        const candidate = artifactPath(value, platform);
        return candidate && references.some(reference => candidate === reference || candidate.endsWith('/' + reference));
      });
    });
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
  // needed, so quoted literals and bare absolute paths are read directly.
  // Escaping that doubled Windows separators collapses back to one. Each run
  // is offered both whole and as its parent,
  // because a run that names a file still points at the folder the reply lists
  // files from, while one that names a folder is already the base. Plain drive
  // and POSIX paths qualify; a UNC or device path is skipped because resolving one
  // can block on a network lookup, and the caller drops candidates that are not
  // real directories before they cost a reference a failed lookup.
  function toolDirectories(input) {
    const values = typeof input === 'string' ? [input]
      : input && typeof input === 'object' ? ['command', 'cmd', 'input', 'script'].map(key => input[key]).filter(value => typeof value === 'string')
        : [];
    const directories = [];
    const add = value => { if (value && directories.length < 100 && !directories.includes(value)) directories.push(value); };
    for (const value of values) {
      // A quoted span is taken whole, so a folder whose name contains a space
      // survives; the bare runs cover paths a shell left unquoted.
      const literals = [];
      // Inspect each quote style independently: a Python literal can be nested
      // inside the shell's double-quoted -c argument.
      for (const pattern of [/"([^"\r\n]{1,400})"/g, /'([^'\r\n]{1,400})'/g, /`([^`\r\n]{1,400})`/g])
        for (const match of value.matchAll(pattern)) literals.push(match[1]);
      for (const match of value.matchAll(/(?<![\w\\/])[a-z]:[\\/][^\\/\s"'`;|<>*?:$]*(?:[\\/][^\\/\s"'`;|<>*?:$]*)*/gi)) literals.push(match[0]);
      for (const match of value.matchAll(/(?:^|[\s("'`=,])(\/(?!\/)[^\s"'`;|<>*?:$(){}\\,]+)/g)) literals.push(match[1]);
      for (const raw of literals) {
        const windows = /^[a-z]:[\\/]/i.test(raw);
        const literal = (windows ? raw.replace(/[\\/]+/g, match => match[0]) : raw).replace(windows ? /[\\/]+$/ : /\/+$/, '').trim();
        // A drive-relative path such as `C:file`, and a bare `C:` or `C:\`, name
        // no folder; a parent is only usable if it keeps the same shape.
        const absolute = windows ? /^[a-z]:[\\/][^\\/]/i : /^\/(?!\/)[^/]/;
        if (!absolute.test(literal)) continue;
        add(literal);
        const parent = literal.slice(0, windows ? Math.max(literal.lastIndexOf('\\'), literal.lastIndexOf('/')) : literal.lastIndexOf('/'));
        if (absolute.test(parent)) add(parent);
      }
    }
    return directories;
  }

  // Only formats the preview panel can actually deliver. A command output can
  // name anything, so a kind that Camellia cannot open is never a candidate.
  const DELIVERABLE_EXTENSIONS = new Set(('mp4 webm mov m4v ogv png jpg jpeg gif webp bmp svg ico avif '
    + 'mp3 wav ogg m4a aac flac opus pdf doc docx xls xlsx ppt pptx '
    + 'apk aab ipa exe msi dmg pkg deb rpm appimage').split(' '));
  // A write has to be named as one: a generic path in a listing or an error
  // message is not evidence that this turn produced the file.
  const WRITE_WORDS = /\b(?:wrote|written|writing|saved|saving|generated|generating|created|creating|exported|exporting|rendered|rendering|produced|producing|dumped|converted|converting|encoded|encoding|transcoded|transcoding|rewrote|rewriting|overwrote|overwriting|output|outputs)\b(?=\s|[:#>,;()\[\]{}=])/i;
  const FAILURE_WORDS = /\b(?:error|failed|failure|cannot|unable|traceback|exception|permission denied|no such file|does not exist|not found)\b/i;
  const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache', '.gradle', 'venv', '.venv', 'site-packages']);
  // Writer calls whose first argument is the artifact path. Generic open() is
  // deliberately absent: it writes logs and configuration just as often.
  const WRITER_CALL = /(?:write_frames|get_writer|VideoWriter|imwrite|imsave|mimsave|savefig|write_videofile|write_video|save|to_csv|to_excel|to_json|to_parquet|write_html|write_text|write_bytes|export)\s*\(\s*["']([^"']{1,300}?)["']/gi;

  function boundedText(value, limit = 2000000) {
    const text = String(value || '');
    if (text.length <= limit) return text;
    const half = Math.floor((limit - 1) / 2);
    return text.slice(0, half) + '\n[truncated]\n' + text.slice(-half);
  }

  function joinPath(base, value) {
    if (!base) return value;
    if (/^[a-z]:[\\/]|^\//i.test(value)) return value;
    return base.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
      + value.replace(/\\/g, '/').replace(/^\/+/, '');
  }

  function deliverablePath(value) {
    let text = String(value || '').trim();
    while (/^[\s("'`\[<{]/.test(text)) text = text.slice(1);
    while (/[\s)"'`,;:.>\]}?!]$/.test(text)) text = text.slice(0, -1);
    if (!text || text.length > 400 || /[*?%=<>|&]/.test(text)) return '';
    if (/^(?:https?|data|file|mailto|javascript):/i.test(text) || /^(?:\\\\|\/\/)/.test(text)) return '';
    if (/^[-~$%]/.test(text)) return '';
    const name = text.split(/[?#]/)[0].replace(/\\/g, '/').split('/').pop() || '';
    const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    return DELIVERABLE_EXTENSIONS.has(extension) ? text : '';
  }

  function ignoredOutputPath(value) {
    const segments = String(value || '').replace(/\\/g, '/').split('/').filter(Boolean).map(segment => segment.toLowerCase());
    return segments.some(segment => IGNORED_SEGMENTS.has(segment));
  }

  // A command often changes directory before writing. The output path is then
  // relative to that directory, not to the conversation workspace. Only the
  // directory changes the command itself names are used; variables and shell
  // expansions are left alone because they cannot be resolved safely.
  function commandPrefixes(command) {
    const prefixes = [];
    let current = '';
    for (const match of String(command || '').matchAll(/(?:^|&&|\|\||[;|])\s*(?:cd|Set-Location|Push-Location)\s+(?:(?:-LiteralPath|-Path|\/d|-d)\s+)?("([^"]+)"|'([^']+)'|([^\s;&|]+))/gi)) {
      const value = (match[2] || match[3] || match[4] || '').replace(/[\\/]+$/, '');
      if (!value || /^[%$~-]/.test(value) || value === '.') continue;
      current = current && !/^[a-z]:[\\/]|^\//i.test(value) ? joinPath(current, value) : value;
      if (!prefixes.includes(current)) prefixes.push(current);
      if (prefixes.length >= 10) break;
    }
    return prefixes;
  }

  function withPrefixes(value, prefixes) {
    if (/^[a-z]:[\\/]|^\//i.test(value)) return [value];
    const result = [];
    for (const prefix of prefixes) {
      const candidate = joinPath(prefix, value);
      if (!result.includes(candidate)) result.push(candidate);
    }
    if (!result.includes(value)) result.push(value);
    return result;
  }

  function shellTokens(command) {
    const tokens = [];
    let token = '', quote = '';
    for (const char of String(command || '')) {
      if (quote) { if (char === quote) quote = ''; else token += char; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (/\s/.test(char)) { if (token) { tokens.push(token); token = ''; } continue; }
      token += char;
    }
    if (token) tokens.push(token);
    return tokens;
  }

  // Output paths named by the command itself: redirections, output flags,
  // writer calls with a literal path, and ffmpeg's final positional argument.
  // Inputs are never candidates.
  function commandValues(input) {
    return typeof input === 'string' ? [input]
      : input && typeof input === 'object' ? ['command', 'cmd', 'input', 'script'].map(key => input[key]).filter(value => typeof value === 'string')
        : [];
  }

  function commandOutputPaths(input) {
    const paths = new Set();
    for (const command of commandValues(input)) {
      const source = boundedText(command);
      const prefixes = commandPrefixes(source);
      const add = value => {
        const path = deliverablePath(value);
        if (!path || ignoredOutputPath(path)) return;
        for (const candidate of withPrefixes(path, prefixes)) paths.add(candidate);
      };
      for (const match of source.matchAll(/(?:^|[\s;&|])(?:\d?>>?)\s*("([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) add(match[2] || match[3] || match[4]);
      for (const match of source.matchAll(/(?:^|[\s;&|])(-o|--output-file|--output_path|-outfile|--output|--outfile|-destination|--destination|-out|--out|--dest|--video|--mp4|--gif|--plot|--image|--audio|--savefig|--save)(?:=|\s+)("([^"]+)"|'([^']+)'|([^\s;&|]+))/gi)) add(match[3] || match[4] || match[5]);
      for (const match of source.matchAll(/(?:^|[\s;&|])-o("([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) add(match[2] || match[3] || match[4]);
      for (const match of source.matchAll(WRITER_CALL)) add(match[1]);
      if (/(?:^|[\s;&|"'])(?:[^\s;&|"']*[\\/])?ffmpeg(?:\.exe)?(?=\s|$)/i.test(source)) {
        const tokens = shellTokens(source);
        for (let index = tokens.length - 1; index >= 0; index--) {
          const token = deliverablePath(tokens[index]);
          if (!token) continue;
          const previous = tokens[index - 1] || '';
          if (/^-(?:i|vf|filter|filter_complex|map|ss|t)$/i.test(previous)) break;
          add(token); break;
        }
      }
    }
    return paths;
  }

  // Output text is the fallback for scripts that write through a variable.
  // Only a line that reports a write is read, and only the part after the verb
  // or arrow is searched, so input files on the left never become artifacts.
  function reportedOutputPaths(output) {
    const paths = new Set();
    const source = boundedText(output).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    for (const line of source.split(/\r\n|\r|\n/)) {
      if (!line || FAILURE_WORDS.test(line)) continue;
      const arrow = Math.max(line.lastIndexOf('->'), line.lastIndexOf('=>'));
      const verb = WRITE_WORDS.exec(line);
      if (arrow < 0 && !verb) continue;
      // A named write verb wins: "converted a.mp4 -> h264" puts the output
      // before the arrow. Without a verb, the arrow means "source -> output",
      // so only the right-hand side is evidence.
      const evidence = verb ? line.slice(verb.index + verb[0].length) : line.slice(arrow + 2);
      // "wrote out.mp4 from input.mp4" names one output and one input. Cut at
      // the source marker so the input never becomes a candidate.
      const cutoff = evidence.search(/(?:^|[\s(])(?:from|using)\s+/i);
      const outputText = cutoff > 0 ? evidence.slice(0, cutoff) : evidence;
      const values = [];
      for (const match of outputText.matchAll(/["'`]([^"'`\r\n]{1,400})["'`]/g)) values.push(match[1]);
      for (const match of outputText.matchAll(/(?<![\w])[a-z]:[\\/][^\s"'`;|<>*?]+/gi)) values.push(match[0]);
      for (const match of outputText.matchAll(/(?:^|[\s("'`=,])(\/(?!\/)[^\s"'`;|<>*?]+)/g)) values.push(match[1]);
      for (const match of outputText.matchAll(/(?:^|[\s("'`=,])([^\s"'`;|<>*?,]+)/g)) values.push(match[1]);
      for (const value of values) {
        const path = deliverablePath(value);
        if (path && !ignoredOutputPath(path)) paths.add(path);
      }
    }
    return paths;
  }

  function toolResultText(content) {
    if (typeof content === 'string') return content;
    if (content && !Array.isArray(content) && typeof content.text === 'string') return content.text;
    if (!Array.isArray(content)) return '';
    return content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
  }

  // Reading a log that says "wrote out/a.mp4" must not deliver the file. Only
  // command tools, or tools whose input carries a command, are allowed to turn
  // their output text into artifacts.
  function commandOutputCandidate(name, input) {
    if (/(?:bash|shell|command|exec|terminal|powershell|running)/i.test(name || '')) return true;
    return Boolean(input && typeof input === 'object'
      && (typeof input.command === 'string' || typeof input.cmd === 'string'));
  }

  function collector({ deriveOutputs = true } = {}) {
    const tools = new Map(), paths = new Set(), outputs = new Set(), roots = new Set();
    const note = (id, name, input, output) => {
      if (!id) return;
      const record = tools.get(id) || { name: '' };
      if (name) record.name = name;
      if (input !== undefined) {
        record.input = input;
        for (const root of toolRoots(input)) roots.add(root);
        for (const directory of toolDirectories(input)) roots.add(directory);
      }
      if (output) record.output = output;
      tools.set(id, record);
    };
    const finish = (id, failed) => {
      const record = tools.get(id);
      if (record && !failed) {
        for (const file of toolPaths(record.name, record.input)) paths.add(file);
        if (deriveOutputs && commandOutputCandidate(record.name, record.input)) {
          const prefixes = commandValues(record.input).flatMap(commandPrefixes);
          for (const file of commandOutputPaths(record.input)) outputs.add(file);
          for (const file of reportedOutputPaths(record.output)) {
            for (const candidate of withPrefixes(file, prefixes)) outputs.add(candidate);
          }
        }
      }
      tools.delete(id);
    };
    return {
      paths, outputs, roots,
      capture(event) {
        if (event.type === 'assistant') for (const part of Array.isArray(event.message?.content) ? event.message.content : []) {
          if (part.type !== 'tool_use') continue;
          note(part.id, part.name, part.input);
        }
        if (event.type === 'gui:tool') {
          const final = ['completed', 'failed', 'cancelled'].includes(event.status);
          note(event.id, event.name, event.input, event.input === undefined && !final ? '' : event.output);
          if (final) finish(event.id, event.is_error || event.status !== 'completed');
        }
        if (event.type === 'user' && Array.isArray(event.message?.content)) for (const part of event.message.content) {
          if (part.type !== 'tool_result') continue;
          const text = toolResultText(part.content);
          if (text) note(part.tool_use_id, '', undefined, text);
          finish(part.tool_use_id, part.is_error);
        }
      },
    };
  }
  return { textPaths, referencedArtifacts, toolPaths, toolRoots, toolDirectories, commandOutputPaths, reportedOutputPaths, ignoredOutputPath, collector, artifactPath, artifactStore, documentFormat, sortArtifacts, VISIBLE_ARTIFACT_LIMIT };
});
