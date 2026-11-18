(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CamelliaTaskSchedule = api;
})(globalThis, function () {
  'use strict';
  const MINUTE = 60000, DAY = 86400000;
  const formatters = new Map();
  function zonedParts(at, zone) {
    if (!formatters.has(zone)) {
      if (formatters.size >= 64) formatters.clear();
      formatters.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    }
    return Object.fromEntries(formatters.get(zone).formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  }
  const localStamp = p => Date.UTC(p.year, p.month - 1, p.day, p.hour || 0, p.minute || 0, p.second || 0);
  const sameDay = (a, b) => a.year === b.year && a.month === b.month && a.day === b.day;
  function normalizeSchedule(value) {
    const saved = value.schedule || {};
    const type = value.scheduleType ?? saved.type ?? 'interval';
    if (!value.scheduleType && !saved.type && (value.runAt != null || value.dailyTime != null || value.timeZone != null))
      throw new Error('Choose a schedule type for the supplied time');
    if (type === 'interval') {
      const minutes = value.intervalMinutes ?? saved.minutes ?? 10;
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('Invalid task option: intervalMinutes');
      return { type, minutes };
    }
    if (type === 'once') {
      const at = value.runAt ?? saved.at;
      // An explicit offset prevents the host and a remote client from assigning different instants.
      const match = typeof at === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(at);
      const stamp = match ? Date.parse(at) : NaN;
      if (!Number.isFinite(stamp)) throw new Error('Run time must be an ISO date with a UTC offset');
      const offset = match[8] === 'Z' ? 0 : (match[8][0] === '-' ? -1 : 1) * (Number(match[8].slice(1, 3)) * 60 + Number(match[8].slice(4)));
      const local = new Date(stamp + offset * MINUTE);
      if (local.getUTCFullYear() !== Number(match[1]) || local.getUTCMonth() + 1 !== Number(match[2])
          || local.getUTCDate() !== Number(match[3]) || local.getUTCHours() !== Number(match[4])
          || local.getUTCMinutes() !== Number(match[5]) || local.getUTCSeconds() !== Number(match[6] || 0))
        throw new Error('Invalid run date or time');
      return { type, at: new Date(stamp).toISOString() };
    }
    if (type === 'daily') {
      const time = value.dailyTime ?? saved.time, zone = value.timeZone ?? saved.timeZone;
      if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Daily time must use HH:mm');
      if (typeof zone !== 'string' || zone.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.\-]+)*$/.test(zone)) throw new Error('Choose an IANA time zone');
      let timeZone;
      try { timeZone = new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone; }
      catch { throw new Error('Unknown time zone: ' + zone); }
      return { type, time, timeZone };
    }
    throw new Error('Invalid task schedule type');
  }
  function nextTaskRun(task, after, { resume = false } = {}) {
    const schedule = task.schedule || normalizeSchedule(task);
    if (schedule.type === 'interval') return after + schedule.minutes * MINUTE;
    if (schedule.type === 'once') return resume ? Math.max(after, Date.parse(schedule.at)) : Date.parse(schedule.at);
    const today = zonedParts(after, schedule.timeZone);
    const lastDay = task.lastRunAt == null ? null : zonedParts(task.lastRunAt, schedule.timeZone);
    const [hour, minute] = schedule.time.split(':').map(Number);
    // Offsets on both sides of a DST transition identify both copies of a repeated minute.
    // A missing local minute is skipped; a repeated minute runs only once per local date.
    for (let day = 0; day < 4; day++) {
      const date = new Date(localStamp({ ...today, hour: 0, minute: 0, second: 0 }) + day * DAY);
      const target = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute, second: 0 };
      if (lastDay && sameDay(target, lastDay)) continue;
      const naive = localStamp(target), offsets = new Set();
      for (let hours = -36; hours <= 36; hours += 6) {
        const probe = naive + hours * 3600000;
        offsets.add(localStamp(zonedParts(probe, schedule.timeZone)) - probe);
      }
      const matches = [...offsets].map(offset => naive - offset).filter(at => {
        if (at <= after) return false;
        const parts = zonedParts(at, schedule.timeZone);
        return sameDay(parts, target) && parts.hour === hour && parts.minute === minute;
      });
      if (matches.length) return Math.min(...matches);
    }
    throw new Error('Could not find the next daily run');
  }
  function scheduleLabel(task, locale = 'en') {
    const zh = locale.startsWith('zh');
    let schedule;
    try { schedule = normalizeSchedule(task); } catch { return zh ? '调度设置无效' : 'Invalid schedule'; }
    if (schedule.type === 'daily') return zh ? `每天 ${schedule.time}（${schedule.timeZone}）` : `Daily at ${schedule.time} (${schedule.timeZone})`;
    if (schedule.type === 'once') return (zh ? '执行一次：' : 'Once: ') + new Date(schedule.at).toLocaleString(locale);
    return zh ? `每 ${schedule.minutes} 分钟` : `Every ${schedule.minutes} min`;
  }
  function taskNotice(task, locale = 'en') {
    const zh = locale.startsWith('zh');
    if (task.stopError) return task.stopError;
    if (task.stopping) return zh ? '正在停止检查…' : 'Stopping check…';
    const waiting = {
      goal: ['Waiting for Goal to pause or finish.', '等待目标模式暂停或结束。'],
      compaction: ['Waiting for context compaction.', '等待上下文压缩完成。'],
      review: ['Waiting for the turn review.', '等待本轮审查完成。'],
      conversation: ['Waiting for the current conversation turn.', '等待当前回复结束。'],
      task: ['Waiting for another scheduled check.', '等待另一项定时检查结束。'],
    };
    const paused = {
      user: ['Paused by user.', '已由用户暂停。'],
      restart: ['Application restarted; resume manually.', '应用已重启，请手动恢复。'],
      'run-limit': ['Check limit reached. Increase Maximum checks before resuming.', '检查次数已用完，请增加最大检查次数后恢复。'],
      deadline: ['Deadline reached. Extend Maximum hours before resuming.', '已到截止时间，请延长最长时限后恢复。'],
      'schedule-limit': ['No further check fits before the deadline. Extend Maximum hours before resuming.', '截止前已无法安排下一次检查，请延长最长时限后恢复。'],
      blocked: ['Intervention needed. Review the last result before resuming.', '需要人工处理，请查看最近结果后恢复。'],
      'check-error': ['Check failed. Review the error before resuming.', '检查失败，请查看错误后恢复。'],
      'missing-report': ['Check returned no structured result; review before resuming.', '检查未返回结构化结果，请核实后恢复。'],
      storage: ['Task storage failed. Check disk access before resuming.', '任务保存失败，请检查磁盘访问权限后恢复。'],
      'invalid-settings': ['Saved settings are invalid; edit before resuming.', '保存的设置无效，请编辑后恢复。'],
    };
    const message = task.status === 'scheduled' ? waiting[task.waitingReason] : task.status === 'paused' ? paused[task.pauseReason] : null;
    return message?.[zh ? 1 : 0] || '';
  }
  return { normalizeSchedule, nextTaskRun, scheduleLabel, taskNotice };
});
