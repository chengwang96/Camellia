'use strict';

// List previews describe recorded files. Availability is still checked when
// opening a chat's artifact menu. Paths and attachment contents stay private.
function filename(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\\/g, '/').split('/').pop().replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 180);
}

function latestFilePreview(rows) {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (!row || row.internal || !['user', 'assistant'].includes(row.role)) continue;
    const source = row.role === 'user' ? row.attachments : row.artifacts;
    if (!Array.isArray(source)) continue;
    const files = source.filter(file => file && typeof file === 'object')
      .map(file => ({ name: filename(file.name || file.path), isImage: file.isImage === true || file.kind === 'image' }))
      .filter(file => file.name && file.name !== '.' && file.name !== '..').slice(0, 100);
    if (files.length) return { ...files[0], count: files.length };
  }
  return null;
}

module.exports = { latestFilePreview };
