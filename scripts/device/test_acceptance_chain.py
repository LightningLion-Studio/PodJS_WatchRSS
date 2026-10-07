"""Host-only acceptance tests: every adb/tool invocation is mocked."""
import copy
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import acceptance

CERT = 'f' * 64
DIGEST = {'files': {'files/content': 'hash'}, 'tables': {}, 'integrity': 'ok'}


class UpgradeChainTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.apks = [self.root / f'v{n}.apk' for n in (2, 3, 4)]
        for path in self.apks:
            path.write_bytes(b'test apk')
        self.a = SimpleNamespace(out=self.root, package=acceptance.FORMAL, serial='mock-device',
                                 adb=['adb', '-s', 'mock-device'], dry_run=False,
                                 apk=[self.apks[0]], verify_apk=self.apks[1])
        self.commands = []
        self.installs = []
        self.version = 1
        self.debuggable = True
        self.cert = CERT
        self.fail_install = None
        self.mismatch_version = False
        self.verify_debuggable = True
        self.initial_debuggable = True
        self.package = acceptance.FORMAL
        self.version_overrides = {}
        self.digest_labels = []
        self.after = copy.deepcopy(DIGEST)
        self.before_error = False
        self.run_patch = patch.object(acceptance, 'run', side_effect=self.mock_run)
        self.run_patch.start()
        self.addCleanup(self.run_patch.stop)
        self.snapshot_patch = patch.object(acceptance, 'snapshot', side_effect=self.snapshot)
        self.snapshot_patch.start()
        self.addCleanup(self.snapshot_patch.stop)
        self.tools_patch = patch.object(acceptance, 'android_tool', side_effect=lambda x: x)
        self.tools_patch.start()
        self.addCleanup(self.tools_patch.stop)

    def snapshot(self, a, label):
        self.digest_labels.append(label)
        if label == 'before' and self.before_error:
            raise ValueError('run-as denied')
        receipt = copy.deepcopy(DIGEST if label == 'before' else self.after)
        (a.out / (label + '-digest.json')).write_text(json.dumps(receipt))
        return receipt

    def mock_run(self, cmd, dry=False, output=None, cwd=None):
        self.commands.append(cmd)
        if dry:
            return ''
        if cmd[0] == 'apkanalyzer':
            version = int(Path(cmd[-1]).stem[1:])
            return {'application-id': self.package,
                    'version-code': str(self.version_overrides.get(version, version)),
                    'debuggable': str(version == 3 and self.verify_debuggable).lower()}[cmd[2]] + '\n'
        if cmd[0] == 'apksigner':
            cert = self.cert if Path(cmd[-1]).name == 'base.apk' else CERT
            return 'Signer #1 certificate SHA-256 digest: ' + cert + '\n'
        action = cmd[3:]
        if action[:3] == ['shell', 'am', 'force-stop']:
            return ''
        if action == ['shell', 'getprop', 'ro.build.version.sdk']:
            return '30\n'
        if action[:3] == ['shell', 'dumpsys', 'package']:
            version = 99 if self.mismatch_version and self.installs else self.version
            debug = self.initial_debuggable if not self.installs else self.debuggable
            return f'  versionCode={version} minSdk=30\n  pkgFlags=[ HAS_CODE {"DEBUGGABLE" if debug else ""} ]\n'
        if action[:2] == ['install', '-r']:
            self.installs.append(Path(action[2]))
            if len(self.installs) == self.fail_install:
                return 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]\n'
            self.version = int(Path(action[2]).stem[1:])
            self.debuggable = self.version == 3
            return 'Success\n'
        if action[:3] == ['shell', 'pm', 'path']:
            return 'package:/data/app/mock/base.apk\n'
        if action[0] == 'pull':
            Path(action[-1]).write_bytes(b'installed apk')
            return '1 file pulled\n'
        raise AssertionError('Unexpected command: ' + repr(cmd))

    def assert_no_destructive_or_launch(self):
        for cmd in self.commands:
            self.assertNotIn('uninstall', cmd)
            self.assertNotIn('clear', cmd)
            self.assertNotIn('start', cmd)
            self.assertNotIn('monkey', cmd)
            self.assertNotIn('-d', cmd)

    def test_success_same_receipt_json_and_order(self):
        acceptance.upgrade_chain(self.a)
        self.assertEqual(self.installs, self.apks[:2])
        self.assertEqual(self.digest_labels, ['before', 'after'])
        self.assertEqual(json.loads((self.root / 'data-compare.json').read_text()),
                         acceptance.compare_receipts(DIGEST, DIGEST))
        log = json.loads((self.root / 'chain-install.json').read_text())
        self.assertTrue(log['complete'])
        self.assertTrue(all(s['verified'] for s in log['steps']))
        self.assertEqual([s['actual']['versionCode'] for s in log['steps']], [2, 3])
        self.assert_no_destructive_or_launch()

    def test_multiple_apks_preserve_order(self):
        # Three-step chain with the debuggable verification APK last.
        fourth = self.root / 'v5.apk'
        fourth.write_bytes(b'test')
        self.a.apk = [self.apks[0], self.apks[2]]
        self.a.verify_apk = fourth
        original = self.mock_run
        def custom(cmd, *args, **kwargs):
            text = original(cmd, *args, **kwargs)
            if cmd[0] == 'apkanalyzer' and cmd[2] == 'debuggable' and cmd[-1] == str(fourth):
                return 'true\n'
            if cmd[3:5] == ['install', '-r'] and cmd[-1] == str(fourth):
                self.debuggable = True
            return text
        with patch.object(acceptance, 'run', side_effect=custom):
            acceptance.upgrade_chain(self.a)
        self.assertEqual(self.installs, [self.apks[0], self.apks[2], fourth])
        self.assert_no_destructive_or_launch()

    def test_current_release_refuses_without_install(self):
        self.initial_debuggable = False
        with self.assertRaisesRegex(ValueError, 'Current package'):
            acceptance.upgrade_chain(self.a)
        self.assertEqual(self.installs, [])

    def test_run_as_failure_prevents_install(self):
        self.before_error = True
        with self.assertRaisesRegex(ValueError, 'run-as denied'):
            acceptance.upgrade_chain(self.a)
        self.assertEqual(self.installs, [])

    def test_bad_verify_or_package_or_version_prevents_install(self):
        for field, value in [('verify_debuggable', False), ('package', 'other.package'),
                             ('version_overrides', {3: 2})]:
            with self.subTest(field=field):
                original = getattr(self, field)
                setattr(self, field, value)
                with self.assertRaises(ValueError):
                    acceptance.upgrade_chain(self.a)
                self.assertEqual(self.installs, [])
                setattr(self, field, original)

    def test_refusal_stops_immediately_without_uninstall(self):
        for step in (1, 2):
            with self.subTest(step=step), tempfile.TemporaryDirectory() as out:
                self.a.out = Path(out)
                self.installs = []
                self.version = 1
                self.fail_install = step
                with self.assertRaisesRegex(ValueError, 'rejected'):
                    acceptance.upgrade_chain(self.a)
                self.assertEqual(len(self.installs), step)
                self.assertFalse((self.a.out / 'after-digest.json').exists())
                self.assertFalse((self.a.out / 'data-compare.json').exists())
                self.assert_no_destructive_or_launch()

    def test_subprocess_failure_stops_immediately(self):
        original = self.mock_run
        def fail(cmd, *args, **kwargs):
            if cmd[3:5] == ['install', '-r']:
                raise subprocess.CalledProcessError(1, cmd)
            return original(cmd, *args, **kwargs)
        with patch.object(acceptance, 'run', side_effect=fail), self.assertRaises(subprocess.CalledProcessError):
            acceptance.upgrade_chain(self.a)
        self.assertEqual(self.digest_labels, ['before'])
        self.assertFalse(json.loads((self.root / 'chain-install.json').read_text())['complete'])

    def test_version_or_certificate_readback_mismatch_stops_chain(self):
        for field, value in [('mismatch_version', True), ('cert', 'a' * 64)]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as out:
                self.a.out = Path(out)
                self.installs = []
                self.version = 1
                original = getattr(self, field)
                setattr(self, field, value)
                with self.assertRaisesRegex(ValueError, 'mismatch'):
                    acceptance.upgrade_chain(self.a)
                self.assertEqual(len(self.installs), 1)
                self.assert_no_destructive_or_launch()
                setattr(self, field, original)

    def test_data_difference_is_failure_with_receipt(self):
        self.after['files']['files/content'] = 'changed'
        with self.assertRaisesRegex(ValueError, 'Data changed'):
            acceptance.upgrade_chain(self.a)
        self.assertFalse(json.loads((self.root / 'data-compare.json').read_text())['equal'])

    def test_existing_receipt_refused(self):
        (self.root / 'before-digest.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'fresh'):
            acceptance.upgrade_chain(self.a)
        self.assertEqual(self.commands, [])

    def test_missing_or_duplicate_apk_refuses_before_device_commands(self):
        for verify in (self.root / 'missing.apk', self.apks[0]):
            with self.subTest(verify=verify):
                self.a.verify_apk = verify
                with self.assertRaises(ValueError):
                    acceptance.upgrade_chain(self.a)
                self.assertEqual(self.commands, [])

    def test_missing_certificate_refuses_before_install(self):
        original = self.mock_run
        def missing(cmd, *args, **kwargs):
            if cmd[0] == 'apksigner':
                return ''
            return original(cmd, *args, **kwargs)
        with patch.object(acceptance, 'run', side_effect=missing), self.assertRaisesRegex(ValueError, 'No verified'):
            acceptance.upgrade_chain(self.a)
        self.assertEqual(self.installs, [])

    def test_apk_tamper_after_snapshot_prevents_install(self):
        original = self.snapshot
        def tamper(a, label):
            receipt = original(a, label)
            if label == 'before':
                self.apks[0].write_bytes(b'replaced after preflight')
            return receipt
        with patch.object(acceptance, 'snapshot', side_effect=tamper), self.assertRaisesRegex(ValueError, 'changed after preflight'):
            acceptance.upgrade_chain(self.a)
        self.assertEqual(self.installs, [])


    def test_dry_run_no_subprocess_or_receipts(self):
        self.a.dry_run = True
        self.snapshot_patch.stop()
        with patch.object(acceptance.subprocess, 'run', side_effect=AssertionError('No device I/O')):
            acceptance.upgrade_chain(self.a)
        self.assertEqual(self.installs, [])
        self.assertFalse((self.root / 'data-compare.json').exists())
        self.assert_no_destructive_or_launch()


    def test_real_cli_dry_run_supports_repeated_chain_apks(self):
        # Use the production parser/dispatch without tools or device access.
        with patch.object(acceptance.sys, 'argv', ['acceptance.py', 'upgrade-chain', '--dry-run',
                '--apk', '/offline/v2.apk', '--apk', '/offline/v4.apk',
                '--verify-apk', '/offline/v5.apk', '--out', str(self.root)]), \
             patch.object(acceptance.subprocess, 'run', side_effect=AssertionError('No I/O')):
            acceptance.main()
        install_cmds = [cmd for cmd in self.commands if cmd[3:5] == ['install', '-r']]
        self.assertEqual([cmd[-1] for cmd in install_cmds], ['/offline/v2.apk', '/offline/v4.apk', '/offline/v5.apk'])
        self.assert_no_destructive_or_launch()

    def test_real_cli_ordinary_upgrade_keeps_single_apk(self):
        with patch.object(acceptance.sys, 'argv', ['acceptance.py', 'upgrade', '--dry-run',
                '--apk', '/offline/v2.apk', '--out', str(self.root)]):
            acceptance.main()
        installs = [cmd for cmd in self.commands if cmd[3:5] == ['install', '-r']]
        self.assertEqual(installs[0][-1], '/offline/v2.apk')
        self.assert_no_destructive_or_launch()

    def test_missing_verification_apk_rejected_by_cli(self):
        with patch.object(acceptance.sys, 'argv', ['acceptance.py', 'upgrade-chain', '--dry-run',
                '--apk', '/offline/v2.apk']), self.assertRaises(SystemExit):
            acceptance.main()
        self.assertEqual(self.commands, [])


if __name__ == '__main__':
    unittest.main()
