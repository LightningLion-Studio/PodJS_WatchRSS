import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('credentials_cli', Path(__file__).with_name('credentials.py'))
credentials = importlib.util.module_from_spec(spec)
spec.loader.exec_module(credentials)

class CredentialsTest(unittest.TestCase):
    def raw(self):
        return json.dumps({'version': 1, 'values': dict(zip(credentials.KEYS, ['private-bili', 'private-douyin', None]))}).encode()

    def test_private_file_roundtrip_and_redacted_output(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(Path, 'home', return_value=Path(directory)):
            output, errors = io.StringIO(), io.StringIO()
            with patch.object(credentials, 'exchange', return_value=self.raw()) as exchange, contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                self.assertEqual(credentials.main(['export', '--package', 'dev.tests.rehearsal']), 0)
                path = credentials.backup_path('dev.tests.rehearsal')
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
                self.assertEqual(credentials.load(path), self.raw())
                self.assertEqual(list(path.parent.iterdir()), [path])
                exchange.return_value = b'ok'
                self.assertEqual(credentials.main(['import', '--package', 'dev.tests.rehearsal']), 0)
                self.assertEqual(exchange.call_args.args[2], self.raw())
            for value in ('private-bili', 'private-douyin'):
                self.assertNotIn(value, output.getvalue() + errors.getvalue())

    def test_invalid_json_version_size_and_file_permissions(self):
        for raw in (b'{private-value', b'{}', b'{"version":2,"values":{}}', b' ' * 12001):
            with self.assertRaises(credentials.CredentialError):
                credentials.validate(raw)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bad.json'
            path.write_bytes(self.raw())
            path.chmod(0o644)
            with self.assertRaises(credentials.CredentialError):
                credentials.load(path)
            path.unlink()
            path.symlink_to('/dev/null')
            with self.assertRaises(OSError):
                credentials.load(path)

    def test_release_refusal_has_no_action_and_errors_hide_adb_output(self):
        failure = type('Result', (), {'returncode': 1, 'stdout': 'private-value', 'stderr': 'private-value'})()
        with patch.object(credentials.subprocess, 'run', return_value=failure) as run:
            with self.assertRaisesRegex(credentials.CredentialError, '^ADB request rejected$'):
                credentials.exchange('dev.tests.rehearsal', 'export')
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0][:3], ['adb', '-s', 'e3aca8af'])
            self.assertEqual(shlex.split(run.call_args.args[0][4]), ['run-as', 'dev.tests.rehearsal', 'true'])

    def test_transport_quotes_payload_and_uses_no_device_files(self):
        commands = []
        def request(*args, **kwargs):
            commands.append(args[0])
            return type('Result', (), {'returncode': 0, 'stdout': 'Broadcast completed: result=0, data="ok"\n', 'stderr': ''})()
        with patch.object(credentials.subprocess, 'run', side_effect=request):
            self.assertEqual(credentials.exchange('dev.tests.rehearsal', 'import', self.raw()), b'ok')
        self.assertEqual(len(commands), 3)
        self.assertTrue(all(command[:3] == ['adb', '-s', 'e3aca8af'] for command in commands))
        broadcast = shlex.split(commands[-1][-1])
        self.assertIn('snapshot_base64', broadcast)
        self.assertNotIn('private-bili', ' '.join(broadcast))
        self.assertFalse(any('push' in command or '/data/local/tmp' in ' '.join(command) for command in commands))

if __name__ == '__main__':
    unittest.main()
