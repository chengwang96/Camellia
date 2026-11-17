"""Focused tests for the external resource collector; no live app changes."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('resource_monitor', Path(__file__).resolve().parents[1] / 'scripts/resource-monitor.py')
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


def process(pid, ppid, created, root=False):
    return {'pid': pid, 'ppid': ppid, 'created': created, 'root_candidate': root}


def sample(at, private, role='main'):
    return {'epoch': at, 'timestamp': monitor.utc(at), 'roots': ['10:1'], 'process_count': 1,
            'processes': [{'id': '10:1', 'pid': 10, 'role': role, 'private_bytes': private}],
            'totals': {'private_bytes': private}, 'disk_free_bytes': 100 * 1024 * monitor.MIB,
            'system_available_bytes': 8 * 1024 * monitor.MIB}


class ResourceMonitorTests(unittest.TestCase):
    def test_tree_selection_excludes_sampler_and_its_worker(self):
        inventory = {10: process(10, 1, 1, True), 11: process(11, 10, 2),
                     12: process(12, 11, 3), 13: process(13, 12, 4), 20: process(20, 1, 1)}
        owners, known, truncated = monitor.select_processes(inventory, {}, {'12:3.000000', '13:4.000000'})
        self.assertEqual(set(owners), {10, 11})
        self.assertEqual(known['11:2.000000'], '10:1.000000')
        self.assertFalse(truncated)

    def test_native_orphan_survives_a_root_exit_and_new_root_gets_a_separate_identity(self):
        inventory = {11: process(11, 10, 2), 30: process(30, 1, 10, True), 31: process(31, 30, 11)}
        owners, _, _ = monitor.select_processes(inventory, {'11:2.000000': '10:1.000000'}, set())
        self.assertEqual(owners[11], '10:1.000000')
        self.assertEqual(owners[31], '30:10.000000')

    def test_reused_pids_cannot_inherit_old_ownership_or_adopt_older_unrelated_children(self):
        inventory = {11: process(11, 1, 20), 30: process(30, 1, 10, True), 31: process(31, 30, 1)}
        owners, _, _ = monitor.select_processes(inventory, {'11:2.000000': '10:1.000000'}, set())
        self.assertEqual(set(owners), {30})

    def test_log_retention_has_a_hard_bound_and_keeps_recent_records(self):
        with tempfile.TemporaryDirectory(prefix='camellia-monitor-test-') as directory:
            log = monitor.SampleLog(Path(directory), limit=100, segments=4)
            for i in range(100):
                log.write({'sequence': i})
            files = list(Path(directory).glob('samples-*.jsonl'))
            self.assertLessEqual(len(files), 4)
            self.assertLessEqual(sum(file.stat().st_size for file in files), 400)
            records = list(monitor.read_records(Path(directory)))
            self.assertIn(99, [row['sequence'] for row in records])

    def test_directory_budget_marks_partial_counts(self):
        with tempfile.TemporaryDirectory(prefix='camellia-monitor-test-') as directory:
            for i in range(10):
                (Path(directory) / str(i)).write_bytes(b'x' * 100)
            result = monitor.directory_size(directory, max_entries=3, seconds=10)
            self.assertFalse(result['complete'])
            self.assertEqual(result['bytes'], 300)

    def test_summary_handles_rotated_segments_out_of_order_and_requires_sustained_growth(self):
        records = [sample(7201, 500 * monitor.MIB), sample(1, 100 * monitor.MIB), sample(3601, 300 * monitor.MIB)]
        result = monitor.summarize(records)
        self.assertEqual(result['core_process_trends'][0]['growth_bytes'], 400 * monitor.MIB)
        self.assertEqual(result['coverage_start'], monitor.utc(1))
        self.assertEqual(result['alerts'][0]['type'], 'sustained_private_memory_growth')
        self.assertFalse(result['alerts'][0]['confirmed_leak'])

    def test_brief_peaks_recovery_and_native_job_growth_are_not_reported_as_core_leaks(self):
        self.assertEqual(monitor.summarize([sample(1, 100 * monitor.MIB), sample(61, 900 * monitor.MIB)])['alerts'], [])
        recovered = [sample(1, 100 * monitor.MIB), sample(3601, 900 * monitor.MIB), sample(7201, 100 * monitor.MIB)]
        self.assertEqual(monitor.summarize(recovered)['alerts'], [])
        native = [sample(1, 100 * monitor.MIB, 'engine/helper'), sample(7201, 900 * monitor.MIB, 'engine/helper')]
        self.assertEqual(monitor.summarize(native)['alerts'], [])

    def test_incomplete_utf8_tail_is_not_converted_into_a_zero_sample(self):
        with tempfile.TemporaryDirectory(prefix='camellia-monitor-test-') as directory:
            data = json.dumps({'sequence': 1}).encode() + b'\n{"broken":"\xf0\x9f'
            (Path(directory) / 'samples-0.jsonl').write_bytes(data)
            self.assertEqual(list(monitor.read_records(Path(directory))), [{'sequence': 1}])

    def test_only_complete_directory_scans_are_used_to_flag_log_growth(self):
        before, partial, after = sample(1, 100), sample(901, 100), sample(3601, 100)
        before['directory_sizes'] = {'app_logs': {'bytes': 100, 'complete': True}}
        partial['directory_sizes'] = {'app_logs': {'bytes': 100 * 1024 * monitor.MIB, 'complete': False}}
        after['directory_sizes'] = {'app_logs': {'bytes': 600 * monitor.MIB, 'complete': True}}
        result = monitor.summarize([after, partial, before])
        self.assertEqual(result['alerts'][0]['type'], 'application_log_growth')
        self.assertLess(result['directory_trends_from_complete_scans']['app_logs']['growth_bytes'], 601 * monitor.MIB)


if __name__ == '__main__':
    unittest.main()
