"""Offline only: synthetic tar/logs; adb interactions are mocked."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import acceptance
import takeover_verify as verify

FIXTURE = Path(__file__).parent / 'fixtures/takeover-digest-v1.tsv'
FRAMEWORK = Path(os.environ.get('PODJS_T11_FRAMEWORK', '/home/wilf/data/PodJS/podjs-watch'))


def fixture_rows():
    return [(path, bytes.fromhex(data)) for path, data in
            (line.split('\t') for line in FIXTURE.read_text().splitlines())]


def archive(rows, kind=None):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as tar:
        for path, data in rows:
            member = tarfile.TarInfo(path)
            if kind:
                member.type = kind
                member.linkname = 'files/private-account-cookie.txt'
                tar.addfile(member)
            else:
                member.size = len(data)
                tar.addfile(member, io.BytesIO(data))
    stream.seek(0)
    return stream


class TakeoverVerifyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.out = Path(self.temp.name)
        self.roots = verify.stream_digest(archive(fixture_rows()))
        self.before = {'format': verify.FORMAT, 'package': 'com.example.native', 'serial': 'offline',
                       'source': {'debuggable': True, 'versionCode': 40, 'uid': 10101},
                       'capturedAt': 1000, 'roots': self.roots, 'archiveStored': False, 'contentStored': False}
        self.a = SimpleNamespace(package=self.before['package'], serial='offline', dry_run=False,
                                 out=self.out / 'pre.json', pre=self.out / 'pre.json', generation=None)

    def logs(self, roots=None, phase=None, generation='g-fixture', epoch=1001, pid=123):
        roots = roots or self.roots
        return [f'{epoch:.3f} {pid} 124 I PodTakeoverDigest: ' + json.dumps(dict(
                phase=p, generation=generation, root=r, **summary))
                for p in ((phase,) if phase else ('SNAPSHOTTED', 'ACTIVE'))
                for r, summary in roots.items()]

    def test_cross_language_same_fixture_and_tar_bytes(self):
        fw_fixture = FRAMEWORK / 'tests/fixtures/takeover-digest-v1.tsv'
        self.assertEqual(FIXTURE.read_bytes(), fw_fixture.read_bytes())
        with tempfile.TemporaryDirectory() as classes:
            subprocess.run(['javac', '-d', classes,
                str(FRAMEWORK / 'platforms/android/runtime/src/main/java/dev/podjs/takeover/NativeBackup.java'),
                str(FRAMEWORK / 'platforms/android/runtime/src/main/java/dev/podjs/takeover/TakeoverDigest.java'),
                str(FRAMEWORK / 'tests/java/dev/podjs/takeover/TakeoverDigestTest.java')], check=True, capture_output=True)
            lines = subprocess.run(['java', '-ea', '-cp', classes,
                'dev.podjs.takeover.TakeoverDigestTest', str(FIXTURE)], check=True, capture_output=True, text=True).stdout.splitlines()
        java = {row['root']: {k: row[k] for k in ('files', 'bytes', 'sha256')}
                for row in map(json.loads, lines)}
        self.assertEqual(java, self.roots)
        self.assertEqual(self.roots, verify.stream_digest(archive(list(reversed(fixture_rows())))))
        self.assertEqual(self.roots['no_backup'], {'files': 0, 'bytes': 0, 'sha256': hashlib.sha256(b'').hexdigest()})
        self.assertEqual(self.roots['manifest']['files'], len(fixture_rows()))

    def test_cache_excluded_from_pre_and_protocol(self):
        self.assertNotIn('cache', verify.ROOTS)
        with self.assertRaises(ValueError):
            verify.stream_digest(archive(fixture_rows() + [('cache/private.bin', b'ignored')]))
        with self.assertRaises(ValueError):
            verify.summarize({'cache/private.bin': (0, hashlib.sha256(b'').hexdigest())})
        self.assertNotIn('cache', self.roots)

    def test_tar_privacy_and_owned_scope(self):
        rows = fixture_rows() + [('files/package-takeover/journal', b'private'),
            ('files/.podjs-takeover-backup/g-old/data/files/secret', b'private'),
            ('no_backup/podjs-runtime/state', b'private'), ('databases/podjs.sqlite-wal', b'private')]
        result = verify.stream_digest(archive(rows))
        self.assertEqual(result, self.roots)
        serialized = json.dumps(result)
        for text in ('private', 'cookie', 'account', '.txt', '.bin', '.xml', 'watchrss.db', 'synthetic'):
            self.assertNotIn(text, serialized)

    def test_tar_traversal_duplicates_links_special_and_truncation_refused(self):
        for path in ('../files/secret', '/files/secret', 'files//secret', 'files/../secret', 'other/secret', 'files\\secret'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                verify.stream_digest(archive([(path, b'x')]))
        with self.assertRaises(ValueError):
            verify.stream_digest(archive([('files/secret', b'x'), ('files/secret', b'x')]))
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                verify.stream_digest(archive([('files/secret', b'')], kind))
        broken = archive([('files/secret', b'x' * 4096)]).getvalue()[:600]
        with self.assertRaises(tarfile.TarError):
            verify.stream_digest(io.BytesIO(broken))

    def test_post_pass_and_all_required_roots(self):
        result = verify.compare_logs(self.before, self.logs(), pid=123)
        self.assertEqual(result['status'], 'PASS')
        for root in (*verify.ROOTS, 'manifest'):
            for phase in ('SNAPSHOTTED', 'ACTIVE'):
                lines = [line for line in self.logs() if not (f'"root": "{root}"' in line and f'"phase": "{phase}"' in line)]
                with self.subTest(root=root, phase=phase):
                    self.assertEqual(verify.compare_logs(self.before, lines)['status'], 'FAIL')

    def test_post_corruption_generation_stale_pid_ambiguity_and_conflicts(self):
        changed = copy.deepcopy(self.roots)
        changed['files']['sha256'] = 'a' * 64
        for lines in (self.logs(changed), self.logs(epoch=999), self.logs(pid=456),
                      self.logs() + self.logs(generation='g-other')):
            self.assertEqual(verify.compare_logs(self.before, lines, pid=123)['status'], 'FAIL')
        self.assertEqual(verify.compare_logs(self.before, self.logs() + self.logs(generation='g-other'), generation='g-fixture')['status'], 'PASS')
        self.assertEqual(verify.compare_logs(self.before, self.logs() + self.logs())['status'], 'PASS')
        with self.assertRaises(ValueError):
            verify.compare_logs(self.before, self.logs() + self.logs(changed))
        with self.assertRaises(ValueError):
            verify.compare_logs(self.before, ['1001 123 124 I PodTakeoverDigest: {"path":"private"}'])
        with self.assertRaises(ValueError):
            verify.compare_logs(self.before, ['PodTakeoverDigest: not-json'])

    def test_exact_platform_subset_and_legacy_cannot_claim_equal(self):
        entries = {path: (len(data), hashlib.sha256(data).hexdigest()) for path, data in fixture_rows()}
        entries['files/profileInstalled'] = (24, hashlib.sha256(b'a' * 24).hexdigest())
        entries['files/profileinstaller_profileWrittenFor_lastUpdateTime.dat'] = (8, hashlib.sha256(b'b' * 8).hexdigest())
        self.before['roots'] = verify.summarize(entries)
        entries['files/profileInstalled'] = (24, hashlib.sha256(b'c' * 24).hexdigest())
        after = verify.summarize(entries)
        result = verify.compare_logs(self.before, self.logs(after))
        self.assertEqual(result['status'], 'PASS_WITH_KNOWN_DIFFERENCES')
        self.assertFalse(result['equal'])
        self.assertTrue(result['strictRootsVerified'])
        self.assertTrue(result['nonPlatformFilesVerified'])
        legacy = copy.deepcopy(self.before)
        legacy['format'] = verify.LEGACY_FORMAT
        del legacy['roots'][verify.FILES_WITHOUT_PLATFORM_METADATA]
        result = verify.compare_logs(legacy, self.logs(after))
        self.assertEqual(result['status'], 'PARTIAL')
        self.assertFalse(result['equal'])
        self.assertFalse(result['nonPlatformFilesVerified'])
        self.assertEqual(result['reason'], 'legacy_files_subset_unavailable')
        for path in ('files/profileInstalled.user', 'files/nested/profileInstalled', 'files/private-new.bin', 'databases/new.db'):
            corrupt = dict(entries)
            corrupt[path] = (1, hashlib.sha256(b'x').hexdigest())
            self.assertEqual(verify.compare_logs(self.before, self.logs(verify.summarize(corrupt)))['status'], 'FAIL')
        for root in verify.DIGEST_ROOTS:
            for phase in ('SNAPSHOTTED', 'ACTIVE'):
                lines = [line for line in self.logs(after) if not (f'"root": "{root}"' in line and f'"phase": "{phase}"' in line)]
                self.assertEqual(verify.compare_logs(self.before, lines)['status'], 'FAIL')

    def test_non_debug_pre_refuses_before_tar_or_force_stop(self):
        with self.assertRaisesRegex(ValueError, 'Native source database'):
            verify.stream_digest(archive([('files/private.txt', b'fixture')]), require_native=True)
        with patch.object(verify, 'package_metadata', return_value={'debuggable': False}), \
             patch.object(verify, 'command', side_effect=AssertionError('No command')), \
             patch.object(verify.subprocess, 'Popen', side_effect=AssertionError('No tar')):
            with self.assertRaisesRegex(ValueError, 'DEBUGGABLE'):
                verify.pre(self.a)
        self.assertFalse(self.a.out.exists())

    def test_pre_only_json_and_no_extraction(self):
        class FakeProcess:
            def __init__(self):
                self.stdout = archive(fixture_rows())
                self.stderr = io.BytesIO(b'private raw errors not saved')
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def wait(self, **kwargs): return 0
            def kill(self): pass
        with patch.object(verify, 'package_metadata', return_value=self.before['source']), \
             patch.object(verify, 'command', return_value=''), \
             patch.object(verify.subprocess, 'Popen', return_value=FakeProcess()), \
             patch.object(tarfile.TarFile, 'extract', side_effect=AssertionError('No extraction')), \
             patch.object(tarfile.TarFile, 'extractall', side_effect=AssertionError('No extraction')):
            receipt = verify.pre(self.a)
        self.assertEqual(list(self.out.iterdir()), [self.a.out])
        self.assertEqual(receipt['roots'], self.roots)
        self.assertNotIn('cookie', self.a.out.read_text())

    def test_failed_tar_has_no_receipt(self):
        class Failed:
            stdout = archive(fixture_rows())
            stderr = io.BytesIO(b'private path')
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def wait(self, **kwargs): return 1
            def kill(self): pass
        with patch.object(verify, 'package_metadata', return_value=self.before['source']), \
             patch.object(verify, 'command', return_value=''), \
             patch.object(verify.subprocess, 'Popen', return_value=Failed()), self.assertRaises(ValueError):
            verify.pre(self.a)
        self.assertEqual(list(self.out.iterdir()), [])

    def test_post_reads_only_filtered_logs_and_writes_aggregate_report(self):
        verify.write_json(self.a.pre, self.before)
        self.a.out = self.out / 'post.json'
        commands = []
        def command(a, args):
            commands.append(args)
            return '123' if args[:2] == ['shell', 'pidof'] else '\n'.join(self.logs())
        with patch.object(verify, 'package_metadata', return_value={'uid': 10101, 'versionCode': 1000, 'debuggable': False}), \
             patch.object(verify, 'command', side_effect=command):
            self.assertEqual(verify.post(self.a)['status'], 'PASS')
        self.assertEqual(commands[1], ['logcat', '-d', '-v', 'epoch', '--pid=123', '-s', 'PodTakeoverDigest:I', '*:S'])
        self.assertEqual(len(list(self.out.iterdir())), 2)
        self.assertNotIn('private', self.a.out.read_text())

    def test_post_uid_version_target_and_missing_log_refuse(self):
        verify.write_json(self.a.pre, self.before)
        self.a.out = self.out / 'post.json'
        for i, installed in enumerate(({'uid': 9, 'versionCode': 1000}, {'uid': 10101, 'versionCode': 40})):
            self.a.out = self.out / f'failure-{i}.json'
            with patch.object(verify, 'package_metadata', return_value=installed), self.assertRaises(ValueError):
                verify.post(self.a)
        self.a.out = self.out / 'post.json'
        with patch.object(verify, 'package_metadata', return_value={'uid': 10101, 'versionCode': 1000}), \
             patch.object(verify, 'command', side_effect=['123', '']), self.assertRaises(ValueError):
            verify.post(self.a)
        self.assertEqual(json.loads(self.a.out.read_text())['status'], 'FAIL')

    def test_existing_and_dry_run_do_not_touch_device(self):
        self.a.dry_run = True
        with patch.object(verify, 'command', side_effect=AssertionError('No adb')), \
             patch.object(verify.subprocess, 'Popen', side_effect=AssertionError('No tar')):
            verify.pre(self.a)
            verify.post(self.a)
        self.assertEqual(list(self.out.iterdir()), [])
        verify.write_json(self.a.out, self.before)
        with self.assertRaises(ValueError): verify.pre(self.a)
        with self.assertRaises(ValueError): verify.post(self.a)

    def test_release_upgrade_guides_post_and_never_after_run_as(self):
        self.a.out = self.out
        self.a.adb = ['adb', '-s', 'offline']
        self.a.apk = self.out / 'release.apk'
        replies = [self.a.package, 'false', 'Success']
        with patch.object(acceptance, 'run', side_effect=replies) as run, \
             patch.object(acceptance, 'installed_metadata', return_value={'debuggable': False, 'versionCode': 1000}), \
             patch.object(verify, 'pre', return_value=self.before) as pre, \
             patch.object(acceptance, 'snapshot', side_effect=AssertionError('No old run-as digest')):
            acceptance.upgrade(self.a)
        pre.assert_called_once()
        self.assertEqual(run.call_args_list[-1].args[0][3:5], ['install', '-r'])
        result = json.loads((self.out / 'takeover-install.json').read_text())
        self.assertEqual(result['status'], 'PENDING')
        self.assertFalse(result['preservationVerified'])
        self.assertFalse((self.out / 'after-digest.json').exists())

    def test_failed_release_pre_never_installs(self):
        self.a.out = self.out
        self.a.adb = ['adb', '-s', 'offline']
        self.a.apk = self.out / 'release.apk'
        with patch.object(acceptance, 'run', side_effect=[self.a.package, 'false']) as run, \
             patch.object(verify, 'pre', side_effect=ValueError('source unavailable')), self.assertRaises(ValueError):
            acceptance.upgrade(self.a)
        self.assertEqual(run.call_count, 2)


if __name__ == '__main__':
    unittest.main()
