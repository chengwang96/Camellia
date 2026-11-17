"""Bounded, external Camellia resource sampling; never reads conversation content.

Run with --config <absolute JSON file>. --once validates one sample; --report
summarizes existing data without starting a collector or changing the app.
The collector has a fixed wall-clock deadline. Camellia Tasks handles reviews.
"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import stat
import sys
import threading
import time
from datetime import datetime, timezone

import psutil

MIB = 1024 * 1024
MAX_PROCESSES = 2048
MAX_RECORD = 2 * MIB


def utc(stamp=None):
    return datetime.fromtimestamp(time.time() if stamp is None else stamp, timezone.utc).isoformat()


def identity(pid, created):
    return f'{pid}:{created:.6f}'


def atomic_json(file, data):
    payload = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    if len(payload.encode('utf-8')) > MAX_RECORD:
        raise ValueError('Diagnostic JSON exceeds its 2 MiB bound')
    temporary = file.with_suffix(file.suffix + '.tmp')
    temporary.write_text(payload, encoding='utf-8')
    os.replace(temporary, file)


class SampleLog:
    def __init__(self, directory, limit=8 * MIB, segments=4):
        self.directory, self.limit, self.segments = directory, limit, segments
        self.index = 0

    def write(self, data):
        payload = (json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
        if len(payload) > min(MAX_RECORD, self.limit):
            raise ValueError('Resource sample exceeds its record bound')
        file = self.directory / f'samples-{self.index}.jsonl'
        if file.exists() and file.stat().st_size + len(payload) > self.limit:
            self.index = (self.index + 1) % self.segments
            file = self.directory / f'samples-{self.index}.jsonl'
            # Only these four diagnostic files are reused; no source/user data.
            file.write_bytes(b'')
        with file.open('ab') as output:
            output.write(payload)


def select_processes(inventory, known, excluded):
    """Retain live orphaned descendants, but never inherit a reused PID."""
    owners = {}
    for pid, row in inventory.items():
        key = identity(pid, row['created'])
        if key in excluded:
            continue
        if row.get('root_candidate'):
            owners[pid] = key
        elif key in known:
            owners[pid] = known[key]
    children = {}
    for row in inventory.values():
        children.setdefault(row['ppid'], []).append(row)
    pending = list(owners)
    truncated = len(pending) > MAX_PROCESSES
    for parent in pending:
        if len(owners) >= MAX_PROCESSES:
            truncated = True
            break
        for child in children.get(parent, []):
            pid = child['pid']
            key = identity(pid, child['created'])
            if pid in owners or key in excluded or child['created'] < inventory[parent]['created']:
                continue
            if len(owners) >= MAX_PROCESSES:
                truncated = True
                break
            owners[pid] = owners[parent]
            pending.append(pid)
    owners = dict(list(owners.items())[:MAX_PROCESSES])
    return owners, {identity(pid, inventory[pid]['created']): owner for pid, owner in owners.items()}, truncated


def basic_process_inventory():
    if os.name != 'nt':
        return {p.pid: {'pid': p.pid, 'ppid': p.info['ppid'], 'name': p.info['name']}
                for p in psutil.process_iter(['ppid', 'name'])}
    from ctypes import wintypes

    class Entry(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('usage', wintypes.DWORD), ('pid', wintypes.DWORD),
                    ('heap', ctypes.c_size_t), ('module', wintypes.DWORD), ('threads', wintypes.DWORD),
                    ('ppid', wintypes.DWORD), ('priority', wintypes.LONG), ('flags', wintypes.DWORD),
                    ('name', wintypes.WCHAR * 260)]

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    for method in [kernel.Process32FirstW, kernel.Process32NextW]:
        method.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
        method.restype = wintypes.BOOL
    handle = kernel.CreateToolhelp32Snapshot(2, 0)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    rows, entry = {}, Entry()
    entry.size = ctypes.sizeof(entry)
    try:
        more = kernel.Process32FirstW(handle, ctypes.byref(entry))
        while more:
            rows[entry.pid] = {'pid': entry.pid, 'ppid': entry.ppid, 'name': entry.name}
            more = kernel.Process32NextW(handle, ctypes.byref(entry))
        error = ctypes.get_last_error()
        if error not in [0, 18]:
            raise ctypes.WinError(error)
    finally:
        kernel.CloseHandle(handle)
    return rows


def process_inventory(config, known):
    rows, basic = {}, basic_process_inventory()
    executable = os.path.normcase(config['electron_exe'])
    repo = os.path.normcase(os.path.normpath(config['repo']))
    name = Path(config['electron_exe']).name.lower()
    candidates = {int(key.split(':', 1)[0]) for key in known if int(key.split(':', 1)[0]) in basic}
    for pid, info in basic.items():
        if info['name'].lower() != name:
            continue
        try:
            process = psutil.Process(pid)
            if os.path.normcase(process.exe()) != executable:
                continue
            args = process.cmdline()[1:]
            types = [arg.split('=', 1)[1] for arg in args if arg.startswith('--type=')]
            info['role'] = types[0] if types else 'main'
            selected = (pid == config['initial_pid'] and abs(process.create_time() - config['initial_created']) < .001)
            launch = any(arg == '.' or os.path.normcase(os.path.normpath(arg)) == repo for arg in args)
            info['root_candidate'] = not types and (selected or launch)
            if info['root_candidate']:
                candidates.add(pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    children = {}
    for info in basic.values():
        children.setdefault(info['ppid'], []).append(info['pid'])
    pending = list(candidates)
    for parent in pending:
        for child in children.get(parent, []):
            if child not in candidates and len(candidates) < MAX_PROCESSES:
                candidates.add(child)
                pending.append(child)
    for pid in candidates:
        try:
            rows[pid] = {**basic[pid], 'created': psutil.Process(pid).create_time(),
                         'role': basic[pid].get('role', 'engine/helper'),
                         'root_candidate': basic[pid].get('root_candidate', False)}
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    psutil.process_iter.cache_clear()
    return rows


def directory_size(directory, max_entries=10000, seconds=.5):
    """Bounded metadata-only scan. Partial counts are explicitly marked."""
    started, total, entries, files, largest = time.monotonic(), 0, 0, 0, 0
    pending = [(Path(directory), 0)]
    complete = True
    if not Path(directory).exists():
        return {'bytes': 0, 'files': 0, 'complete': True, 'exists': False}
    while pending and complete:
        current, depth = pending.pop()
        try:
            meta = current.lstat()
            if stat.S_ISLNK(meta.st_mode) or getattr(meta, 'st_file_attributes', 0) & 0x400:
                complete = False
                break
            with os.scandir(current) as children:
                for child in children:
                    entries += 1
                    if entries > max_entries or time.monotonic() - started > seconds:
                        complete = False
                        break
                    info = child.stat(follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                        continue
                    if stat.S_ISDIR(info.st_mode):
                        if depth >= 32:
                            complete = False
                        else:
                            pending.append((Path(child.path), depth + 1))
                    elif stat.S_ISREG(info.st_mode):
                        files += 1
                        total += info.st_size
                        largest = max(largest, info.st_size)
        except OSError:
            complete = False
    return {'bytes': total, 'files': files, 'largest_file_bytes': largest, 'complete': complete, 'exists': True}


class Collector:
    def __init__(self, config):
        self.config, self.known, self.cpu, self.disk = config, {}, {}, {}
        self.disk_at = 0
        self.previous_sample = None
        self.excluded = set()
        for pid in [os.getpid(), os.getppid()]:
            try:
                self.excluded.add(identity(pid, psutil.Process(pid).create_time()))
            except psutil.Error:
                pass

    def sample(self, sequence):
        now, started = time.time(), time.monotonic()
        inventory = process_inventory(self.config, self.known)
        owners, self.known, truncated = select_processes(inventory, self.known, self.excluded)
        processes, next_cpu, unreadable = [], {}, 0
        for pid, owner in owners.items():
            row = inventory[pid]
            try:
                process = psutil.Process(pid)
                if abs(process.create_time() - row['created']) > .001:
                    continue
                memory = process.memory_info()
                cpu = process.cpu_times()
                key = identity(pid, row['created'])
                total_cpu = cpu.user + cpu.system
                previous = self.cpu.get(key)
                percent = None if not previous else max(0, 100 * (total_cpu - previous[1]) / max(.001, now - previous[0]))
                next_cpu[key] = (now, total_cpu)
                value = {'id': key, 'pid': pid, 'root': owner, 'name': row['name'], 'role': row['role'],
                         'created': row['created'], 'rss_bytes': memory.rss,
                         'private_bytes': getattr(memory, 'private', memory.vms),
                         'cpu_pct_one_core': None if percent is None else round(percent, 2),
                         'handles': process.num_handles(), 'threads': process.num_threads()}
                try:
                    io = process.io_counters()
                    value.update(io_read_bytes=io.read_bytes, io_write_bytes=io.write_bytes)
                except psutil.Error:
                    pass
                processes.append(value)
            except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
                unreadable += 1
        self.cpu = next_cpu
        if now - self.disk_at >= 900:
            self.disk = {name: directory_size(directory) for name, directory in self.config['watch_directories'].items()}
            self.disk_at = now
        memory = psutil.virtual_memory()
        disk_free = psutil.disk_usage(self.config['repo']).free
        totals = {key: sum(value[key] for value in processes) for key in ['rss_bytes', 'private_bytes', 'handles', 'threads']}
        totals['cpu_pct_one_core'] = round(sum(value['cpu_pct_one_core'] or 0 for value in processes), 2)
        record = {'sequence': sequence, 'timestamp': utc(now), 'epoch': now,
                  'gap_seconds': None if self.previous_sample is None else round(now - self.previous_sample, 2),
                  'roots': [identity(pid, row['created']) for pid, row in inventory.items() if row['root_candidate']],
                  'process_count': len(processes), 'processes': processes, 'totals': totals,
                  'unreadable_processes': unreadable, 'tracking_truncated': truncated,
                  'system_available_bytes': memory.available, 'system_total_bytes': memory.total,
                  'disk_free_bytes': disk_free, 'directory_sizes': self.disk, 'directory_sample_epoch': self.disk_at}
        record['sample_duration_seconds'] = round(time.monotonic() - started, 3)
        self.previous_sample = now
        return record


def read_records(directory):
    for file in sorted(directory.glob('samples-[0-3].jsonl')):
        with file.open('rb') as source:
            while True:
                line = source.readline(MAX_RECORD + 1)
                if not line:
                    break
                if len(line) > MAX_RECORD:
                    raise ValueError('Oversized resource sample')
                try:
                    yield json.loads(line)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    # An interrupted final write is a gap, never a zero sample.
                    continue


def summarize(records):
    states, directories, alerts, count, first, last = {}, {}, [], 0, None, None
    for record in records:
        stamp = record['epoch']
        count += 1
        first = stamp if first is None else min(first, stamp)
        if last is None or stamp > last['epoch']:
            last = record
        for name, info in record.get('directory_sizes', {}).items():
            if not info.get('complete'):
                continue
            at = record.get('directory_sample_epoch', stamp)
            entry = directories.setdefault(name, {'first_at': at, 'last_at': at,
                                                  'first_bytes': info['bytes'], 'last_bytes': info['bytes']})
            if at <= entry['first_at']:
                entry.update(first_at=at, first_bytes=info['bytes'])
            if at >= entry['last_at']:
                entry.update(last_at=at, last_bytes=info['bytes'])
        for row in record['processes']:
            if row['role'] not in ['main', 'renderer']:
                continue
            key = row['id']
            if key not in states and len(states) >= 4096:
                continue
            entry = states.setdefault(key, {'pid': row['pid'], 'role': row['role'], 'first_at': stamp,
                                           'last_at': stamp, 'last_bytes': row['private_bytes'], 'buckets': {}})
            entry['first_at'] = min(entry['first_at'], stamp)
            if stamp >= entry['last_at']:
                entry['last_at'], entry['last_bytes'] = stamp, row['private_bytes']
            bucket = int(stamp // 900)
            entry['buckets'][bucket] = min(entry['buckets'].get(bucket, row['private_bytes']), row['private_bytes'])
    trends = []
    for key, entry in states.items():
        buckets = sorted(entry.pop('buckets').items())
        hours = (entry['last_at'] - entry['first_at']) / 3600
        before, after = buckets[0][1], buckets[-1][1]
        growth = after - before
        entry.update(id=key, duration_hours=round(hours, 2), first_low_private_bytes=before,
                     last_low_private_bytes=after, growth_bytes=growth,
                     growth_mib_per_hour=round(growth / MIB / max(hours, .01), 2))
        # These thresholds flag investigation candidates, not proof of a leak.
        if hours >= 2 and growth >= 256 * MIB and after >= before * 1.5 and growth / hours >= 64 * MIB:
            alerts.append({'type': 'sustained_private_memory_growth', 'pid': entry['pid'], 'role': entry['role'],
                           'growth_mib': round(growth / MIB, 1), 'hours': round(hours, 2), 'confirmed_leak': False})
        trends.append(entry)
    if last and last['disk_free_bytes'] < 10 * 1024 * MIB:
        alerts.append({'type': 'low_disk_space', 'free_gib': round(last['disk_free_bytes'] / (1024 * MIB), 2)})
    if last and last['system_available_bytes'] < 2 * 1024 * MIB:
        alerts.append({'type': 'system_memory_pressure', 'available_mib': round(last['system_available_bytes'] / MIB)})
    for name, entry in directories.items():
        growth = entry['last_bytes'] - entry['first_bytes']
        entry['growth_bytes'] = growth
        if name == 'app_logs' and growth >= 512 * MIB:
            alerts.append({'type': 'application_log_growth', 'growth_mib': round(growth / MIB, 1)})
    return {'samples_in_retained_logs': count, 'coverage_start': None if first is None else utc(first),
            'coverage_end': None if last is None else last['timestamp'], 'alerts': alerts[:100],
            'core_process_trends': sorted(trends, key=lambda value: value['growth_bytes'], reverse=True)[:16],
            'latest_totals': None if last is None else last['totals'],
            'latest_process_count': None if last is None else last['process_count'],
            'latest_roots': [] if last is None else last['roots'],
            'latest_disk_free_bytes': None if last is None else last['disk_free_bytes'],
            'latest_directory_sizes': {} if last is None else last.get('directory_sizes', {}),
            'directory_trends_from_complete_scans': directories,
            'interpretation': 'Private-memory growth is a candidate for investigation; RSS peaks and normal workload growth alone do not prove a leak.'}


def report(config):
    directory = Path(config['output_dir'])
    status_file = directory / 'status.json'
    status = json.loads(status_file.read_text(encoding='utf-8')) if status_file.exists() else {'state': 'missing'}
    result = summarize(read_records(directory))
    result.update(generated_at=utc(), collector_state=status.get('state'), collector_pid=status.get('pid'),
                  sampling_ends_at=config['ends_at'], configured_interval_seconds=config['interval_seconds'])
    if status.get('state') in ['failed', 'missing']:
        result['alerts'].append({'type': 'collector_' + status['state'], 'error': status.get('error')})
    if status.get('state') in ['running', 'starting']:
        process = None
        try:
            process = psutil.Process(status['pid'])
            alive = abs(process.create_time() - status['created']) < .001
        except psutil.Error:
            alive = False
        result['collector_alive'] = alive
        if not alive:
            result['alerts'].append({'type': 'collector_not_running'})
        elif time.time() - status.get('last_sample_epoch', 0) > config['interval_seconds'] * 3:
            result['alerts'].append({'type': 'sampling_gap', 'possible_sleep_or_shutdown': True})
    atomic_json(directory / 'analysis.json', result)
    return result


def run(config, once=False):
    directory = Path(config['output_dir'])
    if (directory / 'status.json').exists():
        raise ValueError('This monitoring run already has a status record; use a new directory, not a duplicate collector')
    interval = config['interval_seconds']
    end = datetime.fromisoformat(config['ends_at']).timestamp()
    if not .25 <= interval <= 3600 or not time.time() < end <= time.time() + 48 * 3600 + 60:
        raise ValueError('Invalid sampling interval or deadline')
    collector, log = Collector(config), SampleLog(directory)
    me = psutil.Process()
    status = {'state': 'starting', 'pid': me.pid, 'created': me.create_time(), 'started_at': utc(),
              'ends_at': config['ends_at'], 'interval_seconds': interval, 'sample_count': 0,
              'max_sample_log_bytes': 32 * MIB}
    atomic_json(directory / 'status.json', status)
    print(json.dumps({'event': 'collector_started', **status}), flush=True)
    deadline, event = time.monotonic(), threading.Event()
    try:
        while time.time() < end and not (directory / 'stop.request').exists():
            value = collector.sample(status['sample_count'] + 1)
            log.write(value)
            if status['sample_count'] == 0:
                atomic_json(directory / 'baseline.json', value)
            status.update(state='running', sample_count=value['sequence'], last_sample_at=value['timestamp'],
                          last_sample_epoch=value['epoch'], process_count=value['process_count'], roots=value['roots'],
                          totals=value['totals'], sampler_private_bytes=getattr(me.memory_info(), 'private', me.memory_info().vms))
            atomic_json(directory / 'status.json', status)
            if once:
                break
            deadline += interval
            if deadline <= time.monotonic():
                deadline = time.monotonic() + interval
            event.wait(min(max(0, deadline - time.monotonic()), max(0, end - time.time())))
        status.update(state='completed' if once or time.time() >= end else 'stopped', stopped_at=utc())
    except BaseException as error:
        status.update(state='failed', error=str(error)[:1000], stopped_at=utc())
        raise
    finally:
        atomic_json(directory / 'status.json', status)
        print(json.dumps({'event': 'collector_stopped', **status}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--once', action='store_true')
    mode.add_argument('--report', action='store_true')
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding='utf-8-sig'))
    directory = Path(config['output_dir'])
    if not directory.is_absolute() or directory.resolve() != args.config.resolve().parent or directory.is_symlink():
        raise ValueError('Output must be the configuration directory itself')
    if args.report:
        print(json.dumps(report(config), ensure_ascii=False))
    else:
        run(config, args.once)


if __name__ == '__main__':
    main()
