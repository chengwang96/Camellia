'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { announcesPendingWork } = require('../src/shared/pending-work');

test('announcement detection recognizes action-only updates in English and Chinese', () => {
  for (const text of [
    'I will check the disk usage before moving anything.',
    "I'll first scan the C drive, then decide what is safe to move.",
    'First, I will inspect the largest files.',
    'Let me scan the directory.',
    '我先扫描 C 盘的大文件，再判断哪些可以迁移。',
    '我先扫 C 盘的空间分布和大文件，再判断哪些能安全迁到 E 盘。',
    '好的，我先检查一下磁盘占用。',
    '接下来我会去比较两个目录。',
    '让我先确认一下配置。',
  ]) assert.equal(announcesPendingWork(text), true, text);
});

test('announcement detection leaves completed answers and ordinary replies alone', () => {
  for (const text of [
    'The requested change is complete.',
    'Done. The report is saved.',
    'Here are the results: 12 files use 8 GB.',
    'I fixed the stale cache entry.',
    '已完成迁移，C 盘现在剩余 42 GB。',
    '结果如下：共找到 12 个大文件。',
    'Let me know if you want a different target drive.',
    'C 盘的占用主要来自缓存目录。',
  ]) assert.equal(announcesPendingWork(text), false, text);
});
