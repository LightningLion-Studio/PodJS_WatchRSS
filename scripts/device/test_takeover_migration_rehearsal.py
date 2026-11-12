import unittest
from types import SimpleNamespace
from unittest.mock import patch
import takeover_migration_rehearsal as rehearsal


class EmulatorSafetyTest(unittest.TestCase):
    def test_physical_serial_is_rejected_before_adb(self):
        with patch.object(rehearsal, 'command') as command:
            with self.assertRaisesRegex(ValueError, 'emulator_required'):
                rehearsal.checked_emulator('e3aca8af')
            command.assert_not_called()

    def test_emulator_name_alone_is_insufficient(self):
        with patch.object(rehearsal, 'command', return_value=b'0\n'):
            with self.assertRaisesRegex(ValueError, 'emulator_required'):
                rehearsal.checked_emulator('emulator-5580')

    def test_qemu_gate_accepts_only_verified_emulator(self):
        with patch.object(rehearsal, 'command', return_value=b'1\n'):
            self.assertEqual(['adb', '-s', 'emulator-5580'], rehearsal.checked_emulator('emulator-5580'))

    def test_halted_migration_returns_error_instead_of_waiting_forever(self):
        with patch.object(rehearsal, 'read', side_effect=[{'phase': 'PAUSED', 'reason': 'migration_timeout'}, {}]):
            with self.assertRaisesRegex(ValueError, 'migration_halted_migration_timeout'):
                rehearsal.wait([], lambda p: p.get('phase') == 'ACTIVE')

    def test_optional_instrument_arguments_are_omitted_instead_of_shell_empty_values(self):
        with patch.object(rehearsal.subprocess, 'Popen') as popen:
            rehearsal.instrument(['adb', '-s', 'emulator-5580'], 'migrate', None, 'COPYING')
            args = popen.call_args.args[0]
            self.assertNotIn('', args)
            self.assertNotIn('stopWork', args)
            self.assertIn('keepAlive', args)
            self.assertEqual(rehearsal.RUNNER, args[-1])

    def test_post_active_probe_finishes_normally(self):
        with patch.object(rehearsal.subprocess, 'Popen') as popen:
            rehearsal.instrument(['adb'], 'verifyPostActiveEdit', None)
            self.assertNotIn('keepAlive', popen.call_args.args[0])

    def test_guest_settle_wait_is_bounded(self):
        with patch.object(rehearsal, 'checked_emulator', return_value=[]):
            for seconds in (-1, 31):
                with self.subTest(seconds=seconds), self.assertRaisesRegex(ValueError, 'settle_duration_invalid'):
                    rehearsal.run(SimpleNamespace(serial='emulator-5580', settle_seconds=seconds))


if __name__ == '__main__':
    unittest.main()
