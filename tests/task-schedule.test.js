'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSchedule, nextTaskRun, scheduleLabel, taskNotice } = require('../src/shared/task-schedule');
const stamp = Date.parse;
const daily = (time, timeZone, lastRunAt) => ({ schedule: normalizeSchedule({ scheduleType: 'daily', dailyTime: time, timeZone }), lastRunAt });

test('one-time dates require an offset and reject calendar rollover', () => {
  for (const runAt of ['2026-11-19T09:00', '2026-02-30T09:00:00Z', '2026-11-19T24:00:00Z', 'tomorrow'])
    assert.throws(() => normalizeSchedule({ scheduleType: 'once', runAt }));
  assert.deepEqual(normalizeSchedule({ scheduleType: 'once', runAt: '2026-11-19T09:00:00+08:00' }),
    { type: 'once', at: '2026-11-19T01:00:00.000Z' });
  assert.throws(() => normalizeSchedule({ runAt: '2026-11-19T09:00:00Z' }), /schedule type/);
});
test('daily schedules require a valid local time and explicit time zone', () => {
  for (const [dailyTime, timeZone] of [['24:00', 'UTC'], ['9:00', 'UTC'], ['09:00', 'Invalid/Zone'], ['09:00', '']])
    assert.throws(() => daily(dailyTime, timeZone));
  assert.equal(nextTaskRun(daily('09:00', 'Asia/Hong_Kong'), stamp('2026-11-18T00:00Z')), stamp('2026-11-18T01:00Z'));
  assert.equal(nextTaskRun(daily('09:00', 'Asia/Kathmandu'), stamp('2026-11-18T00:00Z')), stamp('2026-11-18T03:15Z'));
});
test('daily scheduling crosses year boundaries in the selected zone', () => {
  assert.equal(nextTaskRun(daily('09:00', 'Pacific/Kiritimati'), stamp('2026-12-31T23:00Z')), stamp('2027-01-01T19:00Z'));
});
test('DST spring skips a missing local minute instead of running at a different time', () => {
  assert.equal(nextTaskRun(daily('02:30', 'America/New_York'), stamp('2026-03-08T05:00Z')), stamp('2026-03-09T06:30Z'));
});
test('DST autumn chooses the first future copy and never runs twice on one local date', () => {
  assert.equal(nextTaskRun(daily('01:30', 'America/New_York'), stamp('2026-11-01T04:00Z')), stamp('2026-11-01T05:30Z'));
  assert.equal(nextTaskRun(daily('01:30', 'America/New_York', stamp('2026-11-01T05:30Z')), stamp('2026-11-01T06:00Z')), stamp('2026-11-02T06:30Z'));
});
test('manual resume of a missed one-time check runs once now; daily checks skip missed days', () => {
  const once = { schedule: normalizeSchedule({ scheduleType: 'once', runAt: '2026-11-18T09:00:00Z' }) };
  const now = stamp('2026-11-20T12:00Z');
  assert.equal(nextTaskRun(once, now, { resume: true }), now);
  assert.equal(nextTaskRun(daily('09:00', 'UTC'), now), stamp('2026-11-21T09:00Z'));
});
test('localized notices keep lifecycle reasons separate from check evidence', () => {
  const task = { status: 'paused', pauseReason: 'run-limit', lastCheck: { summary: 'Healthy' } };
  assert.match(taskNotice(task), /Check limit reached/); assert.match(taskNotice(task, 'zh-CN'), /次数已用完/);
  assert.match(taskNotice({ status: 'scheduled', waitingReason: 'goal' }), /Goal/);
  assert.match(scheduleLabel(daily('09:00', 'Asia/Hong_Kong')), /09:00.*Asia\/Hong_Kong/);
  assert.match(scheduleLabel({ intervalMinutes: 0 }), /Invalid/);
});
