'use strict';

// The file-search tool for the model. Users often know a document exists but
// not its name or folder, so a plain name search cannot help: the model has to
// try terms, read what comes back and narrow down. This tool gives it that
// ability without handing over shell access.

const identifier = { type: 'string', minLength: 1, maxLength: 128 };
const schema = (properties, required = []) => ({ type: 'object', properties: { ...properties, run_token: identifier }, required: [...required, 'run_token'], additionalProperties: false });

const tools = [
  { name: 'camellia_find_files',
    description: 'Find files on this computer. It first looks through what earlier Camellia conversations wrote, which matches how a user remembers their own files, and then falls back to the filesystem. Use it when the user describes a file whose name or folder they do not know; set inside to search the text inside readable files instead. Call it again with different words when the first search misses. Read-only and bounded; it never starts an engine or changes files.',
    inputSchema: schema({ query: { type: 'string', maxLength: 500, description: 'File name, extension or wildcard; the words used to describe the file; or the text to look for inside files when inside is true. Empty lists the files recent conversations produced, newest first.' },
      inside: { type: 'boolean', description: 'Match text inside readable files instead of matching file names.' } }, ['query']) },
];

const instructions = 'camellia_find_files searches the computer for files. Use it whenever the user wants to locate a file but does not give an exact name or path, and prefer it over guessing shell commands. Its first pass matches what earlier conversations edited or produced, using the paths and the words recorded around those turns, so a file whose name the user has forgotten is usually found without reading any content; set inside: true when the words are likely inside the document instead. Call it again with different terms when the first search misses. It is read-only and bounded. Report the exact paths it returns so the user can open or download them, and say plainly when nothing matched instead of inventing a path.';

module.exports = { tools, instructions };
