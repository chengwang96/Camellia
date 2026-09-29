'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { latestFilePreview } = require('../src/main/remote/conversation-preview');
const { RemoteReadModel } = require('../src/main/remote/read-model');

test('conversation file preview uses the newest visible recorded files without exposing paths or payloads', () => {
  const rows = [
    { role: 'user', attachments: [{ name: 'old.png', isImage: true, data: 'PRIVATE_IMAGE' }] },
    { role: 'assistant', artifacts: [{ path: 'C:\\private\\研究报告.pdf', size: 48 }, { name: '图表.png', kind: 'image' }] },
    { role: 'assistant', internal: true, artifacts: [{ name: 'secret.txt' }] },
    { role: 'tool', artifacts: [{ name: 'tool.txt' }] },
  ];
  assert.deepEqual(latestFilePreview(rows), { name: '研究报告.pdf', isImage: false, count: 2 });
  rows.push({ role: 'user', attachments: [{ name: '/private/\u202enew\n.png', isImage: true, data: 'PRIVATE_IMAGE' }] });
  assert.deepEqual(latestFilePreview(rows), { name: 'new.png', isImage: true, count: 1 });
  assert.equal(latestFilePreview([{ role: 'assistant', text: 'A name mentioned in prose: report.pdf' }]), null);
});

test('list previews respect authorization and cache transcripts without adding work to live list hashes', () => {
  const visible = { id: 'visible', title: 'Report', seq: 1, updatedAt: 1 };
  const hidden = { id: 'hidden', title: 'Private', seq: 1, updatedAt: 1 };
  const meta = { workspaces: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    sessionWorkspace: { visible: 'a', hidden: 'b' }, archived: {}, pinned: {}, titles: {}, sessionOrder: {} };
  let reads = 0;
  let rows = [{ role: 'assistant', artifacts: [{ path: '/private/report.pdf' }] }];
  const manager = { items: new Map([['visible', visible], ['hidden', hidden]]),
    workspaces: { sessionMeta: () => meta }, activity: () => 'idle',
    rows: conversation => { reads++; assert.equal(conversation.id, 'visible'); return rows; } };
  const reader = new RemoteReadModel(manager), device = { workspaceIds: ['a'] };
  reader.listSnapshot(device); assert.equal(reads, 0);
  assert.deepEqual(reader.list(device).conversations.map(row => row.filePreview), [{ name: 'report.pdf', isImage: false, count: 1 }]);
  reader.list(device); reader.listSnapshot(device); assert.equal(reads, 1);
  visible.seq = 2; rows = [{ role: 'user', attachments: [{ name: 'replacement.csv' }] }];
  assert.equal(reader.list(device).conversations[0].filePreview.name, 'replacement.csv'); assert.equal(reads, 2);
  // A revised transcript with no file must remove the old preview.
  visible.seq = 3; rows = [{ role: 'user', text: 'replacement turn' }];
  assert.equal(reader.list(device).conversations[0].filePreview, undefined);
  device.workspaceIds = []; assert.deepEqual(reader.list(device).conversations, []);
});
